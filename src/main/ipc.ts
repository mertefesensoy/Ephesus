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
import type { OrgNode } from '../shared/org'
import type { GymDecided, GymRowView } from '../shared/gym-view'
import type { BriefView, SourceView, StoaCurated } from '../shared/stoa-view'
import type { ModeSet, ModeView } from '../shared/mode-view'
import { companyModeSchema } from '../shared/mode'
import { registerDraftSchema, sourceIdSchema, briefIdSchema } from '../shared/stoa'
import type {
  BriefRecord,
  RetroGenerated,
  RetroRow,
  RetroView,
  ConveneOutcome,
  MeetingClosed,
  MeetingSaid,
  MeetingView,
  DeckCommentOutcome,
  DeckRecord,
  MemoDecided,
  MemoQueueRow
} from '../shared/odeon'
import { memoVerdictNameSchema, type MemoVerdictName } from '../shared/memo'
import { actionItemSchema, conveneSchema } from '../shared/meeting'
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

const gymIdOnlySchema = z.object({ id: z.string().min(1).max(32) }).strict()

/**
 * The Gymnasium verdict payload.
 *
 * It carries NO decider, deliberately and for the same reason `watch:approve`
 * carries no channel: main knows with certainty that a call on the window
 * bridge is the Architect, and giving the renderer a field to name a decider
 * would hand an untrusted surface the one authority ADR-0015 reserves.
 */
const gymVerdictSchema = z
  .object({ id: z.string().min(1).max(32), verdict: z.enum(['approved', 'rejected']) })
  .strict()

const gymSetModeSchema = z.object({ mode: companyModeSchema }).strict()

const stoaIdSchema = z.object({ id: sourceIdSchema }).strict()
const stoaBriefIdSchema = z.object({ id: briefIdSchema }).strict()
/**
 * The register payload is the DRAFT and nothing else — no id, no registrar, no
 * timestamp. `.strict()` means a renderer that tried to smuggle
 * `registeredBy: 'artemis'` past the boundary is rejected at the boundary
 * rather than quietly ignored (FR-13.1).
 */
const stoaRegisterSchema = z.object({ draft: registerDraftSchema }).strict()

const gymMetricSchema = z
  .object({ id: z.string().min(1).max(32), measured: z.string().max(2_000).nullable() })
  .strict()

const odeonSaySchema = z
  .object({ text: z.string().min(1).max(10_000), to: z.string().min(1).max(64).optional() })
  .strict()

const odeonCloseSchema = z
  .object({
    actions: z.array(actionItemSchema).max(32)
  })
  .strict()

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
  /** Every archived standup brief, newest first (FR-7.1). */
  briefs(): readonly BriefRecord[]
  /** Every Gymnasium ledger row (R2). */
  gymLedger(): readonly GymRowView[]
  /** One proposal document. */
  gymProposal(id: string): string | null
  /** Records a verdict. The decider is always the Architect (FR-12.3). */
  gymVerdict(id: string, verdict: 'approved' | 'rejected'): GymDecided
  /** Records the measured outcome. */
  gymMetricResult(id: string, measured: string | null): GymDecided
  /** The company mode and the proof gate's current answer (FR-14.1). */
  gymMode(): ModeView
  /** Sets the mode. The actor is always the Architect (FR-14.2). */
  gymSetMode(mode: 'directed' | 'improving'): ModeSet
  /** Every watchlist source, retired ones included and marked (FR-13.1). */
  stoaWatchlist(): readonly SourceView[]
  /** Registers a source. The registrar is always the Architect (FR-13.1). */
  stoaRegister(draft: {
    url: string
    tags: readonly string[]
    license: string
    pin: string | null
    notes: string
  }): StoaCurated
  /** Retires a source — moved to the retired list, never deleted. */
  stoaRetire(id: string): StoaCurated
  /** Every archived brief (FR-13.4). */
  stoaBriefs(): readonly BriefView[]
  /** One archived brief's text. */
  stoaBrief(id: string): string | null
  /** The org chart, read off the roster (FR-11.5). */
  orgChart(): readonly OrgNode[]
  /** Per-agent metrics, folded from the book of record. */
  orgMetrics(): RetroView
  /** Every archived weekly retro. */
  retros(): readonly RetroRow[]
  /** Generates one retro now. */
  generateRetro(): RetroGenerated
  /** Convenes a meeting (FR-7.4). */
  convene(attendees: readonly string[], agenda: string): ConveneOutcome
  /** The live meeting, or null. */
  meeting(): MeetingView | null
  /** The Architect takes the floor (UC-07 step 3). */
  meetingSay(text: string, to: string | undefined): MeetingSaid
  /** Closes the meeting. */
  meetingClose(actions: readonly { title: string; assignee: string; spec: string }[]): MeetingClosed
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
  ipcMain.handle(IpcChannels.odeonConvene, (_ev, raw: unknown): ConveneOutcome => {
    const { attendees, agenda } = conveneSchema.parse(raw)
    return deps.convene(attendees, agenda)
  })
  ipcMain.handle(IpcChannels.odeonMeeting, (): MeetingView | null => deps.meeting())
  ipcMain.handle(IpcChannels.odeonMeetingSay, (_ev, raw: unknown): MeetingSaid => {
    const { text, to } = odeonSaySchema.parse(raw)
    return deps.meetingSay(text, to)
  })
  ipcMain.handle(IpcChannels.odeonMeetingClose, (_ev, raw: unknown): MeetingClosed => {
    const { actions } = odeonCloseSchema.parse(raw)
    return deps.meetingClose(actions)
  })
  ipcMain.handle(IpcChannels.gymLedger, (): readonly GymRowView[] => deps.gymLedger())
  ipcMain.handle(IpcChannels.gymProposal, (_ev, raw: unknown): string | null => {
    const { id } = gymIdOnlySchema.parse(raw)
    return deps.gymProposal(id)
  })
  ipcMain.handle(IpcChannels.gymVerdict, (_ev, raw: unknown): GymDecided => {
    const { id, verdict } = gymVerdictSchema.parse(raw)
    // FR-12.3 / R1, enforced HERE: the payload carries no decider, and main
    // supplies `architect` because a call arriving on the window bridge IS
    // the Architect. An agent has no path to this channel at all, and the
    // renderer has no field it could use to claim to be somebody else.
    return deps.gymVerdict(id, verdict)
  })
  ipcMain.handle(IpcChannels.gymMetricResult, (_ev, raw: unknown): GymDecided => {
    const { id, measured } = gymMetricSchema.parse(raw)
    return deps.gymMetricResult(id, measured)
  })
  ipcMain.handle(IpcChannels.gymMode, (): ModeView => deps.gymMode())
  ipcMain.handle(IpcChannels.gymSetMode, (_ev, raw: unknown): ModeSet => {
    const { mode } = gymSetModeSchema.parse(raw)
    // FR-14.2, enforced HERE: the payload carries no actor, and main supplies
    // `architect` because a call arriving on the window bridge IS the
    // Architect. This is the switch that decides whether the company acts
    // without being asked, so it gets the same treatment as `gym:verdict` and
    // `stoa:register` — there is no field to forge.
    return deps.gymSetMode(mode)
  })
  ipcMain.handle(IpcChannels.stoaWatchlist, (): readonly SourceView[] => deps.stoaWatchlist())
  ipcMain.handle(IpcChannels.stoaRegister, (_ev, raw: unknown): StoaCurated => {
    const { draft } = stoaRegisterSchema.parse(raw)
    // FR-13.1 / ADR-0017 R1, enforced HERE, exactly as `gym:verdict` enforces
    // its own: main supplies `architect` downstream because a call arriving on
    // the window bridge IS the Architect. The Stoa can never widen its own
    // reading list, so there is no channel an agent could reach and no field
    // on this one that would let a caller claim to be somebody else.
    return deps.stoaRegister({ ...draft, tags: [...draft.tags] })
  })
  ipcMain.handle(IpcChannels.stoaRetire, (_ev, raw: unknown): StoaCurated => {
    const { id } = stoaIdSchema.parse(raw)
    return deps.stoaRetire(id)
  })
  ipcMain.handle(IpcChannels.stoaBriefs, (): readonly BriefView[] => deps.stoaBriefs())
  ipcMain.handle(IpcChannels.stoaBrief, (_ev, raw: unknown): string | null => {
    const { id } = stoaBriefIdSchema.parse(raw)
    return deps.stoaBrief(id)
  })
  ipcMain.handle(IpcChannels.orgChart, (): readonly OrgNode[] => deps.orgChart())
  ipcMain.handle(IpcChannels.orgMetrics, (): RetroView => deps.orgMetrics())
  ipcMain.handle(IpcChannels.orgRetros, (): readonly RetroRow[] => deps.retros())
  ipcMain.handle(IpcChannels.orgGenerateRetro, (): RetroGenerated => deps.generateRetro())
  ipcMain.handle(IpcChannels.odeonBriefs, (): readonly BriefRecord[] => deps.briefs())
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
