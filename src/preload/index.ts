import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  AGENTS_STATE_CHANNEL,
  AVATARS_STATE_CHANNEL,
  COMMANDS_STATE_CHANNEL,
  IpcChannels,
  ptyDataChannel,
  ptyExitChannel,
  type AvatarUpdate,
  type ConfigSnapshot,
  type EphApi,
  type HooksState
} from '../shared/ipc'
import type { AgentCard, SpawnRequest } from '../shared/agents'
import type { CommandState } from '../shared/commands'

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
  pty: {
    ensureDevShell: () => ipcRenderer.invoke(IpcChannels.ptyEnsureDevShell) as Promise<string>,
    write: (id, data) => ipcRenderer.invoke(IpcChannels.ptyWrite, { id, data }) as Promise<void>,
    resize: (id, cols, rows) =>
      ipcRenderer.invoke(IpcChannels.ptyResize, { id, cols, rows }) as Promise<void>,
    kill: (id) => ipcRenderer.invoke(IpcChannels.ptyKill, { id }) as Promise<void>,
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
