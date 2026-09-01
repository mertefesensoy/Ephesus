import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecGitRunner, Worktrees } from '../../src/main/git'
import { removeTempDir } from '../tmpdir'

/**
 * Worktree isolation (SRS UC-01 alternate 2a) against **real git in temp
 * repositories** — the mechanism under test is git's own bookkeeping, and a
 * mocked runner would prove nothing about it (TEST-STRATEGY §6).
 *
 * Two rules carry the weight: never a worktree of the Agora (ADR-0004 gives it
 * one working copy), and never destroy uncommitted work.
 */

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function rig(): { root: string; repo: string; agora: string; worktrees: Worktrees } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-worktree-'))
  temps.push(root)
  const repo = path.join(root, 'target-repo')
  const agora = path.join(root, 'agora')
  fs.mkdirSync(repo, { recursive: true })
  fs.mkdirSync(agora, { recursive: true })

  const git = (cwd: string, args: readonly string[]): void => {
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd })
  }
  git(repo, ['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(repo, 'README.md'), '# target\n', 'utf8')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'initial'])

  git(agora, ['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(agora, 'PROTOCOL.md'), '# protocol\n', 'utf8')
  git(agora, ['add', '.'])
  git(agora, ['commit', '-qm', 'initial'])

  return {
    root,
    repo,
    agora,
    worktrees: new Worktrees({ runner: new ExecGitRunner(), forbiddenRoot: agora })
  }
}

const plan = (r: ReturnType<typeof rig>, name = 'agent.mason') => ({
  repo: r.repo,
  path: path.join(r.root, 'worktrees', name),
  branch: `agent/${name.replace(/^agent\./, '')}`
})

describe('creating a worktree (UC-01 alternate 2a)', () => {
  it('gives the agent its own checkout on its own branch', async () => {
    const r = rig()
    const outcome = await r.worktrees.create(plan(r))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.created).toBe(true)
    expect(outcome.branch).toBe('agent/mason')
    expect(fs.existsSync(path.join(outcome.path, 'README.md'))).toBe(true)

    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: outcome.path,
      encoding: 'utf8'
    }).trim()
    expect(branch).toBe('agent/mason')
    // And the Architect's own checkout is untouched.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: r.repo, encoding: 'utf8' })).toBe(
      ''
    )
  })

  it('reuses the branch on a second create — a respawn lands where it left off', async () => {
    const r = rig()
    const first = await r.worktrees.create(plan(r))
    expect(first.ok).toBe(true)
    await r.worktrees.remove(r.repo, plan(r).path)

    const again = await r.worktrees.create(plan(r))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.created).toBe(false)
  })

  it('REFUSES a worktree of the Agora (ADR-0004: one working copy)', async () => {
    const r = rig()
    const outcome = await r.worktrees.create({
      repo: r.agora,
      path: path.join(r.root, 'worktrees', 'sneaky'),
      branch: 'agent/sneaky'
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('inside the Agora')
    expect(fs.existsSync(path.join(r.root, 'worktrees', 'sneaky'))).toBe(false)
  })

  it('refuses a worktree of a directory INSIDE the Agora too', async () => {
    const r = rig()
    const inner = path.join(r.agora, 'agents', 'agent.mason')
    fs.mkdirSync(inner, { recursive: true })
    const outcome = await r.worktrees.create({
      repo: inner,
      path: path.join(r.root, 'worktrees', 'inner'),
      branch: 'agent/inner'
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('inside the Agora')
  })

  it('refuses to put the worktree inside the repo it came from', async () => {
    const r = rig()
    const outcome = await r.worktrees.create({
      repo: r.repo,
      path: path.join(r.repo, 'wt'),
      branch: 'agent/x'
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('inside the target repo')
  })

  it('refuses a target that is not a git repository, and says so', async () => {
    const r = rig()
    const plain = path.join(r.root, 'not-a-repo')
    fs.mkdirSync(plain)
    const outcome = await r.worktrees.create({
      repo: plain,
      path: path.join(r.root, 'worktrees', 'x'),
      branch: 'agent/x'
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('not a git repository')
  })

  it('refuses a path that already exists rather than writing into it', async () => {
    const r = rig()
    const p = plan(r)
    fs.mkdirSync(p.path, { recursive: true })
    fs.writeFileSync(path.join(p.path, 'someones-work.txt'), 'do not clobber me\n', 'utf8')

    const outcome = await r.worktrees.create(p)
    expect(outcome.ok).toBe(false)
    expect(fs.readFileSync(path.join(p.path, 'someones-work.txt'), 'utf8')).toBe(
      'do not clobber me\n'
    )
  })
})

describe('removing a worktree — never destroying work', () => {
  it('removes a clean one and prunes git’s bookkeeping', async () => {
    const r = rig()
    const p = plan(r)
    await r.worktrees.create(p)

    expect(await r.worktrees.remove(r.repo, p.path)).toEqual({ removed: true })
    expect(fs.existsSync(p.path)).toBe(false)
    expect(
      execFileSync('git', ['worktree', 'list'], { cwd: r.repo, encoding: 'utf8' })
    ).not.toContain(p.path)
  })

  it('REFUSES a dirty one, names the changes, and leaves every byte in place', async () => {
    const r = rig()
    const p = plan(r)
    await r.worktrees.create(p)
    fs.writeFileSync(path.join(p.path, 'unpushed.md'), '# half a day of work\n', 'utf8')

    const outcome = await r.worktrees.remove(r.repo, p.path)
    expect(outcome.removed).toBe(false)
    if (!outcome.removed) {
      expect(outcome.reason).toContain('uncommitted change')
      expect(outcome.changes.join('\n')).toContain('unpushed.md')
    }
    expect(fs.readFileSync(path.join(p.path, 'unpushed.md'), 'utf8')).toBe('# half a day of work\n')
  })

  it('refuses a worktree with modified tracked files too', async () => {
    const r = rig()
    const p = plan(r)
    await r.worktrees.create(p)
    fs.writeFileSync(path.join(p.path, 'README.md'), '# edited\n', 'utf8')

    const outcome = await r.worktrees.remove(r.repo, p.path)
    expect(outcome.removed).toBe(false)
    if (!outcome.removed) expect(outcome.changes.join('\n')).toContain('README.md')
  })

  it('is safe when the directory is already gone, and prunes the stale entry', async () => {
    const r = rig()
    const p = plan(r)
    await r.worktrees.create(p)
    fs.rmSync(p.path, { recursive: true, force: true })

    expect(await r.worktrees.remove(r.repo, p.path)).toEqual({ removed: true })
    // Pruned, so the same path can be handed out again.
    const again = await r.worktrees.create(p)
    expect(again.ok).toBe(true)
  })

  it('treats an uninspectable worktree as not clean', async () => {
    const r = rig()
    const notARepo = path.join(r.root, 'plain-dir')
    fs.mkdirSync(notARepo)
    const state = await r.worktrees.state(notARepo)
    expect(state.clean).toBe(false)
  })
})

describe('respawning onto a surviving worktree (M4 close-out audit)', () => {
  it("reuses the agent's own kept checkout instead of refusing it", async () => {
    const r = rig()
    const first = await r.worktrees.create(plan(r))
    expect(first.ok).toBe(true)

    // A dirty unwind kept the worktree; the respawn asks for the same plan.
    // Refusing here contradicted the card that still names the checkout, and
    // sent the spawn back to the shared repo while its work sat kept elsewhere.
    const again = await r.worktrees.create(plan(r))
    expect(again.ok).toBe(true)
    if (again.ok) {
      expect(again.path).toBe(plan(r).path)
      expect(again.branch).toBe(plan(r).branch)
      expect(again.created).toBe(false)
    }
  })

  it("still refuses a path that exists but is not the agent's worktree", async () => {
    const r = rig()
    const target = plan(r)
    fs.mkdirSync(target.path, { recursive: true })

    const outcome = await r.worktrees.create(target)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('already exists')
  })
})
