import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Agora, PROTOCOL_REL, commitMessage, type FaultPoint } from '../../src/main/agora'
import { ExecGitRunner, type GitResult, type GitRunner } from '../../src/main/git'
import { PromptStore } from '../../src/main/prompts'

/**
 * Integration against **real git in temp dirs** (TEST-STRATEGY §2): the
 * committer's whole job is surviving what real git does — locks, empty commits,
 * a repo interrupted mid-write — so mocking git would test nothing that matters.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-agora-'))
  temps.push(dir)
  return dir
}

function makePrompts(root: string): PromptStore {
  return new PromptStore(path.join(root, 'prompts'), BUNDLED_PROMPTS)
}

interface Rig {
  readonly agora: Agora
  readonly root: string
  readonly home: string
}

function rig(options: Partial<Parameters<typeof makeAgora>[1]> = {}): Rig {
  const home = tempRoot()
  const root = path.join(home, 'agora')
  return { agora: makeAgora(home, options), root, home }
}

function makeAgora(
  home: string,
  options: {
    git?: GitRunner
    faults?: (point: FaultPoint) => void | Promise<void>
    maxAttempts?: number
    backoffMs?: number
  } = {}
): Agora {
  return new Agora({
    root: path.join(home, 'agora'),
    prompts: makePrompts(home),
    backoffMs: 1,
    ...options
  })
}

/** Wraps a runner to record invocations and prove they never overlap. */
class RecordingGit implements GitRunner {
  readonly calls: string[] = []
  private inFlight = 0
  maxConcurrent = 0

  constructor(private readonly inner: GitRunner = new ExecGitRunner()) {}

  async run(cwd: string, args: readonly string[]): Promise<GitResult> {
    this.calls.push(args.join(' '))
    this.inFlight += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight)
    try {
      return await this.inner.run(cwd, args)
    } finally {
      this.inFlight -= 1
    }
  }
}

describe('Agora — repository setup (ADR-0004, SDD §2)', () => {
  it('initialises the repo and seeds the agent-facing protocol', async () => {
    const { agora, root } = rig()
    await agora.ensureRepo()

    expect(fs.existsSync(path.join(root, '.git'))).toBe(true)
    expect(fs.readFileSync(path.join(root, PROTOCOL_REL), 'utf8')).toContain('Company protocol')
    expect(await agora.head()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('is idempotent — a second boot neither re-inits nor loses history', async () => {
    const { agora } = rig()
    await agora.ensureRepo()
    const first = await agora.head()

    await agora.ensureRepo()

    expect(await agora.head()).toBe(first)
  })

  it('commits under the harness identity, not the machine global one', async () => {
    const { agora, root } = rig()
    await agora.ensureRepo()

    const runner = new ExecGitRunner()
    const author = await runner.run(root, ['log', '-1', '--format=%an <%ae>'])
    expect(author.stdout.trim()).toBe('Ephesus <harness@ephesus.local>')
  })
})

describe('Agora — the single committer queue', () => {
  it('never runs two git commands at once, however many callers there are', async () => {
    const home = tempRoot()
    const git = new RecordingGit()
    const agora = makeAgora(home, { git })
    await agora.ensureRepo()

    await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        fs.writeFileSync(path.join(home, 'agora', `f${i}.txt`), `${i}`, 'utf8')
        return agora.commit(`write f${i}`)
      })
    )

    expect(git.maxConcurrent).toBe(1)
  })

  it('batches work enqueued while a commit is in flight', async () => {
    const { agora, root } = rig()
    await agora.ensureRepo()

    fs.writeFileSync(path.join(root, 'a.txt'), 'a', 'utf8')
    const first = agora.commit('deliver a')
    fs.writeFileSync(path.join(root, 'b.txt'), 'b', 'utf8')
    const second = agora.commit('deliver b')

    const [outcomeA, outcomeB] = await Promise.all([first, second])
    // Both callers land, and each can see exactly what its commit carried.
    expect(outcomeA.subjects).toContain('deliver a')
    expect(outcomeB.subjects).toContain('deliver b')

    const log = await new ExecGitRunner().run(root, ['log', '--format=%s'])
    expect(log.stdout.trim().split('\n').length).toBeLessThanOrEqual(3)
  })

  it('reports a no-op when there is nothing to commit', async () => {
    const { agora } = rig()
    await agora.ensureRepo()
    const before = await agora.head()

    const outcome = await agora.commit('nothing changed')

    expect(outcome.sha).toBe(before)
    expect(await agora.isDirty()).toBe(false)
  })

  it('retries with backoff and succeeds once git stops failing', async () => {
    const home = tempRoot()
    const inner = new ExecGitRunner()
    // Armed only after setup, so the seed commit does not eat the failures.
    let failures = 0
    const flaky: GitRunner = {
      run: async (cwd, args) => {
        if (args[0] === 'add' && failures > 0) {
          failures -= 1
          return { ok: false, stdout: '', stderr: 'fatal: index.lock exists', code: 128 }
        }
        return inner.run(cwd, args)
      }
    }
    const agora = makeAgora(home, { git: flaky })
    await agora.ensureRepo()
    failures = 2
    fs.writeFileSync(path.join(home, 'agora', 'c.txt'), 'c', 'utf8')

    const outcome = await agora.commit('deliver c')

    expect(outcome.attempts).toBe(3)
    expect(outcome.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(failures).toBe(0)
  })

  it('gives up loudly, naming the subjects it could not land', async () => {
    const home = tempRoot()
    const inner = new ExecGitRunner()
    let armed = false
    const broken: GitRunner = {
      run: async (cwd, args) =>
        args[0] === 'commit' && armed
          ? { ok: false, stdout: '', stderr: 'fatal: cannot commit', code: 128 }
          : inner.run(cwd, args)
    }
    const agora = makeAgora(home, { git: broken, maxAttempts: 2 })
    await agora.ensureRepo()
    armed = true
    fs.writeFileSync(path.join(home, 'agora', 'd.txt'), 'd', 'utf8')

    await expect(agora.commit('deliver d')).rejects.toThrow(/deliver d.*cannot commit/s)
  })

  it('keeps taking work after a failed batch', async () => {
    const home = tempRoot()
    const inner = new ExecGitRunner()
    let breakIt = false
    const flaky: GitRunner = {
      run: async (cwd, args) =>
        args[0] === 'commit' && breakIt
          ? { ok: false, stdout: '', stderr: 'fatal: nope', code: 128 }
          : inner.run(cwd, args)
    }
    const agora = makeAgora(home, { git: flaky, maxAttempts: 1 })
    await agora.ensureRepo()
    breakIt = true

    fs.writeFileSync(path.join(home, 'agora', 'e.txt'), 'e', 'utf8')
    await expect(agora.commit('fails')).rejects.toThrow()

    breakIt = false
    await expect(agora.commit('succeeds')).resolves.toMatchObject({ attempts: 1 })
  })
})

describe('Agora — reconcile after a crash (SRS §6.6 primitive)', () => {
  it('clears a stale index.lock no live process can own', async () => {
    const { agora, root } = rig()
    await agora.ensureRepo()
    const lock = path.join(root, '.git', 'index.lock')
    fs.writeFileSync(lock, '', 'utf8')

    await agora.reconcile()

    expect(fs.existsSync(lock)).toBe(false)
  })

  it('commits work a killed harness left behind, losing nothing', async () => {
    const home = tempRoot()
    const agora = makeAgora(home)
    await agora.ensureRepo()

    // A crash leaves delivered files on disk, uncommitted.
    fs.mkdirSync(path.join(home, 'agora', 'agents', 'agent.b', 'inbox'), { recursive: true })
    fs.writeFileSync(
      path.join(home, 'agora', 'agents', 'agent.b', 'inbox', 'm-1.json'),
      '{"id":"m-1"}',
      'utf8'
    )
    expect(await agora.isDirty()).toBe(true)

    // A fresh Agora — as a restarted harness would build.
    const restarted = makeAgora(home)
    const outcome = await restarted.reconcile()

    expect(outcome.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await restarted.isDirty()).toBe(false)
    expect(fs.existsSync(path.join(home, 'agora', 'agents', 'agent.b', 'inbox', 'm-1.json'))).toBe(
      true
    )
  })

  it('survives a crash injected between staging and committing', async () => {
    const home = tempRoot()
    const seen: FaultPoint[] = []
    const agora = makeAgora(home, {
      faults: (point) => {
        seen.push(point)
        // The seam exists in the production path precisely so this is the real
        // ordering, not a mock's idea of it.
        if (point === 'after-stage' && seen.filter((p) => p === 'after-stage').length > 1) {
          throw new Error('simulated blackout between stage and commit')
        }
      }
    })
    await agora.ensureRepo()

    fs.writeFileSync(path.join(home, 'agora', 'inflight.txt'), 'in flight', 'utf8')
    await expect(agora.commit('deliver in-flight')).rejects.toThrow(/simulated blackout/)

    // The file is still on disk: nothing was lost, it just was not committed.
    expect(fs.existsSync(path.join(home, 'agora', 'inflight.txt'))).toBe(true)

    const restarted = makeAgora(home)
    await restarted.reconcile()
    expect(await restarted.isDirty()).toBe(false)
  })
})

describe('commit messages stay readable to a human doing forensics', () => {
  it('uses the subject alone for a single-item batch', () => {
    expect(commitMessage(['deliver m-1 to agent.b'])).toBe('deliver m-1 to agent.b')
  })

  it('summarises a batch and lists every subject in the body', () => {
    const message = commitMessage(['deliver m-1', 'deliver m-2', 'deliver m-3'])
    expect(message.split('\n')[0]).toBe('deliver m-1 (+2 more)')
    expect(message).toContain('- deliver m-2')
    expect(message).toContain('- deliver m-3')
  })

  it('never produces an empty subject', () => {
    expect(commitMessage([]).length).toBeGreaterThan(0)
  })
})

describe('the history names why each commit happened', () => {
  it('labels a post-crash reconcile as a reconcile, not as a seed', async () => {
    const home = tempRoot()
    const agora = makeAgora(home)
    await agora.ensureRepo()

    // A crash leaves work behind; the next boot runs ensureRepo THEN reconcile.
    fs.writeFileSync(path.join(home, 'agora', 'left-behind.txt'), 'x', 'utf8')

    const restarted = makeAgora(home)
    await restarted.ensureRepo()
    await restarted.reconcile()

    const log = await new ExecGitRunner().run(path.join(home, 'agora'), ['log', '--format=%s'])
    expect(log.stdout.split('\n')[0]).toContain('reconcile uncommitted work after restart')
  })

  it('does not commit at all when a boot changes nothing', async () => {
    const home = tempRoot()
    const agora = makeAgora(home)
    await agora.ensureRepo()
    const head = await agora.head()

    await makeAgora(home).ensureRepo()

    expect(await agora.head()).toBe(head)
  })
})
