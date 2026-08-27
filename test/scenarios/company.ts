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
import { denyAllPolicy, type GatePolicy } from '../../src/shared/gates'
import { Agora, type FaultPoint } from '../../src/main/agora'
import { Hermes, type HermesFaultPoint } from '../../src/main/hermes'
import { HookServer, type HookEventRecord } from '../../src/main/hooks'
import { PromptStore } from '../../src/main/prompts'
import { Breaker } from '../../src/main/watch/breaker'
import { GateManager, wireGateChokePoints } from '../../src/main/watch/gates'
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
  /** The Watch's policy for this company. Defaults to deny-all (FR-11.1). */
  readonly gatePolicy?: GatePolicy
}

export interface Company {
  readonly home: string
  readonly agora: Agora
  readonly hermes: Hermes
  readonly hookServer: HookServer
  readonly hookEvents: readonly HookEventRecord[]
  /** The Watch's approval queue, wired through the SHIPPED choke points. */
  readonly gates: GateManager
  /** The choke-point submitters, for scenarios that drive spend directly. */
  readonly chokePoints: ReturnType<typeof wireGateChokePoints>
  /** The circuit breaker, fed by the same event plane the floor reads. */
  readonly breaker: Breaker
  /** What each rung actually did, in order — S-BREAKER reads this. */
  readonly breakerActs: readonly string[]
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

  // The Watch (SDD §9). Deny-all unless the scenario says otherwise, so a
  // scenario that forgets to configure a policy tests the safe default.
  const gates = new GateManager({
    policy: () => options.gatePolicy ?? denyAllPolicy,
    onLogEvent: (draft) => {
      agora.appendLog(draft)
      agora.commitSoon(`gate ${String(draft['event'] ?? 'event')}`)
    },
    refusalReason: (because) => prompts.read(path.join('watch', `refusal-${because}.md`)).trim()
  })

  // The SHIPPED choke-point wiring, not a copy of it. The first draft of this
  // rig duplicated `index.ts` character-for-character, so S-GATE stayed green
  // with the production wiring deleted — found by review.
  const chokePoints = wireGateChokePoints({ gates, prompts })

  // The breaker (ADR-0011), wired to the same effects `index.ts` wires — the
  // acts are recorded rather than performed, because a scenario cannot kill a
  // process it also needs to assert against.
  const breakerActs: string[] = []
  const breaker = new Breaker({
    effects: {
      steer: (agentId, text) => breakerActs.push(`steer:${agentId}:${text.slice(0, 40)}`),
      pauseDeliveries: (agentId, paused) => {
        breakerActs.push(`pause:${agentId}:${String(paused)}`)
        hermes.setPaused(agentId, paused)
      },
      interrupt: (agentId) => breakerActs.push(`interrupt:${agentId}`),
      stop: (agentId) => breakerActs.push(`stop:${agentId}`),
      avatar: (agentId, event) =>
        breakerActs.push(
          `avatar:${agentId}:${event.kind === 'breaker' ? `rung${String(event.rung)}` : 'recover'}`
        )
    },
    steerText: (hit) =>
      prompts
        .render(
          path.join(
            'watch',
            `steer-${hit.detail['source'] === 'stop-loop' ? 'stop-loop' : hit.signal}.md`
          ),
          Object.fromEntries(Object.entries(hit.detail).map(([k, v]) => [k, String(v)]))
        )
        .trim(),
    onLogEvent: (draft) => {
      agora.appendLog(draft)
      agora.commitSoon(`breaker ${String(draft['action'] ?? 'trip')}`)
    }
  })

  const hermes = new Hermes({
    agora,
    prompts,
    ...(options.hermesFaults ? { faults: options.hermesFaults } : {}),
    ...(options.blockCap === undefined ? {} : { blockCap: options.blockCap }),
    ...(options.isIdle ? { isIdle: options.isIdle } : {}),
    ...(options.nudge ? { nudge: options.nudge } : {}),
    onPathology: (agentId, blocks) => {
      // ADR-0013's signal, consumed by the breaker as `index.ts` consumes it.
      breaker.notePathology(agentId, blocks)
      options.onPathology?.(agentId, blocks)
    },
    onNeedsHuman: ({ message }) =>
      chokePoints.submitNeedsHuman({
        from: message.from,
        subject: message.subject,
        conversation: message.conversation
      })
  })

  const hookEvents: HookEventRecord[] = []
  const hookServer = new HookServer({
    onEvent: (record) => {
      hookEvents.push(record)
      if (record.envelope.event === 'notification') {
        chokePoints.submitNotification(record.envelope.agentId, record.envelope.payload)
      }
      // Span capture (FR-11.6) off the same tool stream the floor reads, wired
      // as `index.ts` wires it.
      const payload = record.envelope.payload as Record<string, unknown> | null
      const tool = typeof payload?.['tool'] === 'string' ? payload['tool'] : null
      if (tool !== null && record.envelope.event === 'pre-tool') {
        breaker.openSpan(record.envelope.agentId, tool, payload)
      }
      if (tool !== null && record.envelope.event === 'post-tool') {
        breaker.closeSpan(
          record.envelope.agentId,
          tool,
          payload?.['error'] === undefined ? 'ok' : 'error'
        )
        breaker.evaluate(record.envelope.agentId)
      }
      return record.envelope.event === 'stop'
        ? hermes
            .decideOnStop(record.envelope.agentId, record.envelope.payload)
            .then((reply) => reply ?? undefined)
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
    gates,
    chokePoints,
    breaker,
    breakerActs,

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
