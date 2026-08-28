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
import { ClosingTime } from '../../src/main/closing'
import { LedgerEndpoint } from '../../src/main/ledger'
import { Odeon } from '../../src/main/odeon'
import { Gymnasium } from '../../src/main/gymnasium'
import { BriefingJob } from '../../src/main/briefing'
import { MeetingDriver } from '../../src/main/meeting'
import { OrgLayer } from '../../src/main/org'
import { wireOdeonEndpoint } from '../../src/main/odeon-endpoint'
import { Hermes, type HermesFaultPoint } from '../../src/main/hermes'
import { HookServer, type HookEventRecord } from '../../src/main/hooks'
import { PromptStore } from '../../src/main/prompts'
import { Breaker } from '../../src/main/watch/breaker'
import { SteerNotes } from '../../src/main/watch/steer-notes'
import { BudgetWatcher, type BudgetedAgent } from '../../src/main/watch/budgets'
import { CostLedger, MemoryLedgerStore, type LedgerStore } from '../../src/main/watch/ledger'
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
  /**
   * Artemis’s delegated-authority answer for memo triage (FR-5.5).
   * Defaults to refusing everything, which is deny-by-default.
   */
  readonly mayDecide?: (request: {
    class: 'memo'
    domain: string
  }) =>
    | { readonly allowed: true; readonly countersignature: { by: string; under: string } }
    | { readonly allowed: false; readonly because: string }
  /**
   * The durable cost plane. Passing the SAME store to a second `startCompany`
   * is what "restart" means for S-LEDGER: the harness objects are rebuilt, the
   * durable rows are not (ADR-0011 — cost figures come only from the ledger,
   * never from an in-memory counter).
   */
  readonly ledgerStore?: LedgerStore
  /**
   * The hook grade every hire declares — the fact GYM-002's steer channel keys
   * on. Defaults to `native`, matching `index.ts`'s fallback.
   */
  readonly hookGrade?: string
  /** Closing time's hard deadline (GYM-003). Scenarios keep it short. */
  readonly closingDeadlineMs?: number
}

export interface Company {
  readonly home: string
  readonly agora: Agora
  readonly hermes: Hermes
  readonly hookServer: HookServer
  readonly hookEvents: readonly HookEventRecord[]
  /** The Watch's approval queue, wired through the SHIPPED choke points. */
  readonly gates: GateManager
  /** The task ledger endpoint — the SHIPPED one, so the M5.1 join is real. */
  readonly tasks: LedgerEndpoint
  /** The Odeon archive (ADR-0008). */
  readonly odeon: Odeon
  /** The Gymnasium and its ledger (ADR-0015). */
  readonly gymnasium: Gymnasium
  /** The standup job (FR-7.1). */
  readonly briefing: BriefingJob
  /** The meeting driver (FR-7.4). */
  readonly meetings: MeetingDriver
  /** The org layer and its retro (FR-11.5). */
  readonly org: OrgLayer
  /** Which bench each filed memo was triaged to. */
  readonly triaged: readonly string[]
  /** The choke-point submitters, for scenarios that drive spend directly. */
  readonly chokePoints: ReturnType<typeof wireGateChokePoints>
  /** The circuit breaker, fed by the same event plane the floor reads. */
  readonly breaker: Breaker
  /** What each rung actually did, in order — S-BREAKER reads this. */
  readonly breakerActs: readonly string[]
  /** Closing time (GYM-003) — the SHIPPED protocol, wired to this company. */
  readonly closing: ClosingTime
  /** The durable cost plane, so a restarted company can be given the same one. */
  readonly ledgerStore: LedgerStore
  /** The durable cost ledger (ADR-0011). */
  readonly costs: CostLedger
  /** Folds real engine transcripts into the ledger on demand. */
  foldSpend(agent: BudgetedAgent, cwd: string): Promise<void>
  /**
   * Runs a turn in a directory of its own, so the engine writes real
   * transcripts. `env` is injected into the CHILD's environment the way a spawn
   * plan injects declared grants (ADR-0010) — never through this process's own,
   * which would be the harness reading a credential outside the broker.
   */
  runTurnIn(
    agentId: string,
    cwd: string,
    steps: readonly unknown[],
    env?: Readonly<Record<string, string>>
  ): Promise<string>
  /**
   * Gives an agent a mailbox, a live hook token and a session.
   *
   * The session id is fresh per company by default, which is what a respawn
   * without engine-native resume gets. Passing one models `--resume` (M3.7):
   * the same session continuing across a restart.
   */
  hire(agentId: string, sessionId?: string): void
  /** The session id this company's spawn of `agentId` reports. */
  sessionOf(agentId: string): string
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
/** Distinguishes one company from the next; a restart is a new spawn. */
let companies = 0

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
  companies += 1
  const companyIndex = companies
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

  // The task ledger (SDD §7.1). The rig runs the SHIPPED endpoint so the M5.1
  // join — gate → `task.gates`, breaker rung 3 → `stalled` — is EXERCISED by
  // the scenarios rather than described by them.
  const tasks = new LedgerEndpoint({
    store: agora,
    knownAgents: () => hermes.knownAgents(),
    onLogEvent: (draft) => {
      agora.appendLog(draft)
      agora.commitSoon(`ledger ${String(draft['event'] ?? 'event')}`)
    }
  })

  // The SHIPPED choke-point wiring, not a copy of it. The first draft of this
  // rig duplicated `index.ts` character-for-character, so S-GATE stayed green
  // with the production wiring deleted — found by review.
  const chokePoints = wireGateChokePoints({
    gates,
    prompts,
    taskOf: (agentId) => tasks.boundTaskFor(agentId)
  })

  // The breaker (ADR-0011), wired to the same effects `index.ts` wires — the
  // acts are recorded rather than performed, because a scenario cannot kill a
  // process it also needs to assert against.
  const breakerActs: string[] = []
  // GYM-002: the SHIPPED steer channel, not a copy of it — the same class
  // `index.ts` constructs, so the scenarios exercise the grade split and the
  // exactly-once boundary delivery rather than describing them.
  const steerNotes = new SteerNotes({
    hookFidelity: () => options.hookGrade ?? 'native',
    queueSubmit: (agentId, text) => breakerActs.push(`queue-steer:${agentId}:${text.slice(0, 40)}`),
    onSteer: (agentId, text, channel) => {
      breakerActs.push(`steer:${agentId}:${text.slice(0, 40)}`)
      breakerActs.push(`steer-channel:${agentId}:${channel}`)
    }
  })
  const breaker = new Breaker({
    effects: {
      steer: (agentId, text) => steerNotes.steer(agentId, text),
      pauseDeliveries: (agentId, paused) => {
        breakerActs.push(`pause:${agentId}:${String(paused)}`)
        hermes.setPaused(agentId, paused)
      },
      constrainBudget: (agentId, constrained) =>
        breakerActs.push(`constrain-budget:${agentId}:${String(constrained)}`),
      interrupt: (agentId) => breakerActs.push(`interrupt:${agentId}`),
      stop: (agentId) => breakerActs.push(`stop:${agentId}`),
      // Performed for real: ADR-0011 rung 3 is only observable if the task
      // actually goes back to the ledger.
      returnTask: (agentId, report) => {
        const taskId = tasks.stallTaskOf(agentId, report)
        breakerActs.push(`return-task:${agentId}:${taskId ?? 'none'}`)
      },
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

  // Closing time (GYM-003): the SHIPPED protocol, handed acks by the endpoint
  // below exactly as `index.ts` hands them. Constructed first because Hermes's
  // options close over it.
  let closingRef: ClosingTime | null = null

  // The Odeon and its neighbours, wired the way `index.ts` wires them so the
  // S-suites exercise the shipped path (the M2 close-out lesson).
  const odeon = new Odeon({
    agoraRoot: agora.root,
    prompts,
    task: (taskId) => tasks.tasks().tasks.find((row) => row.id === taskId) ?? null,
    recordDeck: (taskId, ref) => tasks.noteDeck(taskId, ref),
    gate: (gateId) => gates.get(gateId),
    onLogEvent: (draft) => {
      agora.appendLog(draft)
      agora.commitSoon(`odeon ${String(draft['event'] ?? 'event')}`)
    }
  })

  const gymnasium = new Gymnasium({
    agoraRoot: agora.root,
    // A fixture archive, not the repo's real one: it grows every week, and a
    // scenario that broke because the company filed another proposal would be
    // testing the wrong thing (FR-12.6 continuity is asserted in the unit
    // suite, against the real archive, on purpose).
    seedFrom: path.join(REPO, 'test', 'fixtures', 'gymnasium-seed'),
    onLogEvent: (draft) => agora.appendLog(draft)
  })

  const briefing = new BriefingJob({
    prompts,
    gather: (sinceSeq) => ({
      events: agora.readLog().filter((entry) => entry.seq > sinceSeq),
      ledger: tasks.tasks(),
      openGates: gates.list().map((gate) => ({ id: gate.id, agentId: gate.agentId })),
      openMemos: odeon.memos('open').map((memo) => ({ memoId: memo.memoId })),
      spend: []
    }),
    orchestrator: () => 'agent.artemis',
    deliver: (message) => hermes.deliverFromHarness(message),
    onLogEvent: (draft) => agora.appendLog(draft)
  })

  const meetings = new MeetingDriver({
    agoraRoot: agora.root,
    prompts,
    deliver: (message) => hermes.deliverFromHarness(message),
    orchestrator: () => 'agent.artemis',
    onLogEvent: (draft) => agora.appendLog(draft)
  })

  const org = new OrgLayer({
    agoraRoot: agora.root,
    gather: () => ({
      events: agora.readLog(),
      // The agents this company actually has. A rig hire makes a mailbox
      // rather than a roster row, so reading the registry here would report
      // metrics for nobody.
      agents: [...hermes.knownAgents()].sort(),
      spend: []
    }),
    onLogEvent: (draft) => agora.appendLog(draft)
  })

  /** What the memo triage did, so a scenario can assert the bench it chose. */
  const triaged: string[] = []

  // The SHIPPED endpoint dispatch, not a copy of it.
  const odeonEndpoint = wireOdeonEndpoint({
    odeon,
    gymnasium,
    briefing,
    prompts,
    mayDecide: (request) =>
      options.mayDecide?.(request) ?? {
        allowed: false as const,
        because: `no delegated authority for memo/${request.domain}`
      },
    triageMemo: (memoId, trigger) => {
      const may = options.mayDecide?.({ class: 'memo', domain: trigger })
      triaged.push(`${memoId}:${may?.allowed === true ? 'delegated' : 'escalated'}`)
    },
    applyMemoVerdict: (input) => {
      gates.decide(input.gateId, input.gateVerdict)
    }
  })

  const hermes = new Hermes({
    agora,
    prompts,
    closing: (message) => closingRef?.noteReply(message) ?? false,
    odeon: (message) => {
      // A meeting reply is an `inform`, not a filing — exactly as `index.ts`
      // routes it.
      if (message.act === 'inform') {
        const outcome = meetings.say(message.from, message.body)
        return {
          ok: outcome.kind !== 'refused',
          subject: `meeting: ${outcome.kind}`,
          body: JSON.stringify(outcome)
        }
      }
      return odeonEndpoint(message)
    },
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

  // The durable cost plane (ADR-0011). The store is the seam SQLite sits behind
  // in production — `better-sqlite3` is Electron-ABI and cannot load here — and
  // handing the SAME store to a second `startCompany` is what S-LEDGER's
  // "restart" means: the harness objects are rebuilt, the rows are not.
  const ledgerStore = options.ledgerStore ?? new MemoryLedgerStore()
  const costs = new CostLedger({ store: ledgerStore })
  const budgets = new BudgetWatcher({
    ledger: costs,
    agents: () => budgetedAgents,
    onBudgetChange: (agentId, verdict) =>
      agora.appendLog({ kind: 'budget', agentId, state: verdict.state }),
    onDegraded: () => {}
  })
  const budgetedAgents: BudgetedAgent[] = []

  const closing = new ClosingTime({
    liveAgents: () => hermes.knownAgents(),
    deliver: (message) => hermes.deliverFromHarness(message),
    render: (kind, vars) =>
      prompts.render(path.join('hermes', `closing-time-${kind}.md`), vars).trim(),
    onLogEvent: (draft) => {
      agora.appendLog(draft)
      agora.commitSoon(`shutdown ${String(draft['event'] ?? 'event')}`)
    },
    ...(options.closingDeadlineMs === undefined ? {} : { deadlineMs: options.closingDeadlineMs })
  })
  closingRef = closing

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
        // SDD §7.3 step 1, wired as `index.ts` wires it: a choice matching memo
        // policy is HELD before it lands, off the same tool stream.
        chokePoints.submitMemoTrigger(record.envelope.agentId, {
          tool,
          ...(typeof payload?.['path'] === 'string' ? { path: payload['path'] } : {}),
          ...(typeof payload?.['file_path'] === 'string' ? { path: payload['file_path'] } : {}),
          ...(typeof payload?.['command'] === 'string' ? { text: payload['command'] } : {})
        })
      }
      if (tool !== null && record.envelope.event === 'post-tool') {
        breaker.closeSpan(
          record.envelope.agentId,
          tool,
          payload?.['error'] === undefined ? 'ok' : 'error'
        )
        breaker.evaluate(record.envelope.agentId)
      }
      // GYM-002: a steer the evaluate above just queued rides this same reply.
      const steerReply = steerNotes.answer(record.envelope.agentId, record.envelope.event)
      if (steerReply) return steerReply
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
  const sessions = new Map<string, string>()

  return {
    home,
    agora,
    tasks,
    odeon,
    gymnasium,
    briefing,
    meetings,
    org,
    triaged,
    hermes,
    hookServer,
    hookEvents,
    gates,
    chokePoints,
    breaker,
    breakerActs,
    closing,
    ledgerStore,
    costs,

    async foldSpend(agent, cwd) {
      budgetedAgents.splice(0, budgetedAgents.length, agent)
      await budgets.foldNow(agent)
      void cwd
    },

    async runTurnIn(agentId, cwd, steps, env) {
      fs.mkdirSync(cwd, { recursive: true })
      const script = path.join(home, `${agentId}-${Date.now()}-${Math.random()}.json`)
      fs.writeFileSync(script, JSON.stringify({ schemaVersion: 1, steps }), 'utf8')
      return new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [FAKE_ENGINE_CLI, '--script', script], {
          cwd,
          env: {
            ...process.env,
            EPH_AGENT_ID: agentId,
            EPH_AGENT_DIR: agora.agentDir(agentId),
            EPH_HOOK_TOKEN: tokens.get(agentId) ?? '',
            EPH_HOOK_ENDPOINT: hookServer.endpoint() ?? '',
            EPH_FAKE_SESSION: sessions.get(agentId) ?? `sess-${agentId}`,
            ...(env ?? {})
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

    hire(agentId, sessionId) {
      hermes.ensureMailbox(agentId)
      const token = `token-${agentId}`
      tokens.set(agentId, token)
      const session = sessionId ?? `sess-${agentId}-c${String(companyIndex)}`
      sessions.set(agentId, session)
      hookServer.registerSpawn(agentId, token)
      // The event plane is where the ledger learns a spawn's session id
      // (ADR-0002), so the same attribution key drives both planes.
      costs.noteSession(agentId, session)
    },

    sessionOf(agentId) {
      return sessions.get(agentId) ?? `sess-${agentId}-c${String(companyIndex)}`
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
      budgets.stop()
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
