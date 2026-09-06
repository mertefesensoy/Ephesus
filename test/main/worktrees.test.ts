import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExecGitRunner,
  isAgentsOwnBranch,
  Worktrees,
  worktreePathIsVacant
} from '../../src/main/git'
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

    expect(await r.worktrees.remove(r.repo, p.path)).toEqual({ removed: true, residue: null })
    expect(fs.existsSync(p.path)).toBe(false)
    expect(
      execFileSync('git', ['worktree', 'list'], { cwd: r.repo, encoding: 'utf8' })
    ).not.toContain(p.path)
  })

  /**
   * The residue sweep (M8.6 audit, 2026-09-06).
   *
   * `git worktree remove` normally deletes the directory along with the
   * registration. On Windows it has been observed to unregister and leave an
   * EMPTY directory — three were sitting in `~/.ephesus/worktrees` on the
   * Architect's machine, unknown to `git worktree list`. Left alone they
   * accumulate, and until `worktreePathIsVacant` learned that an empty
   * directory is vacant, the residue of one activation REFUSED the next one for
   * the same agent id.
   *
   * The runner is wrapped rather than mocked wholesale: real git does every
   * step, and only `worktree remove` is made to behave the way it behaved
   * there — succeed, and leave the directory.
   */
  function leavesTheDirectory(): Worktrees {
    const real = new ExecGitRunner()
    return new Worktrees({
      runner: {
        run: async (cwd, args) => {
          const outcome = await real.run(cwd, args)
          if (args[0] === 'worktree' && args[1] === 'remove' && outcome.ok) {
            const left = args[2]
            if (left !== undefined) fs.mkdirSync(left, { recursive: true })
          }
          return outcome
        }
      },
      forbiddenRoot: path.join(os.tmpdir(), 'no-agora-here')
    })
  }

  it('sweeps the empty directory git unregistered and left behind', async () => {
    const r = rig()
    const p = plan(r)
    await r.worktrees.create(p)
    const swept = leavesTheDirectory()

    const outcome = await swept.remove(r.repo, p.path)

    expect(outcome).toEqual({ removed: true, residue: null })
    expect(fs.existsSync(p.path)).toBe(false)
  })

  it('leaves residue in place, and SAYS so, when a file is still in it', async () => {
    // The safety argument for the sweep. git has said the worktree is gone and
    // the porcelain said nothing was uncommitted, so an EMPTY directory is
    // bookkeeping — but anything still inside is a file nobody accounted for.
    // This module does not trade somebody's work for tidiness; it is the same
    // rule that keeps `--force` out of the whole file.
    const r = rig()
    const p = plan(r)
    await r.worktrees.create(p)
    const swept = new Worktrees({
      runner: {
        run: async (cwd, args) => {
          const real = await new ExecGitRunner().run(cwd, args)
          if (args[0] === 'worktree' && args[1] === 'remove' && real.ok) {
            const left = args[2]
            if (left !== undefined) {
              fs.mkdirSync(left, { recursive: true })
              fs.writeFileSync(path.join(left, 'left-behind.md'), '# not mine to delete\n', 'utf8')
            }
          }
          return real
        }
      },
      forbiddenRoot: path.join(os.tmpdir(), 'no-agora-here')
    })

    const outcome = await swept.remove(r.repo, p.path)

    expect(outcome.removed).toBe(true)
    if (outcome.removed) expect(outcome.residue).toContain('1 file(s) remain')
    expect(fs.readFileSync(path.join(p.path, 'left-behind.md'), 'utf8')).toBe(
      '# not mine to delete\n'
    )
  })

  it('says so when the leftover is not a directory it can tidy at all', async () => {
    // The catch, reached honestly: something that is not a directory is sitting
    // where the worktree was, so the sweep cannot even list it. Still not a
    // failed removal — git took the worktree — but not silence either.
    const r = rig()
    const p = plan(r)
    await r.worktrees.create(p)
    const swept = new Worktrees({
      runner: {
        run: async (cwd, args) => {
          const real = await new ExecGitRunner().run(cwd, args)
          if (args[0] === 'worktree' && args[1] === 'remove' && real.ok) {
            const left = args[2]
            if (left !== undefined) fs.writeFileSync(left, 'not a directory', 'utf8')
          }
          return real
        }
      },
      forbiddenRoot: path.join(os.tmpdir(), 'no-agora-here')
    })

    const outcome = await swept.remove(r.repo, p.path)

    expect(outcome.removed).toBe(true)
    if (outcome.removed) expect(outcome.residue).toContain('could not be tidied')
    expect(fs.readFileSync(p.path, 'utf8')).toBe('not a directory')
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

    expect(await r.worktrees.remove(r.repo, p.path)).toEqual({ removed: true, residue: null })
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
    fs.writeFileSync(path.join(target.path, 'not-ours.txt'), 'someone else\n', 'utf8')

    const outcome = await r.worktrees.create(target)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('already exists')
    expect(fs.existsSync(path.join(target.path, 'not-ours.txt'))).toBe(true)
  })

  it('refuses a checkout of the right shape sitting on the WRONG branch', async () => {
    const r = rig()
    const target = plan(r)
    await r.worktrees.create({ ...target, branch: 'agent/someone-else' })

    const outcome = await r.worktrees.create(target)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('already exists')
    // Still a checkout, still git's — clearing it would have destroyed it.
    expect(fs.existsSync(path.join(target.path, 'README.md'))).toBe(true)
  })
})

/**
 * The defect that retired an agent for good: its worktree path survived an
 * unwind as an EMPTY directory (git deleted the contents; a held handle kept
 * the directory), so the ownership probe found no repository, `create` refused,
 * and every respawn from then on was refused identically. Observed on the
 * MUSAHIT run — the agent could not be spawned again at all.
 *
 * The refusal protects uncommitted work. An empty directory has none, so the
 * two cases are told apart by the only question that carries the safety
 * argument: is there anything in there?
 */
describe('an emptied worktree path (2026-09-06 respawn defect)', () => {
  it('accepts an EMPTY leftover directory and gives the agent its checkout', async () => {
    const r = rig()
    const target = plan(r)
    fs.mkdirSync(target.path, { recursive: true })

    const outcome = await r.worktrees.create(target)

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.path).toBe(target.path)
      expect(outcome.branch).toBe(target.branch)
    }
    // A real checkout on the agent's own branch, not merely a directory that
    // stopped being refused.
    expect(fs.existsSync(path.join(target.path, 'README.md'))).toBe(true)
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: target.path,
        encoding: 'utf8'
      }).trim()
    ).toBe(target.branch)
  })

  it('recovers when git still holds a stale entry for the emptied path', async () => {
    // The failure without the prune: git refuses `worktree add` for a path it
    // already has registered, so accepting the empty directory alone would
    // swap one permanent refusal for another.
    const r = rig()
    const target = plan(r)
    await r.worktrees.create(target)
    for (const entry of fs.readdirSync(target.path)) {
      fs.rmSync(path.join(target.path, entry), { recursive: true, force: true })
    }
    expect(fs.readdirSync(target.path)).toEqual([])
    expect(execFileSync('git', ['worktree', 'list'], { cwd: r.repo, encoding: 'utf8' })).toContain(
      path.basename(target.path)
    )

    const outcome = await r.worktrees.create(target)

    expect(outcome.ok).toBe(true)
    expect(fs.existsSync(path.join(target.path, 'README.md'))).toBe(true)
  })

  it('refuses a FILE standing where the worktree goes', async () => {
    const r = rig()
    const target = plan(r)
    fs.mkdirSync(path.dirname(target.path), { recursive: true })
    fs.writeFileSync(target.path, 'not a directory\n', 'utf8')

    const outcome = await r.worktrees.create(target)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('already exists')
    expect(fs.readFileSync(target.path, 'utf8')).toBe('not a directory\n')
  })

  it('REFUSES a link that would silently redirect the checkout (ADR-0021)', async () => {
    // A junction reads as an ordinary empty directory through `stat`, and its
    // target is a directory nobody approved for this agent. `lstat` is the only
    // thing between "an empty path we may use" and "somebody else's directory
    // wearing that path's name".
    const r = rig()
    const target = plan(r)
    const elsewhere = path.join(r.root, 'somewhere-else')
    fs.mkdirSync(elsewhere)
    fs.mkdirSync(path.dirname(target.path), { recursive: true })
    fs.symlinkSync(elsewhere, target.path, 'junction')

    const verdict = worktreePathIsVacant(target.path)
    expect(verdict).toEqual({ vacant: false, because: 'already exists' })

    const outcome = await r.worktrees.create(target)
    expect(outcome.ok).toBe(false)
    // Nothing was checked out into the directory the link pointed at.
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })

  it('names an unreadable path as unreadable rather than as somebody’s work', async () => {
    // Both refusals stop the spawn; only one of them sends the Architect
    // looking for files that are not there.
    const verdict = worktreePathIsVacant(path.join(rig().root, 'never-made'))
    expect(verdict.vacant).toBe(false)
    if (!verdict.vacant) expect(verdict.because).toContain('could not be read')
  })

  it('reports a populated directory as occupied, and touches nothing', async () => {
    const r = rig()
    const dir = path.join(r.root, 'has-work')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'work.txt'), 'keep me\n', 'utf8')

    expect(worktreePathIsVacant(dir)).toEqual({ vacant: false, because: 'already exists' })
    expect(fs.readdirSync(dir)).toEqual(['work.txt'])
  })

  it('reports an empty directory as vacant WITHOUT removing it', async () => {
    // The predicate is pure inspection: `git worktree add` accepts the empty
    // directory as it stands, so this module never deletes at the worktree
    // path — the promise it makes everywhere else.
    const r = rig()
    const dir = path.join(r.root, 'empty')
    fs.mkdirSync(dir)

    expect(worktreePathIsVacant(dir)).toEqual({ vacant: true })
    expect(fs.existsSync(dir)).toBe(true)
  })
})

/**
 * An agent's branch is a NAMESPACE, not one name.
 *
 * The runbook tells a hire to "push your own `agent/*` branch and open a pull
 * request", so a hire that does its job ends up on `agent/<id>-<topic>`.
 * Requiring the exact name read that as somebody else's checkout and refused
 * the respawn — and because activation is all-or-nothing it took the whole
 * company down with it. Observed live on 2026-09-06 after the dependency-updater
 * opened three security pull requests.
 */
describe('an agent respawning onto its own topic branch', () => {
  it('reuses a checkout sitting on a branch BENEATH its own', async () => {
    const r = rig()
    const target = plan(r)
    await r.worktrees.create(target)
    execFileSync('git', ['checkout', '-q', '-b', `${target.branch}-sec-fix`], { cwd: target.path })

    const again = await r.worktrees.create(target)

    expect(again.ok).toBe(true)
    // Left WHERE IT STANDS: the topic branch is where its work is, and moving
    // it back would strand the commits it is about to push.
    if (again.ok) expect(again.branch).toBe(`${target.branch}-sec-fix`)
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: target.path,
        encoding: 'utf8'
      }).trim()
    ).toBe(`${target.branch}-sec-fix`)
  })

  it('still refuses a checkout on ANOTHER agent’s branch', async () => {
    const r = rig()
    const target = plan(r)
    await r.worktrees.create(target)
    execFileSync('git', ['checkout', '-q', '-b', 'agent/somebody-else'], { cwd: target.path })

    const outcome = await r.worktrees.create(target)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('already exists')
  })
})

describe('isAgentsOwnBranch — the namespace, and its edge', () => {
  const own = 'agent/mason'

  it('accepts the branch itself and topic branches beneath it', () => {
    expect(isAgentsOwnBranch(own, own)).toBe(true)
    expect(isAgentsOwnBranch(`${own}-arc-clock`, own)).toBe(true)
    expect(isAgentsOwnBranch(`${own}-2`, own)).toBe(true)
  })

  it('REQUIRES the separator, so a longer id is not swallowed', () => {
    // Without it `agent/mason` would own `agent/masonry`, which is the exact
    // confusion a namespace prefix exists to prevent.
    expect(isAgentsOwnBranch('agent/masonry', own)).toBe(false)
    expect(isAgentsOwnBranch('agent/masonry-topic', own)).toBe(false)
  })

  it('refuses another agent’s branch and the base branches', () => {
    expect(isAgentsOwnBranch('agent/thalia', own)).toBe(false)
    expect(isAgentsOwnBranch('main', own)).toBe(false)
    expect(isAgentsOwnBranch('', own)).toBe(false)
  })
})

describe('a worktree of somebody else’s repository', () => {
  it('is REFUSED even when its branch matches the agent’s namespace', async () => {
    // The branch name is not proof of ownership: another repository can have a
    // branch called anything. `git-common-dir` is what ties the checkout to
    // THIS target, and without it the agent would be handed a stranger's code
    // and push its work into it.
    const r = rig()
    const target = plan(r)

    const other = path.join(r.root, 'other-repo')
    fs.mkdirSync(other)
    const git = (cwd: string, args: readonly string[]): void => {
      execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd })
    }
    git(other, ['init', '-q', '-b', 'main'])
    fs.writeFileSync(path.join(other, 'SECRETS.md'), '# not ours\n', 'utf8')
    git(other, ['add', '.'])
    git(other, ['commit', '-qm', 'initial'])
    // Same path, same branch name, different repository.
    fs.mkdirSync(path.dirname(target.path), { recursive: true })
    git(other, ['worktree', 'add', '-b', target.branch, target.path])

    const outcome = await r.worktrees.create(target)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('already exists')
    // The stranger's checkout is untouched.
    expect(fs.existsSync(path.join(target.path, 'SECRETS.md'))).toBe(true)
  })
})
