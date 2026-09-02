import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../tmpdir'

/**
 * The attribution tripwire (ENGINEERING-STANDARDS §2, ADR-0020, ADR-0022).
 *
 * Two halves, tested two ways:
 *
 * - The **predicates** are pure and are called directly, because the fault they
 *   describe ("is this a bot address?") has edge cases that a repository fixture
 *   cannot economically enumerate.
 * - The **rules** are exercised against **real git in temp repositories** through a
 *   spawned process (TEST-STRATEGY §6). What the trunk clause asserts is a fact about
 *   git's own parent bookkeeping — that merged work hangs off a second parent — and a
 *   test that mocked `git log` would prove nothing about it. The script's whole job is
 *   its exit code, so the tests read the exit code.
 */

const require_ = createRequire(import.meta.url)
const SCRIPT = fileURLToPath(new URL('../../scripts/check-attribution.cjs', import.meta.url))
const check = require_(SCRIPT) as {
  identityFault: (role: string, name: string, email: string) => string | null
  isCompanyIdentity: (name: string, email: string) => boolean
  companyBranchFault: (
    role: string,
    name: string,
    email: string,
    branch: string | null
  ) => string | null
  messageFaults: (message: string) => string[]
}

/** The identity `botIdentity('ephesus-crew', 214...)` mints (src/shared/github-app.ts). */
const BOT = {
  name: 'ephesus-crew[bot]',
  email: '2140077+ephesus-crew[bot]@users.noreply.github.com'
}
const ARCHITECT = { name: 'MERT EFE SENSOY', email: 'sensoymertefe@gmail.com' }

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

interface Repo {
  readonly dir: string
  git: (args: readonly string[]) => string
  commit: (subject: string, who: { name: string; email: string }, body?: string) => void
}

/**
 * Settings every call carries rather than four `git config` spawns per repository.
 * Process creation is the whole cost of these tests on Windows, so the helper pays it
 * as few times as it can — `core.autocrlf` only silences a warning on write, and the
 * signing flag keeps a developer's global `commit.gpgsign` out of the fixture.
 */
const GIT_SETTINGS = [
  '-c',
  `user.name=${ARCHITECT.name}`,
  '-c',
  `user.email=${ARCHITECT.email}`,
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false'
]

/** A real repository with one Architect commit on `main`, and no remote. */
function repo(label: string): Repo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eph-attr-${label}-`))
  temps.push(dir)
  const git = (args: readonly string[]): string =>
    execFileSync('git', [...GIT_SETTINGS, ...args], { cwd: dir, encoding: 'utf8' })
  git(['init', '-q', '-b', 'main'])
  const commit = (subject: string, who: { name: string; email: string }, body?: string): void => {
    fs.writeFileSync(path.join(dir, 'file.txt'), `${subject}\n`, 'utf8')
    git(['add', '.'])
    git([
      '-c',
      `user.name=${who.name}`,
      '-c',
      `user.email=${who.email}`,
      'commit',
      '-q',
      '-m',
      body === undefined ? subject : `${subject}\n\n${body}`
    ])
  }
  commit('initial', ARCHITECT)
  return { dir, git, commit }
}

/**
 * Windows spends most of a case's wall clock creating processes: a repository is a
 * `git init`, a stage and a commit, and every assertion spawns the script itself on
 * top. Vitest's 5s default is a coin flip for that under a loaded suite, and a real-git
 * integration test that flakes is worse than no test (TEST-STRATEGY §6).
 */
const GIT_CASE_MS = 30_000

interface Run {
  readonly code: number
  readonly out: string
}

/** The script as CI and the hooks actually invoke it: a process, in a repository. */
function run(r: Repo, args: readonly string[] = [], env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: r.dir,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  return { code: result.status ?? -1, out: `${result.stdout}${result.stderr}` }
}

/** Pending-mode identity comes from the environment git itself reads. */
const asIdentity = (who: { name: string; email: string }): Record<string, string> => ({
  GIT_AUTHOR_NAME: who.name,
  GIT_AUTHOR_EMAIL: who.email,
  GIT_COMMITTER_NAME: who.name,
  GIT_COMMITTER_EMAIL: who.email
})

describe('identity predicates', () => {
  it('names a Claude author and an Anthropic address', () => {
    expect(check.identityFault('author', 'Claude', 'c@example.com')).toMatch(/Claude identity/)
    expect(check.identityFault('author', 'Claude Fable 5', 'x@y.z')).toMatch(/Claude identity/)
    expect(check.identityFault('committer', 'Someone', 'noreply@anthropic.com')).toMatch(
      /Anthropic identity/
    )
  })

  it('leaves the Architect and a name that merely mentions Claude alone', () => {
    expect(check.identityFault('author', ARCHITECT.name, ARCHITECT.email)).toBeNull()
    expect(check.identityFault('author', 'Claudia Rossi', 'claudia@example.com')).toBeNull()
  })

  it('recognises a company identity by either half of ADR-0022 form', () => {
    expect(check.isCompanyIdentity(BOT.name, BOT.email)).toBe(true)
    expect(check.isCompanyIdentity('ephesus-crew[bot]', 'anything@example.com')).toBe(true)
    expect(check.isCompanyIdentity('Somebody', BOT.email)).toBe(true)
    expect(check.isCompanyIdentity('dependabot[bot]', 'x@y.z')).toBe(true)
  })

  it('does not mistake a human for a bot', () => {
    expect(check.isCompanyIdentity(ARCHITECT.name, ARCHITECT.email)).toBe(false)
    // `[bot]` must terminate the name, not merely appear in it.
    expect(check.isCompanyIdentity('robot[bot] Industries', 'r@example.com')).toBe(false)
    // The noreply form GitHub resolves needs a NUMERIC id before the `+`.
    expect(
      check.isCompanyIdentity('Crew', 'ephesus-crew+agent.mason@users.noreply.github.com')
    ).toBe(false)
  })
})

describe('where a company identity may commit (ADR-0020, pure half)', () => {
  it('permits agent/<name>/<topic>', () => {
    expect(check.companyBranchFault('author', BOT.name, BOT.email, 'agent/mason/floor')).toBeNull()
  })

  it('refuses main, a feature branch, and a bare `agent`', () => {
    for (const branch of ['main', 'feature/m7-4-skeleton-crew', 'agent']) {
      expect(check.companyBranchFault('author', BOT.name, BOT.email, branch)).toMatch(
        /company identity/
      )
    }
  })

  it('fails closed on a detached HEAD, which has no branch to vouch for it', () => {
    expect(check.companyBranchFault('author', BOT.name, BOT.email, null)).toMatch(/detached HEAD/)
  })

  it('says nothing about the Architect, on any branch', () => {
    for (const branch of ['main', 'agent/mason/floor', null]) {
      expect(check.companyBranchFault('author', ARCHITECT.name, ARCHITECT.email, branch)).toBeNull()
    }
  })
})

describe('trailer scanning', () => {
  it('rejects a Claude co-author and a Claude-Session trailer', () => {
    expect(
      check.messageFaults('feat: x\n\nCo-authored-by: Claude <noreply@anthropic.com>')
    ).toEqual(['Claude co-author trailer: `Co-authored-by: Claude <noreply@anthropic.com>`'])
    expect(check.messageFaults('feat: x\n\nClaude-Session: abc123')).toHaveLength(1)
  })

  it('accepts the per-agent co-author trailer ADR-0022 sanctions', () => {
    expect(check.messageFaults(`feat: x\n\nCo-authored-by: mason <${BOT.email}>`)).toEqual([])
  })

  it('ignores commented-out trailers in a message template', () => {
    expect(check.messageFaults('# Co-authored-by: Claude <noreply@anthropic.com>')).toEqual([])
  })
})

describe(
  'history mode — the vendor-identity rule is unchanged',
  () => {
    it('passes an all-Architect history', () => {
      const r = repo('clean')
      r.commit('feat: something', ARCHITECT)
      const result = run(r)
      expect(result.code).toBe(0)
      expect(result.out).toMatch(/attribution ok/)
    })

    it('fails a Claude-authored commit even on a side branch that was merged', () => {
      const r = repo('claude-merged')
      r.git(['checkout', '-q', '-b', 'agent/mason/topic'])
      r.commit('feat: agent work', { name: 'Claude', email: 'noreply@anthropic.com' })
      r.git(['checkout', '-q', 'main'])
      r.git(['merge', '--no-ff', '-q', '-m', 'Merge pull request #1', 'agent/mason/topic'])
      const result = run(r)
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/author name is a Claude identity/)
    })

    it('fails a Claude co-author trailer anywhere in history', () => {
      const r = repo('claude-trailer')
      r.commit('feat: x', ARCHITECT, 'Co-authored-by: Claude <noreply@anthropic.com>')
      const result = run(r)
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/Claude co-author trailer/)
    })
  },
  GIT_CASE_MS
)

describe(
  "history mode — the company on main's first-parent chain (ADR-0020)",
  () => {
    it('fails a company commit put directly on main', () => {
      const r = repo('bot-on-main')
      r.commit('feat: straight to trunk', BOT)
      const result = run(r)
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/company identity \("ephesus-crew\[bot\]"\)/)
      expect(result.out).toMatch(/committed to main, not merged into it/)
    })

    it('fails a company identity that only COMMITTED on main, the Architect authoring', () => {
      const r = repo('bot-committer')
      fs.writeFileSync(path.join(r.dir, 'file.txt'), 'pushed by the bot\n', 'utf8')
      r.git(['add', '.'])
      // git takes the committer from the environment, which is how a harness that
      // "just pushes the Architect's patch" would put a bot on the trunk.
      execFileSync('git', ['commit', '-q', '-m', 'feat: landed by the bot'], {
        cwd: r.dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: ARCHITECT.name,
          GIT_AUTHOR_EMAIL: ARCHITECT.email,
          GIT_COMMITTER_NAME: BOT.name,
          GIT_COMMITTER_EMAIL: BOT.email
        }
      })
      const result = run(r)
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/committer is a company identity/)
    })

    it('passes a company commit that reached main through an Architect merge', () => {
      const r = repo('bot-merged')
      r.git(['checkout', '-q', '-b', 'agent/mason/topic'])
      r.commit('feat: agent work', BOT)
      r.git(['checkout', '-q', 'main'])
      r.git([
        'merge',
        '--no-ff',
        '-q',
        '-m',
        'Merge pull request #1 from agent/mason/topic',
        'agent/mason/topic'
      ])
      const result = run(r)
      expect(result.code).toBe(0)
      expect(result.out).toMatch(/first-parent chain/)
    })

    it('fails when the company merges its own branch into main', () => {
      const r = repo('bot-merger')
      r.git(['checkout', '-q', '-b', 'agent/mason/topic'])
      r.commit('feat: agent work', BOT)
      r.git(['checkout', '-q', 'main'])
      execFileSync(
        'git',
        [
          '-c',
          `user.name=${BOT.name}`,
          '-c',
          `user.email=${BOT.email}`,
          'merge',
          '--no-ff',
          '-q',
          '-m',
          'Merge pull request #1',
          'agent/mason/topic'
        ],
        { cwd: r.dir, encoding: 'utf8' }
      )
      const result = run(r)
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/company identity/)
    })

    it('does not fault the sanctioned per-agent co-author trailer on merged work', () => {
      const r = repo('bot-coauthor')
      r.git(['checkout', '-q', '-b', 'agent/mason/topic'])
      r.commit('feat: agent work', BOT, `Agent: mason\nCo-authored-by: mason <${BOT.email}>`)
      r.git(['checkout', '-q', 'main'])
      r.git(['merge', '--no-ff', '-q', '-m', 'Merge pull request #1', 'agent/mason/topic'])
      expect(run(r).code).toBe(0)
    })

    it('says out loud that it skipped the clause when no main ref exists', () => {
      const r = repo('no-main')
      r.git(['branch', '-m', 'main', 'trunk'])
      const result = run(r)
      expect(result.code).toBe(0)
      expect(result.out).toMatch(/company-on-main NOT checked/)
    })

    it('still catches a company commit on main when only origin/main resolves', () => {
      const r = repo('origin-main')
      r.commit('feat: straight to trunk', BOT)
      // Simulate a CI checkout: the branch is detached, main survives as a remote ref.
      r.git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main'])
      r.git(['checkout', '-q', '--detach', 'HEAD'])
      r.git(['branch', '-D', 'main'])
      const result = run(r)
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/refs\/remotes\/origin\/main's first-parent chain/)
    })
  },
  GIT_CASE_MS
)

describe(
  'pending mode — the literal rule, where a branch name still exists',
  () => {
    it('lets the company commit on an agent branch', () => {
      const r = repo('pending-agent')
      r.git(['checkout', '-q', '-b', 'agent/mason/topic'])
      const result = run(r, ['--pending'], asIdentity(BOT))
      expect(result.code).toBe(0)
      expect(result.out).toMatch(/branch agent\/mason\/topic/)
    })

    it('refuses the company on main', () => {
      const r = repo('pending-main')
      const result = run(r, ['--pending'], asIdentity(BOT))
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/company identity \("ephesus-crew\[bot\]"\) on branch "main"/)
      expect(result.out).toMatch(/agent\/<name>\/<topic>/)
    })

    it('refuses the company on a feature branch', () => {
      const r = repo('pending-feature')
      r.git(['checkout', '-q', '-b', 'feature/m7-4-skeleton-crew'])
      expect(run(r, ['--pending'], asIdentity(BOT)).code).toBe(1)
    })

    it('refuses the company on a detached HEAD', () => {
      const r = repo('pending-detached')
      r.git(['checkout', '-q', '--detach', 'HEAD'])
      const result = run(r, ['--pending'], asIdentity(BOT))
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/detached HEAD/)
    })

    it('lets the Architect commit on main, as always', () => {
      const r = repo('pending-architect')
      expect(run(r, ['--pending'], asIdentity(ARCHITECT)).code).toBe(0)
    })

    it('still refuses a Claude identity, on an agent branch included', () => {
      const r = repo('pending-claude')
      r.git(['checkout', '-q', '-b', 'agent/mason/topic'])
      const result = run(r, ['--pending'], asIdentity({ name: 'Claude', email: 'c@anthropic.com' }))
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/Claude identity/)
    })

    it('reads the message file when given one', () => {
      const r = repo('pending-msg')
      const msg = path.join(r.dir, 'COMMIT_EDITMSG')
      fs.writeFileSync(msg, 'feat: x\n\nClaude-Session: abc\n', 'utf8')
      const result = run(r, ['--pending', msg], asIdentity(ARCHITECT))
      expect(result.code).toBe(1)
      expect(result.out).toMatch(/Claude-Session trailer/)
    })
  },
  GIT_CASE_MS
)
