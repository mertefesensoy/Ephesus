import type { AvatarSnapshot } from '../shared/avatar'
import { decideCommand, type CommandState } from '../shared/commands'

/**
 * The command queue (FR-1.3, UC-03). The Architect's text is held here, in
 * main, until the agent can take it — the renderer only renders what this
 * object is holding, so "queue-until-idle" is one decision in one place rather
 * than a race between a text box and a PTY.
 */

/**
 * A submitted line reaches a PTY as TWO writes: the text, then the submit key.
 *
 * This is not cosmetic. Once a coding CLI's TUI has booted it turns on
 * bracketed paste (`ESC[?2004h`), and a single write ending in CR is taken as a
 * *paste* rather than a submitted line — the agent silently holds the text and
 * never runs it. Measured live against a real `claude`: early sends (before the
 * TUI finished booting) submitted, later ones did not, until the submit key was
 * separated from the text.
 */
export const SUBMIT_KEY = '\r'

/** Gap between the text write and the submit key. Measured, not guessed. */
export const SUBMIT_KEY_DELAY_MS = 150

/**
 * How long the engine gets to confirm a submit before the key is sent again.
 *
 * The submit key used to be fire-and-forget, and a TUI that did not act on it
 * left the text sitting in the prompt box with the harness believing it had
 * spoken. Observed on 2026-09-06: an agent woken one second after spawn took
 * the nudge into its prompt, never submitted it, and sat idle with two tasks
 * assigned — its transcript held four setup lines and no user message at all.
 * The startup notices ("keep working from anywhere", auto-mode, `/rc
 * connecting…`) were still painting, and one of them took the key.
 *
 * That is the same shape as the trust dialog that answered a wake with "No,
 * exit" (2026-09-05): something in front of the prompt consumes the keystroke.
 * Enumerating what can be in front of the prompt is a losing game — the engine
 * adds notices between releases. Confirming the outcome is not.
 */
export const SUBMIT_CONFIRM_MS = 2_000

/**
 * How many submit keys one send may cost, the first included.
 *
 * Bounded because an unconfirmed submit must end in a report rather than in a
 * key pressed forever. A resent key that was not needed lands on an empty
 * prompt and does nothing, so the cost of over-trying is nil and the cost of
 * under-trying is a silent agent.
 */
export const SUBMIT_ATTEMPTS = 4

/** The slice of the PTY layer the queue needs. */
export interface CommandSink {
  write(agentId: string, data: string): void
}

export interface CommandQueueOptions {
  readonly sink: CommandSink
  /** Called whenever an agent's held text changes, for `state:commands`. */
  onChange(state: CommandState): void
  /** Injected in tests so the two-write submit is deterministic. */
  schedule?: (fn: () => void, ms: number) => void
  /**
   * Every submit key was spent and the engine never reported the prompt.
   *
   * The text is in the agent's prompt box and nothing is going to run it. This
   * is the one outcome that used to be indistinguishable from success, so it is
   * reported rather than counted (invariant §7).
   */
  onUnaccepted?(agentId: string, attempts: number): void
}

export class CommandQueue {
  private readonly held = new Map<string, { text: string; reason: string }>()
  private readonly phases = new Map<string, AvatarSnapshot['phase']>()
  /**
   * Agents whose last send has not been confirmed: which send it was, and the
   * keys it has cost.
   *
   * The generation is what makes a second send SUPERSEDE the first rather than
   * race it. Without it two chains press at once against one shared counter,
   * which spends the budget at double speed and reports a number belonging to
   * neither send.
   */
  private readonly awaiting = new Map<string, { gen: number; attempts: number }>()
  private generation = 0
  private readonly schedule: (fn: () => void, ms: number) => void

  constructor(private readonly options: CommandQueueOptions) {
    this.schedule =
      options.schedule ??
      ((fn, ms): void => {
        setTimeout(fn, ms).unref?.()
      })
  }

  /** Keeps the queue's view of each agent's phase current, and flushes on idle. */
  observe(agentId: string, snapshot: AvatarSnapshot): void {
    this.phases.set(agentId, snapshot.phase)
    if (decideCommand(snapshot.phase).kind === 'send') this.flush(agentId)
  }

  forget(agentId: string): void {
    this.phases.delete(agentId)
    // The process is gone, so there is nothing left to press a key at and
    // nothing to report: a dead agent did not decline its wake.
    this.awaiting.delete(agentId)
    if (this.held.delete(agentId)) {
      this.options.onChange({ agentId, held: null, reason: null })
    }
  }

  state(agentId: string): CommandState {
    const entry = this.held.get(agentId)
    return {
      agentId,
      held: entry?.text ?? null,
      reason: entry?.reason ?? null
    }
  }

  list(): readonly CommandState[] {
    return [...this.held.keys()].map((agentId) => this.state(agentId))
  }

  /**
   * Contract: sends the text now when the agent is idle, holds it when the
   * agent is mid-turn, and refuses when there is no process to type into.
   * Held text *accumulates* rather than replacing — the Architect typing twice
   * while an agent works meant to say both things.
   */
  submit(agentId: string, text: string): CommandState {
    const decision = decideCommand(this.phases.get(agentId) ?? null)

    if (decision.kind === 'refuse') {
      throw new Error(`commands: cannot send to "${agentId}" — ${decision.reason}`)
    }

    if (decision.kind === 'send' && !this.held.has(agentId)) {
      this.send(agentId, text)
      return this.state(agentId)
    }

    const existing = this.held.get(agentId)
    const merged = existing ? `${existing.text}\n${text}` : text
    const reason = decision.kind === 'hold' ? decision.reason : 'flushing'
    this.held.set(agentId, { text: merged, reason })
    const state = this.state(agentId)
    this.options.onChange(state)
    // A newly-idle agent with text already queued flushes on the next observe;
    // this covers the case where it is idle right now.
    if (decision.kind === 'send') this.flush(agentId)
    return state
  }

  /**
   * Delivers the harness's own wake nudge, WITHOUT consulting the avatar phase.
   *
   * `submit` asks the floor whether the agent looks ready, and for the
   * Architect's text that is right: their words are a conversation, holding
   * them is a kindness, and the held text is shown back to them (FR-1.3).
   *
   * A wake is not a conversation. By the time this is called the router has
   * already decided on the DELIVERY plane that the agent is between turns —
   * a live pty and no open wake — and it has already taken the mail out of the
   * inbox to carry it. There is no second opinion the floor could offer that
   * would be worth losing a message for, and it had two ways to lose one: a
   * phase that never returned to `idle` held the nudge forever while the mail
   * sat archived, and a `ghost`/`stopped`/`archived` phase made `submit` throw,
   * which unwound the whole sweep and skipped every agent after it.
   *
   * Held text is deliberately left alone rather than flushed alongside: the
   * Architect's queued words are still theirs to send when the agent is ready,
   * and stapling them to a wake nudge would put words in the harness's mouth.
   */
  wake(agentId: string, text: string): void {
    this.send(agentId, text)
  }

  /**
   * Interrupt clears the queue: the Architect stopping the agent did not mean
   * "and then say this anyway" (FR-1.3). The cancel key itself is written by
   * the caller, from the adapter's `KeySequence`.
   */
  clear(agentId: string): void {
    if (!this.held.delete(agentId)) return
    this.options.onChange({ agentId, held: null, reason: null })
  }

  private flush(agentId: string): void {
    const entry = this.held.get(agentId)
    if (!entry) return
    this.held.delete(agentId)
    this.options.onChange({ agentId, held: null, reason: null })
    this.send(agentId, entry.text)
  }

  /**
   * The engine reported `prompt-submitted` for this agent: whatever was in the
   * prompt box is now a turn, so nothing is owed.
   *
   * Contract: idempotent, and safe for an agent this queue never wrote to — an
   * agent submits prompts of its own accord and every one of them arrives here.
   */
  accepted(agentId: string): void {
    this.awaiting.delete(agentId)
  }

  private send(agentId: string, text: string): void {
    this.options.sink.write(agentId, text)
    const gen = ++this.generation
    this.awaiting.set(agentId, { gen, attempts: 0 })
    this.schedule(() => this.pressSubmit(agentId, gen), SUBMIT_KEY_DELAY_MS)
  }

  /**
   * One submit key, and a check that it did something.
   *
   * The check is the point. A key written into a TUI that is painting a startup
   * notice is consumed by the notice, and the only difference between that and
   * a submitted prompt — from the harness's side — is an event that does not
   * arrive. Re-pressing costs an empty prompt at worst.
   */
  private pressSubmit(agentId: string, gen: number): void {
    const pending = this.awaiting.get(agentId)
    // `accepted`, `forget`, or a newer send landed between the schedule and
    // here. The first two mean the prompt is already a turn and a key now would
    // be typing into somebody's answer; the third means this chain is stale.
    if (pending === undefined || pending.gen !== gen) return
    const spent = pending.attempts + 1
    this.awaiting.set(agentId, { gen, attempts: spent })
    this.options.sink.write(agentId, SUBMIT_KEY)
    if (spent >= SUBMIT_ATTEMPTS) {
      this.schedule(() => this.giveUp(agentId, gen, spent), SUBMIT_CONFIRM_MS)
      return
    }
    this.schedule(() => this.pressSubmit(agentId, gen), SUBMIT_CONFIRM_MS)
  }

  private giveUp(agentId: string, gen: number, attempts: number): void {
    const pending = this.awaiting.get(agentId)
    if (pending === undefined || pending.gen !== gen) return
    this.awaiting.delete(agentId)
    this.options.onUnaccepted?.(agentId, attempts)
  }
}
