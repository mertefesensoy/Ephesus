import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecGitRunner, readRemotes, type GitRunner } from '../../src/main/git'
import { deriveRepo } from '../../src/shared/repo-remote'
import { removeTempDir } from '../tmpdir'

/**
 * Reading a checkout's remotes, against **real git in temp repositories**
 * (M8.5, and TEST-STRATEGY §6's rule that git's own bookkeeping is the
 * mechanism under test).
 *
 * The parser here is a contract with a program we do not own, and the M8.4
 * defect is why that matters: a matcher written against imagined output passed
 * forty-five tests while being unable to read a single byte the real tool
 * prints. `git remote -v` writes one line per remote per DIRECTION, and a
 * parser that did not know that would report `origin` twice and make a
 * one-remote checkout look like two.
 */

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

const git = (cwd: string, args: readonly string[]): void => {
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd })
}

function repoWith(remotes: readonly (readonly [string, string])[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-remotes-'))
  temps.push(root)
  const repo = path.join(root, 'target')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  for (const [name, url] of remotes) git(repo, ['remote', 'add', name, url])
  return repo
}

const runner = new ExecGitRunner()

describe('readRemotes, against git itself', () => {
  it('reads one remote once, not once per direction', async () => {
    // `git remote -v` prints `origin <url> (fetch)` AND `origin <url> (push)`.
    const repo = repoWith([['origin', 'https://github.com/owner/app.git']])
    const read = await readRemotes(runner, repo)
    if (!read.ok) throw new Error(read.because)
    expect(read.remotes).toEqual([{ name: 'origin', url: 'https://github.com/owner/app.git' }])
  })

  it('reads a fork’s two remotes, and the derivation then refuses', async () => {
    const repo = repoWith([
      ['origin', 'git@github.com:me/app.git'],
      ['upstream', 'https://github.com/canonical/app.git']
    ])
    const read = await readRemotes(runner, repo)
    if (!read.ok) throw new Error(read.because)
    expect(read.remotes.map((r) => r.name).sort()).toEqual(['origin', 'upstream'])

    const derived = deriveRepo(read.remotes)
    expect(derived.ok).toBe(false)
    if (derived.ok) throw new Error('unreachable')
    expect(derived.because).toContain('me/app')
    expect(derived.because).toContain('canonical/app')
  })

  it('reads a separate push URL as its own line', async () => {
    // A push URL that differs from the fetch URL is a real configuration, and
    // git prints it as a second line under the same remote name.
    const repo = repoWith([['origin', 'https://github.com/owner/app.git']])
    git(repo, ['remote', 'set-url', '--push', 'origin', 'git@github.com:owner/app.git'])
    const read = await readRemotes(runner, repo)
    if (!read.ok) throw new Error(read.because)
    expect(read.remotes).toHaveLength(2)
    // Both name the same repository, so the derivation is not ambiguous.
    expect(deriveRepo(read.remotes)).toEqual({ ok: true, slug: 'owner/app', from: 'origin' })
  })

  it('reports an empty list for a repository with no remote', async () => {
    // Distinct from "could not read": a fresh `git init` is a repository, and
    // the derivation's sentence for it is different from git's error.
    const read = await readRemotes(runner, repoWith([]))
    expect(read).toEqual({ ok: true, remotes: [] })
    expect(deriveRepo([])).toEqual({ ok: false, because: 'the target has no git remote' })
  })

  it('says why when the target is not a repository at all, in git’s words', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-notrepo-'))
    temps.push(plain)
    const read = await readRemotes(runner, plain)
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.because).toContain('git could not read')
    // git's own wording, not ours: it names the problem better than a guess.
    expect(read.because.toLowerCase()).toContain('not a git repository')
  })

  it('never throws on a directory that does not exist', async () => {
    const read = await readRemotes(runner, path.join(os.tmpdir(), 'eph-nope-does-not-exist'))
    expect(read.ok).toBe(false)
  })
})

/**
 * The lines `git remote -v` does NOT print, against an injected runner.
 *
 * Real git is the right rig for everything above — it is the program whose
 * output format is the contract. But real git will not print a malformed line
 * on demand, and the parser's anchors are what stop one being read as a remote.
 * Without this, every anchor in that regex is decoration: removing the
 * `(fetch)`/`(push)` requirement changes nothing about real output, so nothing
 * would ever notice it going.
 */
describe('readRemotes reads only what is a remote line', () => {
  const answering = (stdout: string): GitRunner => ({
    run: () => Promise.resolve({ ok: true, stdout, stderr: '', code: 0 })
  })

  it('ignores a line with no direction marker', async () => {
    const read = await readRemotes(
      answering(
        [
          'origin\thttps://github.com/owner/app.git (fetch)',
          'origin\thttps://github.com/owner/app.git (push)',
          // A hint, a warning, a `git` that grew a header — none of these are
          // remotes, and each would become one without the anchor.
          'hint: some advice about remotes',
          'upstream\thttps://github.com/other/app.git',
          '  ',
          'origin\thttps://github.com/owner/app.git (fetchx)'
        ].join('\n')
      ),
      '/anywhere'
    )
    if (!read.ok) throw new Error(read.because)
    expect(read.remotes).toEqual([{ name: 'origin', url: 'https://github.com/owner/app.git' }])
    // And the derivation is therefore unambiguous, rather than being handed a
    // second "repository" that git never claimed existed.
    expect(deriveRepo(read.remotes)).toEqual({ ok: true, slug: 'owner/app', from: 'origin' })
  })

  it('reads an empty answer as no remotes, not as a failure', async () => {
    expect(await readRemotes(answering(''), '/anywhere')).toEqual({ ok: true, remotes: [] })
  })
})
