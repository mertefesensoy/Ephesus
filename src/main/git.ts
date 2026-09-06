import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { GitRemote } from '../shared/repo-remote'

/**
 * The one place in Ephesus that runs `git`.
 *
 * ADR-0004 is blunt about why: with up to 30 agent processes, concurrent `git`
 * invocations corrupt `.git/index.lock`. Only the main process may commit, and
 * keeping every invocation behind this one module is what makes that claim
 * checkable — a `git` call anywhere else is a grep away, and CI greps for it.
 *
 * Agents never touch this. They write plain files in their own directories
 * (ADR-0003) and the committer picks the work up.
 */

/**
 * Commit identity for the company's own history. Passed per invocation rather
 * than written into the repo config, so the Agora never depends on — or
 * silently inherits — whatever the machine's global git identity happens to be
 * (CI runners frequently have none).
 */
export const AGORA_COMMITTER = {
  name: 'Ephesus',
  email: 'harness@ephesus.local'
} as const

export interface GitResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  /** Process exit code, or null when git could not be started at all. */
  readonly code: number | null
}

export interface GitRunner {
  /** Contract: never throws. A failed git command is a result, not an exception. */
  run(cwd: string, args: readonly string[]): Promise<GitResult>
}

const IDENTITY_ARGS = [
  '-c',
  `user.name=${AGORA_COMMITTER.name}`,
  '-c',
  `user.email=${AGORA_COMMITTER.email}`,
  // The Agora is a local coordination repo: never sign, never hook, never let a
  // user's global config change what the harness commits.
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null'
]

export class ExecGitRunner implements GitRunner {
  constructor(private readonly timeoutMs = 20_000) {}

  run(cwd: string, args: readonly string[]): Promise<GitResult> {
    return new Promise((resolve) => {
      execFile(
        'git',
        [...IDENTITY_ARGS, ...args],
        { cwd, timeout: this.timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : err
                ? null
                : 0
          resolve({ ok: !err, stdout, stderr: stderr || (err ? err.message : ''), code })
        }
      )
    })
  }
}

/**
 * Worktree isolation (SRS UC-01 alternate 2a: "worktree isolation requested →
 * agent gets its own git worktree of the target repo").
 *
 * It lives here, in the one module allowed to run `git`, for the reason
 * ADR-0004 gives: a second git path is a second way to corrupt an index lock,
 * and "only main runs git" is only checkable while every invocation is in this
 * file. The agent never runs these commands; the harness does, before the
 * process exists and after it is gone.
 *
 * Two rules are enforced here rather than trusted to the caller:
 *
 *  - **Never the Agora.** A worktree of the company's own repo would put a
 *    second working copy behind the single committer's back. `forbiddenRoot`
 *    is checked on every create.
 *  - **Never destroy work.** A worktree with uncommitted changes is not
 *    removed. It is *reported*, with the files, so the Architect decides —
 *    losing an agent's unpushed work to a tidy-up is not a trade this harness
 *    makes (NFR-7's spirit, and the reason `--force` never appears below).
 */

/** Where a spawn's isolated checkout goes, and on which branch. */
export interface WorktreePlan {
  /** The TARGET repository. Never the Agora. */
  readonly repo: string
  /** Absolute path of the new working copy, outside the repo. */
  readonly path: string
  /** Branch to check out there; created from HEAD when it does not exist. */
  readonly branch: string
}

export type WorktreeOutcome =
  | { readonly ok: true; readonly path: string; readonly branch: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: string }

/** What `git status --porcelain` said, and therefore whether removal is safe. */
export interface WorktreeState {
  readonly clean: boolean
  /** Porcelain lines, verbatim — the evidence behind a refusal. */
  readonly changes: readonly string[]
}

export type WorktreeRemoval =
  | {
      readonly removed: true
      /**
       * Non-null when git unregistered the worktree but its directory
       * survived, and this could not tidy it — a sentence for the Architect.
       */
      readonly residue: string | null
    }
  | { readonly removed: false; readonly reason: string; readonly changes: readonly string[] }

export interface WorktreesOptions {
  readonly runner: GitRunner
  /**
   * The Agora root. Any repo at or under it is refused — a worktree of the
   * company's own repo is the one thing this class must never make.
   */
  readonly forbiddenRoot: string
}

/**
 * Contract: pure. Whether `branch` belongs to the agent whose own branch is
 * `own` — either it IS that branch, or it is a topic branch beneath it.
 *
 * The agent's branch is a NAMESPACE, not a single name. `agent/<id>` is where a
 * respawn lands by default, but the runbook tells a hire to "push your own
 * `agent/*` branch and open a pull request", and a hire doing exactly that ends
 * up on `agent/<id>-<topic>`. Requiring the exact name read that as somebody
 * else's checkout and refused the respawn — so an agent was punished for having
 * done its job, and because activation is all-or-nothing it took the whole
 * company down with it.
 *
 * Observed live on 2026-09-06: the dependency-updater opened three security
 * pull requests, was left on `agent/…-dependency-updater-pytest-asyncio-14-compat`,
 * and the next activation failed with "worktree refused: … already exists" on a
 * clean checkout of the right repository.
 *
 * The separator is required, so `agent/mason-2` is Mason's and `agent/masonry`
 * is not. Without it the namespace would leak into every id that merely starts
 * with another's, which is exactly the confusion the prefix is meant to avoid.
 */
export function isAgentsOwnBranch(branch: string, own: string): boolean {
  return branch === own || branch.startsWith(`${own}-`)
}

/** Whether a path may host a worktree, or the clause explaining why not. */
export type VacancyVerdict =
  { readonly vacant: true } | { readonly vacant: false; readonly because: string }

/**
 * Contract: pure inspection — reports whether `target` is an empty real
 * directory. Reads the filesystem, changes nothing, never throws.
 *
 * This exists because the refusal it informs is permanent. `create` will not
 * write into a path it cannot prove is the agent's own checkout, which is
 * right — but a path that survived an unwind with its files already gone holds
 * nobody's work, and refusing it retires the agent for good. On Windows that is
 * the ordinary case rather than the exotic one: git deletes a worktree's
 * contents and a held directory handle (OneDrive, a watcher, an open shell)
 * leaves the empty directory standing.
 *
 * Nothing here deletes. `git worktree add` accepts an existing empty directory,
 * so the harness never has to remove one — which is why this reports rather
 * than clears: the module's promise not to destroy anything at the worktree
 * path holds on the new route too, and there is no "could not remove it" state
 * to get wrong.
 *
 * "Empty" carries the whole safety argument, so it is read literally: one entry
 * of any kind, a file where a directory was expected, a link standing in for
 * one (ADR-0021's junction guard — the checkout would land in a directory
 * nobody approved), or a path that cannot be listed at all. Each keeps the
 * refusal.
 */
export function worktreePathIsVacant(target: string): VacancyVerdict {
  let entries: readonly string[]
  try {
    // lstat, not stat: a link here reads as a perfectly ordinary directory
    // while redirecting the checkout somewhere the harness never approved.
    if (!fs.lstatSync(target).isDirectory()) return { vacant: false, because: 'already exists' }
    entries = fs.readdirSync(target)
  } catch (err) {
    // Uninspectable is not empty — the same safe direction `state` takes.
    return {
      vacant: false,
      because: `already exists and could not be read: ${
        err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
      }`
    }
  }
  if (entries.length > 0) return { vacant: false, because: 'already exists' }
  return { vacant: true }
}

export class Worktrees {
  constructor(private readonly options: WorktreesOptions) {}

  /**
   * Contract: creates `plan.path` as a worktree of `plan.repo`, or explains why
   * not. Never throws, and never touches a path inside the Agora.
   *
   * Reuses `plan.branch` when it already exists — a respawn must land on the
   * agent's own branch rather than fail because the branch outlived the last
   * process.
   */
  async create(plan: WorktreePlan): Promise<WorktreeOutcome> {
    const forbidden = path.resolve(this.options.forbiddenRoot)
    const repo = path.resolve(plan.repo)
    if (repo === forbidden || repo.startsWith(forbidden + path.sep)) {
      return {
        ok: false,
        reason: `worktree refused: "${plan.repo}" is inside the Agora, which has exactly one working copy (ADR-0004)`
      }
    }
    const target = path.resolve(plan.path)
    if (target === repo || target.startsWith(repo + path.sep)) {
      return {
        ok: false,
        reason: `worktree refused: "${plan.path}" is inside the target repo, which would dirty it`
      }
    }

    const inside = await this.options.runner.run(repo, ['rev-parse', '--git-dir'])
    if (!inside.ok) {
      return { ok: false, reason: `worktree refused: "${plan.repo}" is not a git repository` }
    }
    if (fs.existsSync(target)) {
      // A worktree that survived a dirty unwind is the agent's kept work
      // (UC-01 2a): respawning onto it is reuse, not failure — refusing here
      // contradicted the card that still names it (M4 close-out audit).
      const head = await this.options.runner.run(target, ['rev-parse', '--abbrev-ref', 'HEAD'])
      const common = await this.options.runner.run(target, ['rev-parse', '--git-common-dir'])
      const branch = head.ok ? head.stdout.trim() : ''
      const owned =
        head.ok &&
        isAgentsOwnBranch(branch, plan.branch) &&
        common.ok &&
        path.resolve(target, common.stdout.trim()).startsWith(repo + path.sep)
      // Reuse it WHERE IT STANDS: the branch it is on is where its work is, and
      // moving it back would strand the commits the agent is about to push.
      if (owned) return { ok: true, path: target, branch, created: false }
      // Not the agent's checkout. Before refusing it forever, ask the only
      // question the refusal is actually protecting: is there anything in
      // there? An empty directory holds no work, and `worktree add` will use
      // it as it stands.
      const vacancy = worktreePathIsVacant(target)
      if (!vacancy.vacant) {
        return { ok: false, reason: `worktree refused: "${plan.path}" ${vacancy.because}` }
      }
      // git may still hold an administrative entry pointing at the path whose
      // files are gone; without this, `worktree add` refuses it as registered.
      await this.options.runner.run(repo, ['worktree', 'prune'])
    }

    const known = await this.options.runner.run(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${plan.branch}`
    ])
    const created = !known.ok
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const args = created
      ? ['worktree', 'add', '-b', plan.branch, target]
      : ['worktree', 'add', target, plan.branch]
    const added = await this.options.runner.run(repo, args)
    if (!added.ok) {
      return { ok: false, reason: `worktree add failed: ${added.stderr.trim() || 'unknown error'}` }
    }
    return { ok: true, path: target, branch: plan.branch, created }
  }

  /** Contract: whether this worktree has uncommitted work. Never throws. */
  async state(worktreePath: string): Promise<WorktreeState> {
    const status = await this.options.runner.run(worktreePath, ['status', '--porcelain'])
    if (!status.ok) {
      // Unreadable is not clean. Refusing to remove something we cannot inspect
      // is the safe direction.
      return { clean: false, changes: [`status failed: ${status.stderr.trim()}`] }
    }
    const changes = status.stdout.split('\n').filter((line) => line.trim().length > 0)
    return { clean: changes.length === 0, changes }
  }

  /**
   * Contract: removes a **clean** worktree and prunes its administrative entry;
   * refuses a dirty one and hands back the changes.
   *
   * `--force` is never passed. An agent that died with unpushed work leaves
   * that work on disk for the Architect, and the refusal names the files.
   */
  async remove(repo: string, worktreePath: string): Promise<WorktreeRemoval> {
    if (!fs.existsSync(worktreePath)) {
      // Already gone: prune the stale administrative entry so the next create
      // at the same path is not refused by git's own bookkeeping.
      await this.options.runner.run(repo, ['worktree', 'prune'])
      return { removed: true, residue: null }
    }
    const state = await this.state(worktreePath)
    if (!state.clean) {
      return {
        removed: false,
        reason: `worktree "${worktreePath}" has ${String(state.changes.length)} uncommitted change(s); left in place`,
        changes: state.changes
      }
    }
    const removed = await this.options.runner.run(repo, ['worktree', 'remove', worktreePath])
    if (!removed.ok) {
      return {
        removed: false,
        reason: `worktree remove failed: ${removed.stderr.trim() || 'unknown error'}`,
        changes: []
      }
    }
    await this.options.runner.run(repo, ['worktree', 'prune'])
    return { removed: true, residue: sweepEmptyResidue(worktreePath) }
  }
}

/**
 * Contract: removes the directory git left behind, and ONLY when it is empty.
 * Returns null when nothing was left or the residue was swept, a sentence when
 * it could not be.
 *
 * `git worktree remove` usually deletes the directory along with the
 * registration. On Windows it has been observed to unregister and leave an
 * empty directory — three of them were sitting in `~/.ephesus/worktrees` on
 * 2026-09-06, unknown to `git worktree list`. Left alone they accumulate, and
 * until `worktreePathIsVacant` learned that an empty directory is vacant the
 * residue of one activation REFUSED the next one for the same agent id.
 *
 * **Empty only, and that is the whole safety argument.** By this point git has
 * said the worktree is gone and `state.clean` said there was nothing
 * uncommitted, so an empty directory is bookkeeping. Anything still inside it
 * is a file nobody accounted for, and deleting that would be precisely the
 * "losing an agent's unpushed work to a tidy-up" this module refuses to do —
 * which is why `--force` appears nowhere here either.
 */
function sweepEmptyResidue(worktreePath: string): string | null {
  try {
    if (!fs.existsSync(worktreePath)) return null
    const entries = fs.readdirSync(worktreePath)
    if (entries.length > 0) {
      return `worktree "${worktreePath}" was removed but ${String(entries.length)} file(s) remain in its directory; left in place`
    }
    fs.rmdirSync(worktreePath)
    return null
  } catch (err) {
    // One catch, one sentence. "Could not read it" and "could not delete it"
    // were two branches saying the same actionable thing — the directory is
    // still there and this could not tidy it — and only one of them was
    // reachable from a test, which is a branch that exists to be uncovered.
    return `worktree "${worktreePath}" was removed but its directory could not be tidied: ${describeError(err)}`
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
}

/**
 * Reading a checkout's remotes (M8.5).
 *
 * It lives here for the same reason the worktrees do: this is the one module
 * allowed to run `git`, and "only main runs git" is only checkable while every
 * invocation is in this file. ADR-0004's rule is about the single COMMITTER —
 * this reads, commits nothing, and never touches the Agora — but the check is
 * literal on purpose, and a second file shelling out to git would defeat it
 * whatever that file did.
 *
 * Contract: never throws. A directory that is not a repository, a git that is
 * not installed, and a repository with no remotes are three different answers,
 * because the Architect gets told which one it was.
 */
export type RemotesRead =
  | { readonly ok: true; readonly remotes: readonly GitRemote[] }
  | { readonly ok: false; readonly because: string }

export async function readRemotes(runner: GitRunner, cwd: string): Promise<RemotesRead> {
  const result = await runner.run(cwd, ['remote', '-v'])
  if (!result.ok) {
    const first = result.stderr.split('\n')[0]?.trim()
    return {
      ok: false,
      // The stderr line, not the path: `git` names the problem better than we
      // can guess at it ("not a git repository", "command not found").
      because:
        first !== undefined && first.length > 0
          ? `git could not read the target's remotes: ${first}`
          : "git could not read the target's remotes"
    }
  }

  // `origin\thttps://github.com/owner/repo.git (fetch)` — one line per remote
  // per direction, so fetch and push both appear and are deduplicated here.
  const seen = new Set<string>()
  const remotes: GitRemote[] = []
  for (const line of result.stdout.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((?:fetch|push)\)\s*$/.exec(line.trim())
    const name = match?.[1]
    const url = match?.[2]
    if (name === undefined || url === undefined) continue
    const key = `${name}\u0000${url}`
    if (seen.has(key)) continue
    seen.add(key)
    remotes.push({ name, url })
  }
  return { ok: true, remotes }
}
