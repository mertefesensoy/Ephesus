import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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
  | { readonly removed: true }
  | { readonly removed: false; readonly reason: string; readonly changes: readonly string[] }

export interface WorktreesOptions {
  readonly runner: GitRunner
  /**
   * The Agora root. Any repo at or under it is refused — a worktree of the
   * company's own repo is the one thing this class must never make.
   */
  readonly forbiddenRoot: string
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
      return { ok: false, reason: `worktree refused: "${plan.path}" already exists` }
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
      return { removed: true }
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
    return { removed: true }
  }
}
