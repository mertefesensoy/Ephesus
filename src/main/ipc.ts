import { ipcMain } from 'electron'
import { z } from 'zod'
import { agentIdPayloadSchema, agentIdSchema, spawnRequestSchema } from '../shared/agents'
import { commandSubmitSchema, type CommandState } from '../shared/commands'
import type { BreakerState } from '../shared/breaker'
import type { AgentSpend } from '../shared/cost'
import { gateApproveSchema, type OpenGate } from '../shared/gates'
import { messageIdSchema, type Message } from '../shared/message'
import {
  IpcChannels,
  type AgoraHealth,
  type AvatarUpdate,
  type ConfigSnapshot,
  type HooksState
} from '../shared/ipc'
import { ptyResizeSchema, ptyWriteSchema } from '../shared/pty'
import {
  secretNamePayloadSchema,
  secretSetSchema,
  type SecretStatus,
  type SecretTest
} from '../shared/secrets'
import type { KnowledgeDoc, MemoryView } from '../shared/memory'
import type { DeckCommentOutcome, DeckRecord, MemoDecided, MemoQueueRow } from '../shared/odeon'
import { memoVerdictNameSchema, type MemoVerdictName } from '../shared/memo'
import type { MemoQueueName } from '../shared/ipc'
import { RECALL_MAX_LIMIT, type RecallResponse } from '../shared/recall'
import type { AgentManager } from './agents'
import type { Agora } from './agora'
import type { AvatarDirector } from './avatars'
import type { CommandQueue } from './commands'
import { getHome } from './config'
import type { PtyManager } from './pty'
import type { GateManager } from './watch/gates'
import type { SecretBroker } from './watch/secrets'

/** Cursor paging over the event log (SDD §5 `agora.log(afterSeq, limit)`). */
const agoraLogSchema = z
  .object({
    afterSeq: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(2000)
  })
  .strict()

/** One message from the Architect's own queue (SDD §5 `watch:dismiss`). */
const messageIdPayloadSchema = z.object({ messageId: messageIdSchema }).strict()

/** One recall query from the Memory panel (SDD §5 `agora:recall`). */
const odeonDeckSchema = z.object({ ref: z.string().min(1).max(256) }).strict()

const odeonMemosSchema = z.object({ queue: z.enum(['open', 'decided', 'all']) }).strict()

/**
 * The Architect bench for a memo verdict (UC-06 step 4).
 *
 * It carries no `decidedBy`, deliberately, and for the same reason
 * `watch:approve` carries no channel: a verdict arriving through the window
 * bridge IS the Architect, main knows that with certainty, and taking the
 * renderer's word for who decided would let an untrusted surface stamp a
 * countersignature onto the permanent record of a delegated decision
 * (invariant §2, FR-5.5).
 */
const odeonVerdictSchema = z
  .object({
    memoId: z.string().min(1).max(64),
    verdict: memoVerdictNameSchema,
    notes: z.string().max(10_000)
  })
  .strict()

const odeonCommentSchema = z
  .object({ ref: z.string().min(1).max(256), text: z.string().min(1).max(10_000) })
  .strict()

const agoraRecallSchema = z
  .object({
    query: z.string().min(1).max(1_000),
    scope: z.string().min(1).max(64).nullable(),
    limit: z.number().int().min(1).max(RECALL_MAX_LIMIT)
  })
  .strict()

/**
 * One reference document for the shelf (FR-6.4, SDD §5 `agora:register-knowledge`).
 *
 * The name is bounded here AND re-checked in `library.knowledgePath` — the
 * renderer is untrusted (invariant §2), and a traversal that only this schema
 * refused would be one refactor away from being possible again.
 */
const agoraRegisterKnowledgeSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'a plain document name, no path separators'),
    text: z.string().min(1).max(500_000)
  })
  .strict()

/** Architect keystrokes bound for an agent's PTY (FR-1.3). */
const agentSendSchema = z.object({ agentId: agentIdSchema, text: z.string().max(65536) }).strict()

/**
 * Registers every handler behind the typed preload surface (SDD §1.1).
 * Invariant: main validates all renderer input; handlers taking arguments
 * parse them with a src/shared/ validator before acting (BUILD-PROMPT §3.2).
 */
export interface IpcDeps {
  readonly ptyManager: PtyManager
  readonly agents: AgentManager
  readonly avatars: AvatarDirector
  readonly commands: CommandQueue
  readonly agora: Agora
  /** The write-only credential broker (ADR-0010). */
  readonly secrets: SecretBroker
  /** Per-agent spend, folded from the durable ledger (ADR-0011). */
  budgets(): readonly AgentSpend[]
  /** The Watch's approval queue (SDD §9, UC-08). */
  readonly gates: GateManager
  /** Mail Hermes diverted to `agora/human/` (FR-3.7). */
  humanQueue(): readonly Message[]
  /** Archives one message from the Architect's queue. */
  dismissFromHumanQueue(messageId: string): boolean
  /** Per-agent breaker state (ADR-0011). */
  breakerState(): readonly BreakerState[]
  /** Event-plane health for the visible degradation states (FR-2.3, SDD §10). */
  hooksState(): HooksState
  /** Data-plane health — corrupt files, commit give-ups, runtime degradations (§7). */
  agoraHealth(): AgoraHealth
  /** One agent's memory view (ADR-0006 layer 1, SDD §5 `agora.memory(id)`). */
  memoryView(agentId: string): MemoryView
  /** Recall on the best rung that answers (ADR-0006 layer 2). */
  recall(query: string, scope: string | null, limit: number): Promise<RecallResponse>
  /** The Architect's reference shelf (FR-6.4). */
  /** Every archived review deck, newest first (FR-7.2). */
  decks(): readonly DeckRecord[]
  /** One deck's HTML; null when the ref names nothing in the archive. */
  deck(ref: string): string | null
  /** Files an Architect review comment as mail to the orchestrator (UC-05). */
  commentOnDeck(ref: string, text: string): DeckCommentOutcome
  /** The memo queue (FR-7.3). */
  memos(queue: MemoQueueName): readonly MemoQueueRow[]
  /** The Architect's verdict on a memo (UC-06 step 4). */
  decideMemo(memoId: string, verdict: MemoVerdictName, notes: string): MemoDecided
  knowledge(): readonly KnowledgeDoc[]
  /** Registers a shelf document and commits it through the single committer. */
  registerKnowledge(name: string, text: string): readonly KnowledgeDoc[]
}

export function registerIpc(deps: IpcDeps): void {
  const { ptyManager, agents, avatars, commands, agora, secrets } = deps

  // ADR-0010, write-only: `set` is the only channel that carries a value, and
  // it carries it inward. Nothing below returns one.
  ipcMain.handle(IpcChannels.secretsSet, (_ev, raw: unknown): SecretStatus => {
    const { name, value } = secretSetSchema.parse(raw)
    return secrets.set(name, value)
  })
  ipcMain.handle(IpcChannels.secretsStatus, (_ev, raw: unknown): SecretStatus =>
    secrets.status(secretNamePayloadSchema.parse(raw).name)
  )
  ipcMain.handle(IpcChannels.secretsTest, (_ev, raw: unknown): SecretTest =>
    secrets.test(secretNamePayloadSchema.parse(raw).name)
  )
  ipcMain.handle(IpcChannels.secretsDelete, (_ev, raw: unknown): SecretStatus =>
    secrets.delete(secretNamePayloadSchema.parse(raw).name)
  )

  ipcMain.handle(IpcChannels.watchBudgets, (): readonly AgentSpend[] => deps.budgets())

  ipcMain.handle(IpcChannels.watchApprovals, (): readonly OpenGate[] => deps.gates.list())

  ipcMain.handle(IpcChannels.watchHumanQueue, (): readonly Message[] => deps.humanQueue())

  ipcMain.handle(IpcChannels.watchBreaker, (): readonly BreakerState[] => deps.breakerState())

  ipcMain.handle(IpcChannels.watchDismiss, (_ev, raw: unknown): boolean =>
    deps.dismissFromHumanQueue(messageIdPayloadSchema.parse(raw).messageId)
  )

  ipcMain.handle(IpcChannels.watchApprove, (_ev, raw: unknown) => {
    // The verdict is validated in main like every other renderer payload: the
    // renderer holds no gate state and cannot invent a gate id (invariant §2).
    // The channel is stamped HERE, not taken from the payload: a verdict
    // arriving through the window bridge is `local` by definition, and letting
    // the renderer name it would put the provenance of a destructive approval
    // under untrusted control (NFR-9, NFR-13).
    const { gateId, verdict } = gateApproveSchema.parse(raw)
    const result = deps.gates.decide(gateId, verdict, { channel: 'local' })
    return { ok: result.ok, reason: result.ok ? null : result.reason }
  })

  ipcMain.handle(IpcChannels.agoraRegistry, () => agora.registry())
  ipcMain.handle(IpcChannels.agoraTasks, () => agora.tasks())
  ipcMain.handle(IpcChannels.agoraBoard, () => agora.board())
  ipcMain.handle(IpcChannels.agoraLog, (_ev, raw: unknown) => {
    const { afterSeq, limit } = agoraLogSchema.parse(raw)
    return agora.readLog(afterSeq, limit)
  })

  ipcMain.handle(IpcChannels.commandsList, (): readonly CommandState[] => commands.list())

  ipcMain.handle(IpcChannels.commandsSubmit, (_ev, raw: unknown): CommandState => {
    const { agentId, text } = commandSubmitSchema.parse(raw)
    return commands.submit(agentId, text)
  })

  ipcMain.handle(IpcChannels.avatarsList, (): readonly AvatarUpdate[] =>
    [...avatars.list()].map(([agentId, snapshot]) => ({ agentId, snapshot }))
  )

  ipcMain.handle(IpcChannels.hooksState, (): HooksState => deps.hooksState())

  ipcMain.handle(IpcChannels.agoraHealth, (): AgoraHealth => deps.agoraHealth())

  ipcMain.handle(IpcChannels.agoraMemory, (_ev, raw: unknown): MemoryView => {
    const { agentId } = agentIdPayloadSchema.parse(raw)
    return deps.memoryView(agentId)
  })
  ipcMain.handle(IpcChannels.agoraRecall, async (_ev, raw: unknown): Promise<RecallResponse> => {
    const { query, scope, limit } = agoraRecallSchema.parse(raw)
    return deps.recall(query, scope, limit)
  })
  ipcMain.handle(IpcChannels.odeonDecks, (): readonly DeckRecord[] => deps.decks())
  ipcMain.handle(IpcChannels.odeonDeck, (_ev, raw: unknown): string | null => {
    // The ref crosses the trust boundary, so it is validated here and the
    // Odeon resolves only well-formed deck names inside its own directory.
    const { ref } = odeonDeckSchema.parse(raw)
    return deps.deck(ref)
  })
  ipcMain.handle(IpcChannels.odeonMemos, (_ev, raw: unknown): readonly MemoQueueRow[] => {
    const { queue } = odeonMemosSchema.parse(raw)
    return deps.memos(queue)
  })
  ipcMain.handle(IpcChannels.odeonVerdict, (_ev, raw: unknown): MemoDecided => {
    const { memoId, verdict, notes } = odeonVerdictSchema.parse(raw)
    return deps.decideMemo(memoId, verdict, notes)
  })
  ipcMain.handle(IpcChannels.odeonComment, (_ev, raw: unknown): DeckCommentOutcome => {
    const { ref, text } = odeonCommentSchema.parse(raw)
    return deps.commentOnDeck(ref, text)
  })
  ipcMain.handle(IpcChannels.agoraKnowledge, (): readonly KnowledgeDoc[] => deps.knowledge())
  ipcMain.handle(
    IpcChannels.agoraRegisterKnowledge,
    (_ev, raw: unknown): readonly KnowledgeDoc[] => {
      const { name, text } = agoraRegisterKnowledgeSchema.parse(raw)
      return deps.registerKnowledge(name, text)
    }
  )

  ipcMain.handle(IpcChannels.configGet, (): ConfigSnapshot => {
    const home = getHome()
    return { config: home.config, warning: home.configWarning }
  })

  ipcMain.handle(IpcChannels.agentsList, () => agents.list())

  ipcMain.handle(IpcChannels.agentsSpawn, async (_ev, raw: unknown) => {
    return agents.spawn(spawnRequestSchema.parse(raw))
  })

  ipcMain.handle(IpcChannels.agentsCard, (_ev, raw: unknown) => {
    return agents.card(agentIdPayloadSchema.parse(raw).agentId)
  })

  ipcMain.handle(IpcChannels.agentsKill, (_ev, raw: unknown) => {
    agents.kill(agentIdPayloadSchema.parse(raw).agentId)
  })

  ipcMain.handle(IpcChannels.agentsInterrupt, (_ev, raw: unknown) => {
    const { agentId } = agentIdPayloadSchema.parse(raw)
    // Interrupting drops queued text: stopping the agent did not mean "and then
    // say this anyway" (FR-1.3).
    commands.clear(agentId)
    agents.interrupt(agentId)
  })

  ipcMain.handle(IpcChannels.agentsSend, (_ev, raw: unknown) => {
    const { agentId, text } = agentSendSchema.parse(raw)
    agents.send(agentId, text)
  })

  ipcMain.handle(IpcChannels.ptyWrite, (_ev, raw: unknown) => {
    const { id, data } = ptyWriteSchema.parse(raw)
    ptyManager.write(id, data)
  })

  ipcMain.handle(IpcChannels.ptyResize, (_ev, raw: unknown) => {
    const { id, cols, rows } = ptyResizeSchema.parse(raw)
    ptyManager.resize(id, cols, rows)
  })
}
