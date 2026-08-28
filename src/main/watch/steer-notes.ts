import type { HookReply } from '../hooks'

/**
 * Rung-1 steer delivery over the hook boundary (GYM-002, ADR-0011).
 *
 * The breaker's whole rung-1 bargain is "one corrective sentence, immediately".
 * Delivered through the command queue, that sentence is HELD while the agent is
 * mid-turn (`decideCommand` holds `thinking`/`working` text) — which is exactly
 * when a runaway loop needs it. RB-001 (the Stoa's munder-difflin study) showed
 * the upstream pattern: control decisions ride the engine's own hook-return
 * protocol, so they land race-free at the next hook boundary, mid-turn.
 *
 * This class is that channel, as shipped wiring both `index.ts` and the
 * scenario rig construct (the M5.1 rule: scenarios exercise shipped wiring,
 * never a copy). It implements `BreakerEffects.steer` and chooses per agent:
 *
 *  - `native` hook grade → the sentence is held as a pending note and returned
 *    on the agent's next `post-tool` hook reply as `{decision:'block', reason}`.
 *    The shim relays decisions verbatim for every event, and the engine's
 *    documented post-tool semantics for `block` are "prompt the model with the
 *    reason" — a steer, at the very boundary that tripped it.
 *  - anything below `native` → the command-queue path stays (the same
 *    reduced-protection scaling ADR-0011 applies everywhere else), and the
 *    sentence arrives when the agent next goes idle.
 *
 * Rules: one pending note per agent, latest wins (rung 1 fires once per trip;
 * a second trip's sentence must not queue behind a stale one); delivered
 * exactly once; a `session-start` clears any stale note, because a note aimed
 * at a dead session must not steer its successor.
 */

export interface SteerNotesOptions {
  /** The agent's declared hook grade — `native` gets the hook channel. */
  hookFidelity(agentId: string): string
  /** The fallback channel: FR-1.3 queue-until-idle, today's behavior. */
  queueSubmit(agentId: string, text: string): void
  /**
   * Every steer, with the channel it took — the visible record (invariant §7):
   * `index.ts` writes it to `log.jsonl`, the scenario rig to its act list.
   */
  onSteer?(agentId: string, text: string, channel: 'hook' | 'queue'): void
}

export class SteerNotes {
  /** agentId → the one pending corrective sentence. */
  private readonly notes = new Map<string, string>()

  constructor(private readonly options: SteerNotesOptions) {}

  /** `BreakerEffects.steer` — chooses the delivery channel by hook grade. */
  steer(agentId: string, text: string): void {
    if (this.options.hookFidelity(agentId) === 'native') {
      this.notes.set(agentId, text)
      this.options.onSteer?.(agentId, text, 'hook')
      return
    }
    this.options.queueSubmit(agentId, text)
    this.options.onSteer?.(agentId, text, 'queue')
  }

  /**
   * The hook-boundary half: called for every accepted hook event, returns the
   * reply the harness should send, or null to say nothing. Only `post-tool`
   * carries a note (a `block` there steers; on other events it would deny a
   * tool or erase a prompt), and a note is consumed by being returned.
   */
  answer(agentId: string, event: string): HookReply | null {
    if (event === 'session-start') {
      // A fresh session must not inherit a sentence aimed at the dead one.
      this.notes.delete(agentId)
      return null
    }
    if (event !== 'post-tool') return null
    const text = this.notes.get(agentId)
    if (text === undefined) return null
    this.notes.delete(agentId)
    return { decision: 'block', reason: text }
  }

  /** True while a note waits for its boundary — for tests and the card. */
  pending(agentId: string): boolean {
    return this.notes.has(agentId)
  }
}
