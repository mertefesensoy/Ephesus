import { ipcMain } from 'electron'
import { z } from 'zod'
import { agentIdPayloadSchema, agentIdSchema, spawnRequestSchema } from '../shared/agents'
import { commandSubmitSchema, type CommandState } from '../shared/commands'
import {
  DEV_SHELL_ID,
  IpcChannels,
  type AvatarUpdate,
  type ConfigSnapshot,
  type HooksState
} from '../shared/ipc'
import { ptyKillSchema, ptyResizeSchema, ptyWriteSchema } from '../shared/pty'
import type { AgentManager } from './agents'
import type { AvatarDirector } from './avatars'
import type { CommandQueue } from './commands'
import { getHome } from './config'
import type { PtyManager } from './pty'

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
  /** Event-plane health for the visible degradation states (FR-2.3, SDD §10). */
  hooksState(): HooksState
}

export function registerIpc(deps: IpcDeps): void {
  const { ptyManager, agents, avatars, commands } = deps

  ipcMain.handle(IpcChannels.commandsList, (): readonly CommandState[] => commands.list())

  ipcMain.handle(IpcChannels.commandsSubmit, (_ev, raw: unknown): CommandState => {
    const { agentId, text } = commandSubmitSchema.parse(raw)
    return commands.submit(agentId, text)
  })

  ipcMain.handle(IpcChannels.avatarsList, (): readonly AvatarUpdate[] =>
    [...avatars.list()].map(([agentId, snapshot]) => ({ agentId, snapshot }))
  )

  ipcMain.handle(IpcChannels.hooksState, (): HooksState => deps.hooksState())

  ipcMain.handle(IpcChannels.configGet, (): ConfigSnapshot => {
    const home = getHome()
    return { config: home.config, warning: home.configWarning }
  })

  // Renderer asks for the dev shell AFTER subscribing to its data channel,
  // so the first prompt bytes are never lost to a subscribe race.
  ipcMain.handle(IpcChannels.ptyEnsureDevShell, () => {
    ptyManager.spawnShell(DEV_SHELL_ID)
    return DEV_SHELL_ID
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

  ipcMain.handle(IpcChannels.ptyKill, (_ev, raw: unknown) => {
    const { id } = ptyKillSchema.parse(raw)
    ptyManager.kill(id)
  })
}
