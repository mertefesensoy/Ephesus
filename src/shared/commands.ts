import { z } from 'zod'
import type { AvatarPhase } from './avatar'
import { agentIdSchema } from './agents'

/**
 * Command-bar semantics (FR-1.3, UC-03). The Architect types free prompts at
 * the selected agent; if the agent is mid-turn the text is *held* and flushed
 * when it goes idle, rather than being pasted into the middle of a tool call.
 *
 * The decision lives here, in shared pure logic, and is *made* in main
 * (`src/main/commands.ts`) — the renderer only shows what main is holding.
 * A renderer that decided this for itself would be holding authoritative state
 * (ENGINEERING-STANDARDS §4).
 */

/** What the harness will do with submitted text, given the agent's phase. */
export type CommandDecision =
  | { readonly kind: 'send' }
  /** Held until the agent is idle. UI-DESIGN §2.4 `status-typing`. */
  | { readonly kind: 'hold'; readonly reason: string }
  /** No process to type into. */
  | { readonly kind: 'refuse'; readonly reason: string }

/**
 * Phases in which the agent has finished its turn and can take new input.
 * `success` is included because it is a 250 ms flash on the way to `idle`
 * (SDD §6) — holding text through it would add a visible stutter for nothing.
 */
const READY: readonly AvatarPhase[] = ['idle', 'success']

/** Phases where no process exists to receive anything. */
const DEAD: readonly AvatarPhase[] = ['ghost', 'stopped', 'archived']

/**
 * Why each live-but-busy phase holds. Spelling these out individually is
 * deliberate: the command bar shows the reason, and "the agent is busy" tells
 * the Architect nothing they could act on.
 */
const HOLD_REASON: Readonly<Partial<Record<AvatarPhase, string>>> = {
  alert: 'agent is starting its turn',
  thinking: 'agent is mid-turn',
  working: 'agent is mid-tool',
  waiting: 'agent is waiting on another agent',
  blocked: 'agent is blocked at a gate',
  compacting: 'agent is compacting its context',
  looping: 'breaker armed on this agent'
}

/**
 * Contract: pure. Decides what happens to text submitted while the agent is in
 * `phase`. Never throws; an unknown phase holds rather than sends, because
 * sending into an unknown state is the one outcome that cannot be undone.
 */
export function decideCommand(phase: AvatarPhase | null): CommandDecision {
  if (phase === null) return { kind: 'refuse', reason: 'no agent selected' }
  if (DEAD.includes(phase)) return { kind: 'refuse', reason: `agent is ${phase}` }
  if (READY.includes(phase)) return { kind: 'send' }
  return { kind: 'hold', reason: HOLD_REASON[phase] ?? `agent is ${phase}` }
}

/**
 * What the renderer draws for one agent's command state. Held text is shown
 * back to the Architect verbatim — unsent text that the UI has swallowed is
 * exactly the kind of silent state this codebase forbids.
 */
export interface CommandState {
  readonly agentId: string
  /** Text held for the next idle moment, or null when nothing is queued. */
  readonly held: string | null
  /** Why it is held; null when nothing is queued. */
  readonly reason: string | null
}

export const commandSubmitSchema = z
  .object({
    agentId: agentIdSchema,
    text: z.string().min(1).max(16384)
  })
  .strict()

export type CommandSubmit = z.infer<typeof commandSubmitSchema>
