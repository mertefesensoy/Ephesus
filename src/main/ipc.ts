import { ipcMain } from 'electron'
import { z } from 'zod'
import { agentIdPayloadSchema, agentIdSchema, spawnRequestSchema } from '../shared/agents'
import { commandSubmitSchema, type CommandState } from '../shared/commands'
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
  type SecretTest,
  type SecretsHealth
} from '../shared/secrets'
import type { AgentManager } from './agents'
import type { Agora } from './agora'
import type { AvatarDirector } from './avatars'
import type { CommandQueue } from './commands'
import { getHome } from './config'
import type { PtyManager } from './pty'
import type { SecretBroker } from './watch/secrets'

/** Cursor paging over the event log (SDD §5 `agora.log(afterSeq, limit)`). */
const agoraLogSchema = z
  .object({
    afterSeq: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(2000)
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
  /** Event-plane health for the visible degradation states (FR-2.3, SDD §10). */
  hooksState(): HooksState
  /** Data-plane health — corrupt files, commit give-ups, runtime degradations (§7). */
  agoraHealth(): AgoraHealth
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
  ipcMain.handle(IpcChannels.secretsList, (): readonly SecretStatus[] =>
    secrets.names().map((name) => secrets.status(name))
  )
  ipcMain.handle(IpcChannels.secretsHealth, (): SecretsHealth => secrets.health())

  ipcMain.handle(IpcChannels.agoraRegistry, () => agora.registry())
  ipcMain.handle(IpcChannels.agoraTasks, () => agora.tasks())
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
