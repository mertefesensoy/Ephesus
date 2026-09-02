import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  AGENTS_STATE_CHANNEL,
  AVATARS_STATE_CHANNEL,
  COMMANDS_STATE_CHANNEL,
  CAPACITY_STATE_CHANNEL,
  GATE_OPEN_CHANNEL,
  IpcChannels,
  LOG_APPEND_CHANNEL,
  ODEON_QUEUE_CHANNEL,
  TASKS_STATE_CHANNEL,
  ptyDataChannel,
  ptyExitChannel,
  type AgoraHealth,
  type AvatarUpdate,
  type ConfigSnapshot,
  type EphApi,
  type HooksState
} from '../shared/ipc'
import type { UsageSnapshot } from '../shared/ipc'
import type { AgentCard, SpawnRequest } from '../shared/agents'
import type { CommandState } from '../shared/commands'
import type { BreakerState } from '../shared/breaker'
import type { CapacityView } from '../shared/capacity'
import type { AgentSpend } from '../shared/cost'
import type { OpenGate } from '../shared/gates'
import type { Message } from '../shared/message'
import type { LogEntry } from '../shared/log'
import type { KnowledgeDoc, MemoryView } from '../shared/memory'
import type { OrgNode } from '../shared/org'
import type { HarborView } from '../shared/harbor'
import type { ShareExport, ShareInspection, ShareInstall } from '../shared/share-view'
import type {
  ActivationResult,
  ProfileInstanceView,
  ProfileLoad,
  ProfileSummary
} from '../shared/profile-view'
import type { ActivationPlanResult } from '../shared/profile-activation'
import type { GymDecided, GymRowView } from '../shared/gym-view'
import type { BriefView, SourceView, StoaCurated } from '../shared/stoa-view'
import type { ModeSet, ModeView } from '../shared/mode-view'
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
import type { RecallResponse } from '../shared/recall'
import type { Registry } from '../shared/registry'
import type { SecretStatus, SecretTest } from '../shared/secrets'
import type { TaskLedger } from '../shared/tasks'

// The single door between renderer and main (SDD §1, §5). Every method is a
// thin, typed forward to an ipcMain handler that validates in main.
const eph: EphApi = {
  config: {
    get: () => ipcRenderer.invoke(IpcChannels.configGet) as Promise<ConfigSnapshot>
  },
  agents: {
    list: () => ipcRenderer.invoke(IpcChannels.agentsList) as Promise<readonly AgentCard[]>,
    spawn: (request: SpawnRequest) =>
      ipcRenderer.invoke(IpcChannels.agentsSpawn, request) as Promise<AgentCard>,
    card: (agentId) =>
      ipcRenderer.invoke(IpcChannels.agentsCard, { agentId }) as Promise<AgentCard>,
    kill: (agentId) => ipcRenderer.invoke(IpcChannels.agentsKill, { agentId }) as Promise<void>,
    interrupt: (agentId) =>
      ipcRenderer.invoke(IpcChannels.agentsInterrupt, { agentId }) as Promise<void>,
    send: (agentId, text) =>
      ipcRenderer.invoke(IpcChannels.agentsSend, { agentId, text }) as Promise<void>,
    onChange: (cb) => {
      const listener = (_ev: IpcRendererEvent, card: AgentCard): void => cb(card)
      ipcRenderer.on(AGENTS_STATE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(AGENTS_STATE_CHANNEL, listener)
    }
  },
  avatars: {
    list: () => ipcRenderer.invoke(IpcChannels.avatarsList) as Promise<readonly AvatarUpdate[]>,
    onChange: (cb) => {
      const listener = (_ev: IpcRendererEvent, update: AvatarUpdate): void => cb(update)
      ipcRenderer.on(AVATARS_STATE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(AVATARS_STATE_CHANNEL, listener)
    }
  },
  hooks: {
    state: () => ipcRenderer.invoke(IpcChannels.hooksState) as Promise<HooksState>
  },
  odeon: {
    convene: (attendees, agenda) =>
      ipcRenderer.invoke(IpcChannels.odeonConvene, {
        attendees,
        agenda
      }) as Promise<ConveneOutcome>,
    meeting: () => ipcRenderer.invoke(IpcChannels.odeonMeeting) as Promise<MeetingView | null>,
    meetingSay: (text, to) =>
      ipcRenderer.invoke(IpcChannels.odeonMeetingSay, { text, to }) as Promise<MeetingSaid>,
    meetingClose: (actions) =>
      ipcRenderer.invoke(IpcChannels.odeonMeetingClose, { actions }) as Promise<MeetingClosed>,
    briefs: () => ipcRenderer.invoke(IpcChannels.odeonBriefs) as Promise<readonly BriefRecord[]>,
    decks: () => ipcRenderer.invoke(IpcChannels.odeonDecks) as Promise<readonly DeckRecord[]>,
    deck: (ref) => ipcRenderer.invoke(IpcChannels.odeonDeck, { ref }) as Promise<string | null>,
    comment: (ref, text) =>
      ipcRenderer.invoke(IpcChannels.odeonComment, { ref, text }) as Promise<DeckCommentOutcome>,
    memos: (queue) =>
      ipcRenderer.invoke(IpcChannels.odeonMemos, { queue }) as Promise<readonly MemoQueueRow[]>,
    verdict: (memoId, verdict, notes) =>
      ipcRenderer.invoke(IpcChannels.odeonVerdict, {
        memoId,
        verdict,
        notes
      }) as Promise<MemoDecided>,
    onQueue: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(ODEON_QUEUE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(ODEON_QUEUE_CHANNEL, listener)
    }
  },
  gym: {
    ledger: () => ipcRenderer.invoke(IpcChannels.gymLedger) as Promise<readonly GymRowView[]>,
    proposal: (id) => ipcRenderer.invoke(IpcChannels.gymProposal, { id }) as Promise<string | null>,
    verdict: (id, verdict) =>
      ipcRenderer.invoke(IpcChannels.gymVerdict, { id, verdict }) as Promise<GymDecided>,
    metricResult: (id, measured) =>
      ipcRenderer.invoke(IpcChannels.gymMetricResult, { id, measured }) as Promise<GymDecided>,
    mode: () => ipcRenderer.invoke(IpcChannels.gymMode) as Promise<ModeView>,
    // No actor crosses this bridge: FR-14.2's authority is main's to assert.
    setMode: (mode) => ipcRenderer.invoke(IpcChannels.gymSetMode, { mode }) as Promise<ModeSet>
  },
  stoa: {
    watchlist: () =>
      ipcRenderer.invoke(IpcChannels.stoaWatchlist) as Promise<readonly SourceView[]>,
    // The draft and nothing more: no registrar field crosses this bridge,
    // because FR-13.1's authority is main's to assert, not the renderer's to
    // claim.
    register: (draft) =>
      ipcRenderer.invoke(IpcChannels.stoaRegister, { draft }) as Promise<StoaCurated>,
    retire: (id) => ipcRenderer.invoke(IpcChannels.stoaRetire, { id }) as Promise<StoaCurated>,
    briefs: () => ipcRenderer.invoke(IpcChannels.stoaBriefs) as Promise<readonly BriefView[]>,
    brief: (id) => ipcRenderer.invoke(IpcChannels.stoaBrief, { id }) as Promise<string | null>
  },
  profiles: {
    list: () => ipcRenderer.invoke(IpcChannels.profilesList) as Promise<readonly ProfileSummary[]>,
    inspect: (name) =>
      ipcRenderer.invoke(IpcChannels.profilesInspect, { name }) as Promise<ProfileLoad>,
    preview: (request) =>
      ipcRenderer.invoke(IpcChannels.profilesPreview, request) as Promise<ActivationPlanResult>,
    activate: (request) =>
      ipcRenderer.invoke(IpcChannels.profilesActivate, request) as Promise<ActivationResult>,
    deactivate: (instanceId) =>
      ipcRenderer.invoke(IpcChannels.profilesDeactivate, { instanceId }) as Promise<{
        ok: boolean
        reason: string | null
      }>,
    instances: () =>
      ipcRenderer.invoke(IpcChannels.profilesInstances) as Promise<readonly ProfileInstanceView[]>
  },
  harbor: {
    repos: () => ipcRenderer.invoke(IpcChannels.harborRepos) as Promise<HarborView>,
    hireExport: (profile, hire) =>
      ipcRenderer.invoke(IpcChannels.harborHireExport, { profile, hire }) as Promise<ShareExport>,
    profileExport: (name) =>
      ipcRenderer.invoke(IpcChannels.harborProfileExport, { name }) as Promise<ShareExport>,
    importInspect: (blob) =>
      ipcRenderer.invoke(IpcChannels.harborImportInspect, { blob }) as Promise<ShareInspection>,
    importInstall: (blob) =>
      ipcRenderer.invoke(IpcChannels.harborImportInstall, { blob }) as Promise<ShareInstall>
  },
  org: {
    chart: () => ipcRenderer.invoke(IpcChannels.orgChart) as Promise<readonly OrgNode[]>,
    metrics: () => ipcRenderer.invoke(IpcChannels.orgMetrics) as Promise<RetroView>,
    retros: () => ipcRenderer.invoke(IpcChannels.orgRetros) as Promise<readonly RetroRow[]>,
    generateRetro: () => ipcRenderer.invoke(IpcChannels.orgGenerateRetro) as Promise<RetroGenerated>
  },
  agora: {
    registry: () => ipcRenderer.invoke(IpcChannels.agoraRegistry) as Promise<Registry>,
    tasks: () => ipcRenderer.invoke(IpcChannels.agoraTasks) as Promise<TaskLedger>,
    board: () => ipcRenderer.invoke(IpcChannels.agoraBoard) as Promise<string>,
    onTasks: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(TASKS_STATE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(TASKS_STATE_CHANNEL, listener)
    },
    log: (afterSeq, limit) =>
      ipcRenderer.invoke(IpcChannels.agoraLog, { afterSeq, limit }) as Promise<readonly LogEntry[]>,
    onAppend: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(LOG_APPEND_CHANNEL, listener)
      return () => ipcRenderer.removeListener(LOG_APPEND_CHANNEL, listener)
    },
    health: () => ipcRenderer.invoke(IpcChannels.agoraHealth) as Promise<AgoraHealth>,
    memory: (agentId) =>
      ipcRenderer.invoke(IpcChannels.agoraMemory, { agentId }) as Promise<MemoryView>,
    recall: (query, scope, limit) =>
      ipcRenderer.invoke(IpcChannels.agoraRecall, {
        query,
        scope,
        limit
      }) as Promise<RecallResponse>,
    knowledge: () =>
      ipcRenderer.invoke(IpcChannels.agoraKnowledge) as Promise<readonly KnowledgeDoc[]>,
    registerKnowledge: (name, text) =>
      ipcRenderer.invoke(IpcChannels.agoraRegisterKnowledge, { name, text }) as Promise<
        readonly KnowledgeDoc[]
      >
  },
  commands: {
    list: () => ipcRenderer.invoke(IpcChannels.commandsList) as Promise<readonly CommandState[]>,
    submit: (agentId, text) =>
      ipcRenderer.invoke(IpcChannels.commandsSubmit, { agentId, text }) as Promise<CommandState>,
    onChange: (cb) => {
      const listener = (_ev: IpcRendererEvent, state: CommandState): void => cb(state)
      ipcRenderer.on(COMMANDS_STATE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(COMMANDS_STATE_CHANNEL, listener)
    }
  },
  // Write-only (ADR-0010): no forward here returns a stored value, because no
  // handler in main returns one.
  secrets: {
    set: (name, value) =>
      ipcRenderer.invoke(IpcChannels.secretsSet, { name, value }) as Promise<SecretStatus>,
    status: (name) =>
      ipcRenderer.invoke(IpcChannels.secretsStatus, { name }) as Promise<SecretStatus>,
    test: (name) => ipcRenderer.invoke(IpcChannels.secretsTest, { name }) as Promise<SecretTest>,
    delete: (name) =>
      ipcRenderer.invoke(IpcChannels.secretsDelete, { name }) as Promise<SecretStatus>
  },
  watch: {
    budgets: () => ipcRenderer.invoke(IpcChannels.watchBudgets) as Promise<readonly AgentSpend[]>,
    usage: () => ipcRenderer.invoke(IpcChannels.watchUsage) as Promise<UsageSnapshot>,
    approvals: () => ipcRenderer.invoke(IpcChannels.watchApprovals) as Promise<readonly OpenGate[]>,
    approve: (gateId, verdict) =>
      ipcRenderer.invoke(IpcChannels.watchApprove, { gateId, verdict }) as Promise<{
        ok: boolean
        reason: string | null
      }>,
    humanQueue: () =>
      ipcRenderer.invoke(IpcChannels.watchHumanQueue) as Promise<readonly Message[]>,
    dismiss: (messageId) =>
      ipcRenderer.invoke(IpcChannels.watchDismiss, { messageId }) as Promise<boolean>,
    breakerState: () =>
      ipcRenderer.invoke(IpcChannels.watchBreaker) as Promise<readonly BreakerState[]>,
    capacity: () => ipcRenderer.invoke(IpcChannels.watchCapacity) as Promise<CapacityView>,
    onCapacityChange: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(CAPACITY_STATE_CHANNEL, listener)
      return () => ipcRenderer.removeListener(CAPACITY_STATE_CHANNEL, listener)
    },
    onGateChange: (cb) => {
      const listener = (): void => cb()
      ipcRenderer.on(GATE_OPEN_CHANNEL, listener)
      return () => ipcRenderer.removeListener(GATE_OPEN_CHANNEL, listener)
    }
  },
  pty: {
    write: (id, data) => ipcRenderer.invoke(IpcChannels.ptyWrite, { id, data }) as Promise<void>,
    resize: (id, cols, rows) =>
      ipcRenderer.invoke(IpcChannels.ptyResize, { id, cols, rows }) as Promise<void>,
    onData: (id, cb) => {
      const channel = ptyDataChannel(id)
      const listener = (_ev: IpcRendererEvent, data: string): void => cb(data)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, cb) => {
      const channel = ptyExitChannel(id)
      const listener = (_ev: IpcRendererEvent, exitCode: number): void => cb(exitCode)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('eph', eph)
