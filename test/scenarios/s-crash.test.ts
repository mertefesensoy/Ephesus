import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentManager } from '../../src/main/agents'
import { Agora } from '../../src/main/agora'
import { HookServer } from '../../src/main/hooks'
import { LedgerEndpoint } from '../../src/main/ledger'
import { Library } from '../../src/main/library'
import { PromptStore } from '../../src/main/prompts'
import { AvatarDirector } from '../../src/main/avatars'
import { EngineRegistry } from '../../src/main/engines'
import type { AgentCard } from '../../src/shared/agents'
import type { LogEntry } from '../../src/shared/log'
import type { AvatarSnapshot } from '../../src/shared/avatar'
import { GHOST_ARCHIVE_MS } from '../../src/shared/avatar'
import { composeMessage, makeMessageId } from '../../src/shared/message'
import { makeFakeAdapter } from '../fakes/fake-adapter'
import { ProcessSpawner } from '../fakes/process-spawner'

/**
 * **S-CRASH** (TEST-STRATEGY §3): "SIGKILL a fake agent mid-task; ghost →
 * archive, task back to `todo`, respawn offer; resume path where adapter
 * supports it."
 *
 * Every seam here is the shipped one — a real Agora with real git in a temp
 * home, a real hook socket, a real `AgentManager` over real child processes,
 * the real `LedgerEndpoint`, the real `Library`, the real avatar clock. The
 * agent is the fake engine, and it is really killed: `SIGKILL`, not a
 * cooperative exit. The whole point of the scenario is what the harness does
 * when a process dies without being asked, so a stubbed spawner would prove
 * nothing.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
/** The engine session this fake reports — the id a resume has to come back to. */
const SESSION = 'sess-mason-1'
/**
 * Generous, because these cases do real work: `git init` in a temp home, a real
 * hook socket, and real child processes started and killed. Vitest's 5 s default
 * is a flake source on a loaded CI runner, not a useful assertion.
 */
const SCENARIO_TIMEOUT_MS = 30_000
const AGENT = 'agent.mason'
const ORCHESTRATOR = 'agent.artemis'

interface Rig {
  readonly home: string
  readonly target: string
  readonly agora: Agora
  readonly agents: AgentManager
  readonly spawner: ProcessSpawner
  readonly library: Library
  readonly ledger: LedgerEndpoint
  readonly avatars: AvatarDirector
  readonly hookServer: HookServer
  readonly cards: AgentCard[]
  readonly hookEvents: readonly { agentId: string; event: string; sessionId: string | null }[]
  readonly log: () => readonly LogEntry[]
  readonly avatarOf: () => AvatarSnapshot | null
  readonly tickAvatars: (advanceMs: number) => void
  readonly script: (steps: readonly unknown[]) => void
  close(): Promise<void>
}

const rigs: Rig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close()
})

async function startRig(options: { resumable?: boolean } = {}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-s-crash-'))
  const target = path.join(home, 'target-repo')
  fs.mkdirSync(target, { recursive: true })
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))

  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  await agora.ensureRepo()

  const library = new Library({ agoraRoot: agora.pathOf(), prompts })
  const ledger = new LedgerEndpoint({
    store: agora,
    knownAgents: () => [AGENT, ORCHESTRATOR],
    onLogEvent: (draft) => agora.appendLog(draft)
  })

  // The event plane is where the harness learns a spawn's session id (ADR-0002)
  // — the same wiring `index.ts` has, because it is what makes resume reachable.
  let agents: AgentManager | null = null
  const hookEvents: { agentId: string; event: string; sessionId: string | null }[] = []
  const hookServer = new HookServer({
    onEvent: (record) => {
      const { envelope } = record
      hookEvents.push({
        agentId: envelope.agentId,
        event: envelope.event,
        sessionId: envelope.sessionId
      })
      if (envelope.sessionId) agents?.noteSession(envelope.agentId, envelope.sessionId)
      return undefined
    },
    onRejected: () => undefined
  })
  await hookServer.start(home)

  // The fake engine's script file is rewritten between spawns, the way a real
  // engine's next turn differs from its last.
  const scriptPath = path.join(home, 'script.json')
  const script = (steps: readonly unknown[]): void => {
    fs.writeFileSync(scriptPath, JSON.stringify({ schemaVersion: 1, steps }), 'utf8')
  }
  script([])

  const engines = new EngineRegistry()
  const fake = makeFakeAdapter({ scriptPath, sessionId: SESSION })
  // ADR-0009 makes `resume` optional, and the honest offer for an engine
  // without it has to say so. Dropping it here is how one rig covers both
  // engine tiers without a second fake CLI.
  engines.register(options.resumable === false ? { ...fake, resume: undefined } : fake)

  let clock = Date.now()
  const avatars = new AvatarDirector({ onChange: () => undefined, now: () => clock })

  const spawner = new ProcessSpawner()
  const cards: AgentCard[] = []
  agents = new AgentManager({
    engines,
    hookServer,
    spawner,
    prompts,
    agoraRoot: agora.pathOf(),
    memory: {
      seed: (agentId) => library.seed(agentId),
      layer: (agentId) => library.layer(agentId)
    },
    returnTasks: (agentId, because) => ledger.returnTasksOf(agentId, because),
    onChange: (card) => {
      cards.push(card)
      if (card.lifecycle === 'running' && !avatars.get(card.agentId)) avatars.add(card.agentId)
    },
    onLogEvent: (draft) => agora.appendLog(draft),
    onRosterChange: (agentId, entry) => {
      const registry = agora.registry()
      const roster = { ...registry.agents }
      if (entry) roster[agentId] = entry
      else delete roster[agentId]
      agora.writeRegistry({ ...registry, agents: roster })
    }
  })
  spawner.onExit((id) => avatars.handleExit(id))

  const rig: Rig = {
    home,
    target,
    agora,
    agents,
    spawner,
    library,
    ledger,
    avatars,
    hookServer,
    cards,
    hookEvents,
    log: () => agora.readLog(0, 1_000),
    avatarOf: () => avatars.get(AGENT),
    tickAvatars: (advanceMs) => {
      clock += advanceMs
      avatars.tick()
    },
    script,
    async close() {
      spawner.killAll()
      avatars.stop()
      await hookServer.stop()
      await agora.drained().catch(() => {})
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
  rigs.push(rig)
  return rig
}

/** Files a task through the real endpoint and puts it in flight. */
function assignInFlightTask(rig: Rig, taskId: string): void {
  const propose = (body: unknown): void => {
    const outcome = rig.ledger.submit(
      composeMessage({
        id: makeMessageId(new Date(), 'crash'),
        conversation: 'conv-crash',
        in_reply_to: null,
        from: ORCHESTRATOR,
        to: 'agent.ledger',
        act: 'propose',
        subject: 'ledger',
        body: JSON.stringify(body),
        hops: 0,
        created_at: new Date().toISOString()
      })
    )
    expect(outcome.ok).toBe(true)
  }
  propose({
    schemaVersion: 1,
    ops: [
      {
        op: 'create',
        task: {
          id: taskId,
          title: 'Fix the flaky checkout test',
          spec: 'The checkout suite fails under load. Find out why and fix it.',
          assignee: AGENT,
          priority: 1
        }
      }
    ]
  })
  propose({
    schemaVersion: 1,
    ops: [{ op: 'update', id: taskId, patch: { status: 'in_progress' } }]
  })
}

async function until(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`s-crash: timed out waiting for ${label}`)
}

function spawnRequest(rig: Rig): Parameters<AgentManager['spawn']>[0] {
  return {
    agentId: AGENT,
    name: 'Mason',
    role: 'engineer',
    engine: 'custom' as const,
    cwd: rig.target,
    capabilities: ['code'],
    envGrants: []
  }
}

describe('S-CRASH — SIGKILL mid-task (TEST-STRATEGY §3, SDD §10)', () => {
  it(
    'ghosts, archives, returns the task, and offers a respawn that carries memory',
    async () => {
      const rig = await startRig()
      const taskId = 't-crash-001'
      assignInFlightTask(rig, taskId)

      // A turn that gets somewhere and then hangs: it reports a session, learns
      // something and writes it down, then sits in a long tool call.
      rig.script([
        { kind: 'hook', event: 'session-start', payload: {} },
        { kind: 'hook', event: 'pre-tool', payload: { tool: 'Edit' } },
        {
          kind: 'append-memory',
          at: '2026-08-27',
          body: 'The checkout test is flaky because the fixture seeds two carts.'
        },
        { kind: 'stdout', text: 'MID-TASK\n' },
        { kind: 'wait', ms: 60_000 }
      ])

      const card = await rig.agents.spawn(spawnRequest(rig))
      expect(card.lifecycle).toBe('running')
      await until(() => rig.spawner.stdoutOf(AGENT).includes('MID-TASK'), 'the agent to start work')
      await until(
        () => rig.library.sections(AGENT).some((s) => s.date === '2026-08-27'),
        'the agent to write its memory'
      )
      // The event plane saw a session, which is what makes resume possible.
      await until(() => rig.agents.spawnOf(AGENT)?.sessionIds.length === 1, 'a session id')

      // ── The crash.
      expect(rig.spawner.has(AGENT)).toBe(true)
      rig.spawner.kill(AGENT)
      await until(() => rig.agents.card(AGENT).lifecycle === 'exited', 'the agent to be reaped')

      // ── ghost
      const dead = rig.agents.card(AGENT)
      expect(dead.exitCode).toBe(-1)
      expect(rig.avatarOf()?.phase).toBe('ghost')
      expect(rig.agora.registry().agents[AGENT]?.status).toBe('ghost')

      // ── the respawn offer, every field a fact
      const offer = dead.respawnOffer
      expect(offer).not.toBeNull()
      expect(offer?.resumable).toBe(true)
      expect(offer?.memorySections).toBe(1)
      expect(offer?.tasksReturned).toEqual([taskId])

      // ── the task is back on the board, with the note in the book of record
      const task = rig.ledger.tasks().tasks.find((t) => t.id === taskId)
      expect(task?.status).toBe('todo')
      expect(task?.assignee).toBe(AGENT)
      const returned = rig
        .log()
        .find((entry) => entry.kind === 'task' && entry['event'] === 'returned')
      expect(returned?.['taskId']).toBe(taskId)
      expect(returned?.['because']).toBe('agent-exit')
      expect(returned?.['from']).toBe('in_progress')
      expect(returned?.['to']).toBe('todo')

      const ghost = rig.log().find((entry) => entry.kind === 'ghost')
      expect(ghost?.['agentId']).toBe(AGENT)
      expect(ghost?.['resumable']).toBe(true)
      expect(ghost?.['tasksReturned']).toEqual([taskId])

      // ── archive: the avatar clock owns the 30 s timer, the roster mirrors it
      rig.tickAvatars(GHOST_ARCHIVE_MS + 1)
      expect(rig.avatarOf()?.phase).toBe('archived')
      rig.agents.archive(AGENT)
      expect(rig.agora.registry().agents[AGENT]?.status).toBe('archived')

      // ── the respawn, and what it carries
      rig.script([
        { kind: 'hook', event: 'session-start', payload: {} },
        { kind: 'echo-env', name: 'EPH_IDENTITY' },
        { kind: 'wait', ms: 60_000 }
      ])
      const back = await rig.agents.respawn(AGENT)
      expect(back.lifecycle).toBe('running')
      expect(back.respawnOffer).toBeNull()

      await until(
        () => rig.spawner.stdoutOf(AGENT).includes('EPH_IDENTITY='),
        'the respawned agent to report its context'
      )
      // The agent itself reports what it was handed — FR-6.1's "memory survives
      // process death and respawn", asserted from inside the new session.
      const reported = rig.spawner.stdoutOf(AGENT)
      expect(reported).toContain('the fixture seeds two carts')
      expect(reported).toContain('Company protocol')

      const respawnLog = rig
        .log()
        .find((entry) => entry.kind === 'spawn' && entry['respawn'] === true)
      expect(respawnLog?.['memoryCarried']).toBe(true)
      expect(respawnLog?.['resumed']).toBe(true)
      expect(respawnLog?.['sessionId']).toBe(SESSION)

      // The resume argv actually reached the engine: the new process reports
      // its hooks on the SAME session id, not on a fresh one.
      await until(
        () => rig.hookEvents.filter((event) => event.event === 'session-start').length === 2,
        'the resumed session to report in'
      )
      expect(
        rig.hookEvents.filter((event) => event.sessionId === SESSION).length
      ).toBeGreaterThanOrEqual(2)
    },
    SCENARIO_TIMEOUT_MS
  )

  it(
    'promises nothing it cannot deliver: no resume, no memory, no tasks',
    async () => {
      const rig = await startRig({ resumable: false })
      rig.script([
        { kind: 'hook', event: 'session-start', payload: {} },
        { kind: 'stdout', text: 'RUNNING\n' },
        { kind: 'wait', ms: 60_000 }
      ])
      await rig.agents.spawn(spawnRequest(rig))
      await until(() => rig.spawner.stdoutOf(AGENT).includes('RUNNING'), 'the agent to start')
      await until(() => rig.agents.spawnOf(AGENT)?.sessionIds.length === 1, 'a session id')

      rig.spawner.kill(AGENT)
      await until(() => rig.agents.card(AGENT).lifecycle === 'exited', 'the agent to be reaped')

      // A session was reported, but this engine cannot reopen one — so the offer
      // says `resumable: false` rather than implying a continuity that is not
      // there (ADR-0009; the M3.7 rule, now visible on the card).
      const offer = rig.agents.card(AGENT).respawnOffer
      expect(offer?.resumable).toBe(false)
      expect(offer?.memorySections).toBe(0)
      expect(offer?.tasksReturned).toEqual([])

      // And a respawn without resume still respawns; the log says which is which.
      rig.script([
        { kind: 'echo-env', name: 'EPH_IDENTITY' },
        { kind: 'wait', ms: 60_000 }
      ])
      await rig.agents.respawn(AGENT)
      const respawnLog = rig
        .log()
        .find((entry) => entry.kind === 'spawn' && entry['respawn'] === true)
      expect(respawnLog?.['resumed']).toBe(false)
      expect(respawnLog?.['memoryCarried']).toBe(false)
    },
    SCENARIO_TIMEOUT_MS
  )

  it(
    'leaves the target repo exactly as it found it',
    async () => {
      const rig = await startRig()
      const settings = path.join(rig.target, '.fake-engine', 'settings.local.json')
      fs.mkdirSync(path.dirname(settings), { recursive: true })
      fs.writeFileSync(settings, '{"architect":"own settings"}\n', 'utf8')

      rig.script([{ kind: 'wait', ms: 60_000 }])
      await rig.agents.spawn(spawnRequest(rig))
      await until(
        () => fs.readFileSync(settings, 'utf8').includes('hookCommand'),
        'settings install'
      )

      rig.spawner.kill(AGENT)
      await until(() => rig.agents.card(AGENT).lifecycle === 'exited', 'the agent to be reaped')
      // A crash must not leave the Architect's working copy modified behind their
      // back (ADR-0009 uninstall restores byte-for-byte).
      expect(fs.readFileSync(settings, 'utf8')).toBe('{"architect":"own settings"}\n')
    },
    SCENARIO_TIMEOUT_MS
  )
})
