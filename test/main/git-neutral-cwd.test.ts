import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecGitRunner, repoLocation } from '../../src/main/git'
import { removeTempDir } from '../tmpdir'

/**
 * git runs from a NEUTRAL working directory (`src/main/git.ts`).
 *
 * On Windows a process's current directory is an open handle on it, so a git
 * child running inside a repository locks that directory for as long as it
 * lives: `rmdir` fails with EBUSY while every file inside deletes normally.
 * That is a real constraint on the harness — it cannot remove or move a
 * checkout while a git command is still running in it — and it was the cause of
 * the test suite's teardown flake.
 *
 * So git is told where the repository is instead of being put inside it. These
 * tests are against **real git in temp repositories**: the whole question is
 * whether git behaves the same way, and a fake runner would prove nothing.
 */

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'ignore'
  })
}

function fixture(): { home: string; repo: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-neutral-'))
  temps.push(home)
  const repo = path.join(home, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello', 'utf8')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-m', 'first')
  return { home, repo }
}

/** The `--git-dir=` value `repoLocation` chose, for asserting on directly. */
const gitDirOf = (args: readonly string[]): string =>
  (args.find((a) => a.startsWith('--git-dir=')) ?? '').slice('--git-dir='.length)

describe('repoLocation — telling git where the repo is, without standing in it', () => {
  it('points at the .git directory of an ordinary working tree', () => {
    const { repo } = fixture()

    expect(repoLocation(repo, 'status')).toEqual([
      `--git-dir=${path.join(repo, '.git')}`,
      `--work-tree=${repo}`
    ])
  })

  it('follows the gitdir POINTER of a linked worktree', () => {
    const { home, repo } = fixture()
    const wt = path.join(home, 'wt')
    git(repo, 'worktree', 'add', '-b', 'agent-x', wt)

    // Every agent's isolated checkout is in this shape: `.git` is a FILE, and
    // `--git-dir` will not follow it on its own.
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true)
    const located = gitDirOf(repoLocation(wt, 'status'))
    expect(located).toContain(path.join('.git', 'worktrees', 'wt'))
    expect(fs.existsSync(located)).toBe(true)
  })

  it('walks up from a subdirectory, the way git discovers a repo itself', () => {
    const { repo } = fixture()
    const nested = path.join(repo, 'src', 'deep')
    fs.mkdirSync(nested, { recursive: true })

    // Nailing --git-dir to <dir>/.git would turn a real repo subdirectory into
    // "not a git repository", which it is not.
    expect(repoLocation(nested, 'status')).toEqual([
      `--git-dir=${path.join(repo, '.git')}`,
      `--work-tree=${repo}`
    ])
  })

  it('gives a bare repository no work tree, because it has none', () => {
    const { home } = fixture()
    const bare = path.join(home, 'bare.git')
    git(home, 'init', '--bare', '-b', 'main', bare)

    expect(repoLocation(bare, 'rev-parse')).toEqual([`--git-dir=${bare}`])
  })

  it('never discovers an enclosing repository for `init`', () => {
    const { repo } = fixture()
    const inside = path.join(repo, 'nested', 'agora')
    fs.mkdirSync(inside, { recursive: true })

    // The one case where discovery is wrong: `init` CREATES a repository. A
    // `~/.ephesus` that happened to sit inside some other checkout would
    // otherwise join it, and the Agora would commit into the user's repo.
    expect(repoLocation(inside, 'init')).toEqual([
      `--git-dir=${path.join(inside, '.git')}`,
      `--work-tree=${inside}`
    ])
  })

  it('still names a git dir when there is no repository at all', () => {
    const { home } = fixture()
    const notRepo = path.join(home, 'not-a-repo')
    fs.mkdirSync(notRepo, { recursive: true })

    // Passing nothing would let git discover a repository from the neutral cwd
    // and operate on something unrelated. A git dir that does not exist keeps
    // "not a git repository" an error.
    expect(gitDirOf(repoLocation(notRepo, 'status'))).toBe(path.join(notRepo, '.git'))
  })
})

describe('ExecGitRunner — same answers, without holding the directory', () => {
  it('reads, stages and commits a repository it is not standing in', async () => {
    const { repo } = fixture()
    const runner = new ExecGitRunner()
    fs.mkdirSync(path.join(repo, 'agents', 'agent.a'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'agents', 'agent.a', 'f.json'), '{}', 'utf8')

    // `add -A` with no pathspec covers the whole tree, and the work tree is the
    // repo rather than wherever the process happens to be.
    expect((await runner.run(repo, ['add', '-A'])).ok).toBe(true)
    expect((await runner.run(repo, ['commit', '-m', 'from a neutral cwd'])).ok).toBe(true)

    const status = await runner.run(repo, ['status', '--porcelain'])
    expect(status.ok).toBe(true)
    expect(status.stdout.trim()).toBe('')

    const log = await runner.run(repo, ['log', '--oneline', '-1'])
    expect(log.stdout).toContain('from a neutral cwd')
  })

  it('initialises a repository in a directory it is not standing in', async () => {
    const { home } = fixture()
    const fresh = path.join(home, 'fresh')
    fs.mkdirSync(fresh, { recursive: true })

    expect((await new ExecGitRunner().run(fresh, ['init', '-b', 'main'])).ok).toBe(true)

    expect(fs.existsSync(path.join(fresh, '.git'))).toBe(true)
  })

  it('still fails on a directory that is not a repository', async () => {
    const { home } = fixture()
    const notRepo = path.join(home, 'not-a-repo')
    fs.mkdirSync(notRepo, { recursive: true })

    // `Worktrees.create` reads exactly this to refuse a bad target, so it has
    // to keep failing rather than quietly finding some other repository.
    expect((await new ExecGitRunner().run(notRepo, ['rev-parse', '--git-dir'])).ok).toBe(false)
  })

  it('leaves the repository deletable while git is running in it', async () => {
    const { home, repo } = fixture()
    const runner = new ExecGitRunner()
    const doomed = path.join(home, 'doomed')
    fs.mkdirSync(doomed, { recursive: true })
    git(doomed, 'init', '-b', 'main')

    // The property this whole change exists for. Twelve git processes against
    // the repository, and it is still removable — because none of them is
    // standing in it.
    const inFlight = Array.from({ length: 12 }, () => runner.run(doomed, ['status', '--porcelain']))
    expect(() => fs.rmdirSync(path.join(doomed, '.git', 'refs', 'tags'))).not.toThrow()
    await Promise.all(inFlight)

    expect((await runner.run(repo, ['status', '--porcelain'])).ok).toBe(true)
  })
})
