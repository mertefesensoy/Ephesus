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
}

export class CommandQueue {
  private readonly held = new Map<string, { text: string; reason: string }>()
  private readonly phases = new Map<string, AvatarSnapshot['phase']>()
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

  private send(agentId: string, text: string): void {
    this.options.sink.write(agentId, text)
    this.schedule(() => this.options.sink.write(agentId, SUBMIT_KEY), SUBMIT_KEY_DELAY_MS)
  }
}
