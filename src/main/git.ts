import { execFile } from 'node:child_process'

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
