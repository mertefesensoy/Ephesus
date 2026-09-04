import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentManager } from '../../src/main/agents'
import { EngineRegistry } from '../../src/main/engines'
import { ExecGitRunner, Worktrees } from '../../src/main/git'
import { HookServer } from '../../src/main/hooks'
import { PromptStore } from '../../src/main/prompts'
import type { AgentCard } from '../../src/shared/agents'
import { makeFakeAdapter } from '../fakes/fake-adapter'
import { ProcessSpawner } from '../fakes/process-spawner'
import { removeTempDir } from '../tmpdir'

/**
 * The lifecycle half of worktree isolation (SRS UC-01 alternate 2a): a spawn
 * that asks for it works in its own checkout, and what happens to that checkout
 * when the agent dies.
 *
 * Real git, real repositories, real child processes. The thing under test is
 * where files land, and a mock cannot get that wrong in the way that matters.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const AGENT = 'agent.mason'
const temps: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

interface Rig {
  readonly home: string
  readonly target: string
  readonly agents: AgentManager
  readonly spawner: ProcessSpawner
  readonly cards: AgentCard[]
  readonly errors: { agentId: string; message: string }[]
  readonly logs: Record<string, unknown>[]
  readonly script: (steps: readonly unknown[]) => void
}

async function startRig(options: { readonly isolationConfigured?: boolean } = {}): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-agent-wt-'))
  temps.push(home)
  const target = path.join(home, 'target-repo')
  fs.mkdirSync(target, { recursive: true })
  const git = (args: readonly string[]): void => {
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd: target })
  }
  git(['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(target, 'README.md'), '# target\n', 'utf8')
  git(['add', '.'])
  git(['commit', '-qm', 'initial'])

  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))
  const agoraRoot = path.join(home, 'agora')
  fs.mkdirSync(agoraRoot, { recursive: true })
  fs.writeFileSync(path.join(agoraRoot, 'PROTOCOL.md'), '# protocol\n\nrules\n', 'utf8')

  const scriptPath = path.join(home, 'script.json')
  const script = (steps: readonly unknown[]): void => {
    fs.writeFileSync(scriptPath, JSON.stringify({ schemaVersion: 1, steps }), 'utf8')
  }
  script([
    { kind: 'stdout', text: 'RUNNING\n' },
    { kind: 'wait', ms: 60_000 }
  ])

  const engines = new EngineRegistry()
  engines.register(makeFakeAdapter({ scriptPath }))
  const hookServer = new HookServer({ onEvent: () => undefined, onRejected: () => undefined })
  await hookServer.start(home)

  const worktrees = new Worktrees({
    runner: new ExecGitRunner(),
    forbiddenRoot: agoraRoot
  })
  const spawner = new ProcessSpawner()
  const cards: AgentCard[] = []
  const errors: { agentId: string; message: string }[] = []
  const logs: Record<string, unknown>[] = []
  const agents = new AgentManager({
    engines,
    hookServer,
    spawner,
    prompts,
    agoraRoot,
    // Omitted entirely when the test is about a harness that cannot isolate:
    // an optional seam left unwired is a real deployment, not a hypothetical.
    ...(options.isolationConfigured === false
      ? {}
      : {
          worktrees: {
            pathFor: (agentId) => path.join(home, 'worktrees', agentId),
            branchFor: (agentId) => `agent/${agentId.replace(/^agent\./, '')}`,
            create: (plan) => worktrees.create(plan),
            remove: (repo, worktreePath) => worktrees.remove(repo, worktreePath)
          }
        }),
    onChange: (card) => cards.push(card),
    onLogEvent: (draft) => logs.push(draft),
    onExitError: (agentId, err) =>
      errors.push({ agentId, message: err instanceof Error ? err.message : String(err) })
  })

  closers.push(async () => {
    spawner.killAll()
    await hookServer.stop()
  })
  const rig = { home, target, agents, spawner, cards, errors, logs, script }
  live = rig
  return rig
}

function request(
  rig: Rig,
  worktree: boolean,
  over: Partial<Parameters<AgentManager['spawn']>[0]> = {}
): Parameters<AgentManager['spawn']>[0] {
  return {
    agentId: AGENT,
    name: 'Mason',
    role: 'engineer',
    engine: 'custom' as const,
    cwd: rig.target,
    capabilities: [],
    envGrants: [],
    ...(worktree ? { worktree: true } : {}),
    ...over
  }
}

/**
 * The rig whose processes a timeout should describe.
 *
 * Module-level rather than threaded through `until`, which is called ten times
 * in this file: passing a diagnosis to each would bury the point in mechanical
 * edits. Safe because vitest runs the tests within one file sequentially, so
 * exactly one rig is live, and `startRig` reassigns this on every test.
 */
let live: Rig | null = null

/**
 * Waits for `predicate`, and on timeout says what the processes were doing.
 *
 * The bare version of this message — `timed out waiting for the agent to start`
 * — is what four tests in this file reported while a quoting bug in the version
 * probe sent every spawn down the FR-1.6 install branch. It named nothing, and
 * the spawner was discarding the one line that did.
 */
async function until(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const detail = live === null ? '' : `\n${live.spawner.diagnose()}`
  throw new Error(`worktree: timed out waiting for ${label}${detail}`)
}

describe('a spawn that asks for isolation (UC-01 alternate 2a)', () => {
  it('works in its own checkout, on its own branch, leaving the target clean', async () => {
    const rig = await startRig()
    const card = await rig.agents.spawn(request(rig, true))

    expect(card.worktree).not.toBeNull()
    expect(card.worktree?.branch).toBe('agent/mason')
    expect(card.worktree?.branchCreated).toBe(true)
    // Everything downstream follows the cwd: the process really runs there.
    expect(card.cwd).toBe(card.worktree?.path)
    expect(fs.existsSync(path.join(card.cwd, 'README.md'))).toBe(true)

    // The settings the adapter installed went into the WORKTREE…
    await until(
      () => fs.existsSync(path.join(card.cwd, '.fake-engine', 'settings.local.json')),
      'settings installed in the worktree'
    )
    // …and not into the Architect's own checkout.
    expect(fs.existsSync(path.join(rig.target, '.fake-engine'))).toBe(false)
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: rig.target, encoding: 'utf8' })
    ).toBe('')

    const isolated = rig.logs.find((entry) => typeof entry['worktree'] === 'string')
    expect(isolated?.['branch']).toBe('agent/mason')
    expect(isolated?.['repo']).toBe(rig.target)
  }, 30_000)

  it('gives the clean checkout back when the agent dies', async () => {
    const rig = await startRig()
    const card = await rig.agents.spawn(request(rig, true))
    const worktreePath = card.cwd
    await until(() => rig.spawner.stdoutOf(AGENT).includes('RUNNING'), 'the agent to start')

    rig.spawner.kill(AGENT)
    await until(() => rig.agents.card(AGENT).lifecycle === 'exited', 'the agent to be reaped')
    await until(() => !fs.existsSync(worktreePath), 'the worktree to be released')

    const released = rig.logs.find((entry) => entry['worktreeRemoved'] === true)
    expect(released?.['worktree']).toBe(worktreePath)
    expect(rig.errors).toEqual([])
  }, 30_000)

  it('KEEPS a dirty checkout, and says so out loud', async () => {
    const rig = await startRig()
    const card = await rig.agents.spawn(request(rig, true))
    const worktreePath = card.cwd
    await until(() => rig.spawner.stdoutOf(AGENT).includes('RUNNING'), 'the agent to start')
    fs.writeFileSync(path.join(worktreePath, 'unpushed.md'), '# half a day\n', 'utf8')

    rig.spawner.kill(AGENT)
    await until(() => rig.agents.card(AGENT).lifecycle === 'exited', 'the agent to be reaped')
    await until(() => rig.errors.length > 0, 'the refusal to be reported')

    expect(fs.readFileSync(path.join(worktreePath, 'unpushed.md'), 'utf8')).toBe('# half a day\n')
    expect(rig.errors[0]?.message).toContain('uncommitted change')
    const kept = rig.logs.find((entry) => entry['worktreeRemoved'] === false)
    expect(String(kept?.['changes'])).toContain('unpushed.md')
  }, 30_000)

  it('puts a respawned agent back on the same branch', async () => {
    const rig = await startRig()
    await rig.agents.spawn(request(rig, true))
    await until(() => rig.spawner.stdoutOf(AGENT).includes('RUNNING'), 'the agent to start')
    rig.spawner.kill(AGENT)
    await until(() => rig.agents.card(AGENT).lifecycle === 'exited', 'the agent to be reaped')

    const back = await rig.agents.respawn(AGENT)
    expect(back.worktree?.branch).toBe('agent/mason')
    // The branch existed already, so this one was reused rather than created.
    expect(back.worktree?.branchCreated).toBe(false)
    expect(fs.existsSync(path.join(back.cwd, 'README.md'))).toBe(true)
  }, 30_000)

  it('a spawn that does NOT ask for isolation works in the target repo', async () => {
    const rig = await startRig()
    const card = await rig.agents.spawn(request(rig, false))

    expect(card.worktree).toBeNull()
    expect(card.cwd).toBe(rig.target)
    expect(fs.existsSync(path.join(rig.home, 'worktrees'))).toBe(false)
  }, 30_000)
})

/**
 * B10 (M8.6), and the Architect's decision of 2026-09-04: **a spawn that asks
 * for isolation and cannot have it is REFUSED.**
 *
 * This used to log the failure and continue in the Architect's own checkout,
 * on the reasoning that "isolation is a nicety". The fallback is the harm: an
 * agent that asked to be kept out of somebody's working copy and was silently
 * put into it is the one register item that can destroy uncommitted work.
 */
describe('isolation that cannot be provided refuses the hire', () => {
  it('refuses when the target is not a git repository, and names why', async () => {
    const rig = await startRig()
    const notARepo = path.join(rig.home, 'just-a-folder')
    fs.mkdirSync(notARepo, { recursive: true })
    fs.writeFileSync(path.join(notARepo, 'work.md'), '# the architect was here\n', 'utf8')

    await expect(rig.agents.spawn(request(rig, true, { cwd: notARepo }))).rejects.toThrow(
      /asked for an isolated worktree and did not get one/
    )
    // The refusal carries git's own account of the problem rather than ours.
    const refusal = rig.logs.find((entry) => entry['worktree'] === null)
    expect(String(refusal?.['because'])).toContain('not a git repository')
    // Nothing was written where the agent would have run.
    expect(fs.readdirSync(notARepo)).toEqual(['work.md'])
  }, 30_000)

  it('releases the agent id, so the Architect can fix it and try again', async () => {
    const rig = await startRig()
    const notARepo = path.join(rig.home, 'folder-2')
    fs.mkdirSync(notARepo, { recursive: true })
    await expect(rig.agents.spawn(request(rig, true, { cwd: notARepo }))).rejects.toThrow()

    // A phantom agent holding the name would make the retry fail with "already
    // starting" and leave the Architect with nothing to do about it.
    expect(rig.agents.list().map((card) => card.agentId)).not.toContain(AGENT)
    const card = await rig.agents.spawn(request(rig, true))
    expect(card.worktree).not.toBeNull()
  }, 30_000)

  it('refuses when the harness has no worktree support wired at all', async () => {
    const rig = await startRig({ isolationConfigured: false })
    await expect(rig.agents.spawn(request(rig, true))).rejects.toThrow(/is not configured/)
    expect(fs.existsSync(path.join(rig.target, '.fake-engine'))).toBe(false)
  }, 30_000)

  it('refuses a respawn that cannot restore the isolation, leaving it exited', async () => {
    const rig = await startRig()
    const card = await rig.agents.spawn(request(rig, true))
    const worktreePath = card.cwd
    await until(() => rig.spawner.stdoutOf(AGENT).includes('RUNNING'), 'the agent to start')
    rig.spawner.kill(AGENT)
    await until(() => rig.agents.card(AGENT).lifecycle === 'exited', 'the agent to be reaped')
    await until(() => !fs.existsSync(worktreePath), 'the worktree to be released')

    // Something else now owns the path the worktree would take.
    fs.mkdirSync(worktreePath, { recursive: true })
    fs.writeFileSync(path.join(worktreePath, 'squatter.txt'), 'not a worktree\n', 'utf8')

    await expect(rig.agents.respawn(AGENT)).rejects.toThrow(/cannot be respawned without its/)
    // Back where it was — a respawn into the Architect's checkout is not a
    // respawn, it is the fallback this package removed.
    expect(rig.agents.card(AGENT).lifecycle).toBe('exited')
    expect(rig.agents.card(AGENT).cwd).not.toBe(rig.target)
  }, 30_000)
})

describe('concurrent hires never touch the target checkout', () => {
  it('gives two simultaneous agents two checkouts and leaves the target clean', async () => {
    // The B10 scenario in one test: a profile activation hires several agents
    // at once, and until M8.6 every one of them ran git operations and file
    // edits in the Architect's own working copy, concurrently.
    const rig = await startRig()
    const second = 'agent.hera'
    const [a, b] = await Promise.all([
      rig.agents.spawn(request(rig, true)),
      rig.agents.spawn(request(rig, true, { agentId: second, name: 'Hera' }))
    ])

    expect(a.cwd).not.toBe(b.cwd)
    expect(a.cwd).not.toBe(rig.target)
    expect(b.cwd).not.toBe(rig.target)
    expect(a.worktree?.branch).toBe('agent/mason')
    expect(b.worktree?.branch).toBe('agent/hera')

    await until(
      () =>
        fs.existsSync(path.join(a.cwd, '.fake-engine', 'settings.local.json')) &&
        fs.existsSync(path.join(b.cwd, '.fake-engine', 'settings.local.json')),
      'both agents to install their settings'
    )
    // The claim that matters, stated about the filesystem rather than about a
    // flag: the Architect's checkout has nothing in it that was not there.
    expect(fs.existsSync(path.join(rig.target, '.fake-engine'))).toBe(false)
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: rig.target, encoding: 'utf8' })
    ).toBe('')
  }, 40_000)
})
