/**
 * The autonomy loop's decision rules (ADR-0013).
 *
 * An agent CLI stops at the end of every turn and waits for a human. For the
 * company to run unattended, a finished agent must pick up new work and
 * continue — *without* the harness re-prompting it blindly, and without ever
 * spinning forever.
 *
 * The guards are the package, not an afterthought (R2: "Stop-hook loop
 * pathology burns budget overnight"). All three of ADR-0013's mandatory guards
 * are decided here, as one pure function, so the ordering between them is
 * visible and testable rather than scattered through the wiring:
 *
 *   1. `stop_hook_active` — never re-block a turn the hook itself continued.
 *   2. a hard per-session block cap — the backstop for when guard 1 is not
 *      enough, or an engine does not report the flag at all.
 *   3. nothing pending — the ordinary end of a turn.
 *
 * No prose lives here. The block *reason* an agent actually reads is a prompt
 * surface (ADR-0013: "subject to the same review as system prompts"), so it is
 * rendered by the caller from a template in `prompts/` — this function returns
 * only the facts (invariant §8).
 */

/**
 * Hard cap on how many times one session may be continued by its Stop hook.
 * Overridable per spawn; ADR-0013 requires it to exist, not to have a
 * particular value. Twenty is generous for a real chain of delegated work and
 * still bounds an overnight pathology to a knowable cost.
 */
export const DEFAULT_BLOCK_CAP = 20

/** Environment variable holding the ADR-0013 "env-configurable" block cap. */
export const BLOCK_CAP_ENV = 'EPH_BLOCK_CAP'

/**
 * ADR-0013 makes the cap env-configurable. A positive integer wins; anything
 * else (unset, empty, junk, zero, negative) is refused so the cap can never be
 * accidentally disabled — the caller falls back to `DEFAULT_BLOCK_CAP` and may
 * surface the refusal.
 */
export function blockCapFromEnv(
  env: Readonly<Record<string, string | undefined>>
): { cap: number } | { cap: undefined; invalid?: string } {
  const raw = env[BLOCK_CAP_ENV]
  if (raw === undefined || raw === '') return { cap: undefined }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) return { cap: undefined, invalid: raw }
  return { cap: parsed }
}

/**
 * Blocks-in-a-session at which the loop looks pathological and the breaker
 * should hear about it. Deliberately *below* the cap: the point is to signal
 * before the backstop fires, so rung 1 can steer rather than the cap stopping
 * the work outright (ADR-0011, wired in M3).
 */
export const PATHOLOGY_SIGNAL_AT = 10

export interface StopContext {
  /** The engine says this turn was itself continued by the Stop hook. */
  readonly stopHookActive: boolean
  /** How many times this session has already been continued. */
  readonly blocksThisSession: number
  readonly blockCap?: number
  /** Unread messages in the agent's inbox. */
  readonly pendingMail: number
  /** Tasks assigned to this agent that are not finished. */
  readonly pendingTasks: number
}

export type StopDecision =
  | {
      readonly kind: 'continue'
      /** Machine tag, not prose — why the turn was allowed to end. */
      readonly because: 'stop-hook-active' | 'block-cap-reached' | 'nothing-pending'
    }
  | { readonly kind: 'block'; readonly pendingMail: number; readonly pendingTasks: number }

/**
 * Contract: pure and total. Decides whether a finished turn should continue.
 *
 * Guard order matters and is the reason this is one function: `stop_hook_active`
 * is checked *first* so a hook can never chain off its own continuation, and the
 * cap is checked *before* pending work so a pathological loop stops even while
 * mail keeps arriving. Reversing either would make the guards decorative.
 */
export function decideStop(ctx: StopContext): StopDecision {
  if (ctx.stopHookActive) return { kind: 'continue', because: 'stop-hook-active' }

  const cap = ctx.blockCap ?? DEFAULT_BLOCK_CAP
  if (ctx.blocksThisSession >= cap) return { kind: 'continue', because: 'block-cap-reached' }

  if (ctx.pendingMail > 0 || ctx.pendingTasks > 0) {
    return { kind: 'block', pendingMail: ctx.pendingMail, pendingTasks: ctx.pendingTasks }
  }

  return { kind: 'continue', because: 'nothing-pending' }
}

/**
 * Contract: true once a session's block count reaches the signalling threshold.
 * The breaker (ADR-0011, M3) consumes this; M2 only reports it, because a
 * signal nobody is listening to yet is still better than a loop nobody can see.
 */
export function isPathological(blocksThisSession: number): boolean {
  return blocksThisSession >= PATHOLOGY_SIGNAL_AT
}
