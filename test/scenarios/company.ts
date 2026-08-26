import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  composeMessage,
  makeMessageId,
  type Message,
  type SpeechAct
} from '../../src/shared/message'
import { Agora, type FaultPoint } from '../../src/main/agora'
import { Hermes, type HermesFaultPoint } from '../../src/main/hermes'
import { HookServer, type HookEventRecord } from '../../src/main/hooks'
import { PromptStore } from '../../src/main/prompts'
import { FAKE_ENGINE_CLI } from '../fakes/fake-adapter'

/**
 * A miniature company for the named scenario suites (TEST-STRATEGY §3).
 *
 * Nothing here is a mock. Real git in a temp home, a real socket, real spawned
 * `fake-engine` processes writing real files — because every one of these
 * scenarios is about what happens to *state on disk* when something goes wrong,
 * and a mock cannot be interrupted between a rename and a commit.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))

export interface CompanyOptions {
  readonly agoraFaults?: (point: FaultPoint) => void | Promise<void>
  readonly hermesFaults?: (point: HermesFaultPoint) => void | Promise<void>
  readonly blockCap?: number
  readonly isIdle?: (agentId: string) => boolean
  readonly nudge?: (agentId: string, text: string) => void
  readonly onPathology?: (agentId: string, blocks: number) => void
}

export interface Company {
  readonly home: string
  readonly agora: Agora
  readonly hermes: Hermes
  readonly hookServer: HookServer
  readonly hookEvents: readonly HookEventRecord[]
  /** Gives an agent a mailbox and a live hook token. */
  hire(agentId: string): void
  /** Runs the REAL fake-engine binary for one agent with a scripted turn. */
  runTurn(agentId: string, steps: readonly unknown[]): Promise<string>
  /** Files currently in an agent's inbox. */
  inbox(agentId: string): readonly string[]
  /** Files an agent has consumed. */
  done(agentId: string): readonly string[]
  /** Reads a message file from an inbox. */
  readInbox(agentId: string, name: string): Message
  close(): Promise<void>
}

/**
 * Homes created this run. Removing a home is separated from closing a company
 * because a blackout scenario deliberately has TWO companies over one home —
 * the dead one and the restarted one — and deleting the directory while the
 * survivor still has a commit in flight is a teardown race, not a finding.
 */
const openHomes: string[] = []

/** Removes every temp home created this run. Call after closing the companies. */
export function cleanupHomes(): void {
  for (const home of openHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

let seq = 0

/** A well-formed message, with a unique sortable id per call. */
export function scenarioMessage(fields: {
  from: string
  to: string
  act?: SpeechAct
  subject?: string
  body?: string
  hops?: number
  conversation?: string
  in_reply_to?: string | null
}): Message {
  seq += 1
  return composeMessage({
    id: makeMessageId(new Date(Date.now() + seq), `s${String(seq).padStart(4, '0')}`),
    conversation: fields.conversation ?? 'conv-scenario',
    in_reply_to: fields.in_reply_to ?? null,
    from: fields.from,
    to: fields.to,
    act: fields.act ?? 'inform',
    subject: fields.subject ?? 'scenario message',
    body: fields.body ?? 'body',
    hops: fields.hops ?? 0,
    created_at: new Date().toISOString()
  })
}

export async function startCompany(options: CompanyOptions = {}): Promise<Company> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-scenario-'))
  openHomes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))

  const agora = new Agora({
    root: path.join(home, 'agora'),
    prompts,
    backoffMs: 1,
    ...(options.agoraFaults ? { faults: options.agoraFaults } : {})
  })
  await agora.ensureRepo()

  const hermes = new Hermes({
    agora,
    prompts,
    ...(options.hermesFaults ? { faults: options.hermesFaults } : {}),
    ...(options.blockCap === undefined ? {} : { blockCap: options.blockCap }),
    ...(options.isIdle ? { isIdle: options.isIdle } : {}),
    ...(options.nudge ? { nudge: options.nudge } : {}),
    ...(options.onPathology ? { onPathology: options.onPathology } : {})
  })

  const hookEvents: HookEventRecord[] = []
  const hookServer = new HookServer({
    onEvent: (record) => {
      hookEvents.push(record)
      return record.envelope.event === 'stop'
        ? (hermes.decideOnStop(record.envelope.agentId, record.envelope.payload) ?? undefined)
        : undefined
    },
    onRejected: () => {}
  })
  await hookServer.start(home)

  const tokens = new Map<string, string>()

  return {
    home,
    agora,
    hermes,
    hookServer,
    hookEvents,

    hire(agentId) {
      hermes.ensureMailbox(agentId)
      const token = `token-${agentId}`
      tokens.set(agentId, token)
      hookServer.registerSpawn(agentId, token)
    },

    async runTurn(agentId, steps) {
      const script = path.join(home, `${agentId}-${Date.now()}-${Math.random()}.json`)
      fs.writeFileSync(script, JSON.stringify({ schemaVersion: 1, steps }), 'utf8')
      return new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [FAKE_ENGINE_CLI, '--script', script], {
          env: {
            ...process.env,
            EPH_AGENT_ID: agentId,
            EPH_AGENT_DIR: agora.agentDir(agentId),
            EPH_HOOK_TOKEN: tokens.get(agentId) ?? '',
            EPH_HOOK_ENDPOINT: hookServer.endpoint() ?? ''
          },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let out = ''
        child.stdout.setEncoding('utf8')
        child.stderr.resume()
        child.stdout.on('data', (chunk: string) => {
          out += chunk
        })
        child.on('error', reject)
        child.on('close', () => resolve(out))
      })
    },

    inbox(agentId) {
      const dir = path.join(hermes.mailboxDir(agentId), 'inbox')
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((n) => n.endsWith('.json'))
            .sort()
        : []
    },

    done(agentId) {
      const dir = path.join(hermes.mailboxDir(agentId), 'inbox', '.done')
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((n) => n.endsWith('.json'))
            .sort()
        : []
    },

    readInbox(agentId, name) {
      const file = path.join(hermes.mailboxDir(agentId), 'inbox', name)
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Message
    },

    async close() {
      hermes.stop()
      await hookServer.stop()
      await agora.drained().catch(() => {})
    }
  }
}

/** A fake-engine step that writes one message into the agent's own outbox. */
export function sendStep(message: Message): unknown {
  return { kind: 'write-outbox', message }
}
