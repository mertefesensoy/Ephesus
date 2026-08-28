import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  AGENTS_STATE_CHANNEL,
  AVATARS_STATE_CHANNEL,
  COMMANDS_STATE_CHANNEL,
  GATE_OPEN_CHANNEL,
  IpcChannels,
  LOG_APPEND_CHANNEL,
  TASKS_STATE_CHANNEL,
  ptyDataChannel,
  ptyExitChannel,
  type AgoraHealth,
  type AvatarUpdate,
  type ConfigSnapshot,
  type EphApi,
  type HooksState
} from '../shared/ipc'
import type { AgentCard, SpawnRequest } from '../shared/agents'
import type { CommandState } from '../shared/commands'
import type { BreakerState } from '../shared/breaker'
import type { AgentSpend } from '../shared/cost'
import type { OpenGate } from '../shared/gates'
import type { Message } from '../shared/message'
import type { LogEntry } from '../shared/log'
import type { KnowledgeDoc, MemoryView } from '../shared/memory'
import type { DeckRecord } from '../shared/odeon'
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
    decks: () => ipcRenderer.invoke(IpcChannels.odeonDecks) as Promise<readonly DeckRecord[]>,
    deck: (ref) => ipcRenderer.invoke(IpcChannels.odeonDeck, { ref }) as Promise<string | null>
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
