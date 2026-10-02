import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeTempDir } from '../tmpdir'

/**
 * Imports a shim from a file that is not the shim, in a process of its own, and
 * reports what that process did.
 *
 * Every shim ends in a guard that runs `main()` only when the shim is the
 * program, which is what lets a test import its helpers at all. That importing
 * it runs nothing is a fact about a whole process — its stdin, its stdout and
 * stderr, and what it asks of the harness — so it is observable only from
 * outside one.
 *
 * The importer is a FILE, never `node -e`: under `-e`, `process.argv[1]` is not
 * a module path (it is undefined, or the first script argument), so the
 * comparison the guard really makes — a module path that is not the shim's —
 * would never happen. The file's name is the other half: `x-eph-hook.mjs` ends
 * in the shim's name, and only a whole-name comparison tells it from the shim.
 *
 * Once the import settles, the importer records `process.stdin.readableFlowing`
 * — `null` until something attaches a reader or resumes the stream — and then
 * reads stdin to the end itself, so a shim that took any of it leaves a shorter
 * document behind.
 *
 * The spawn is asynchronous because the endpoint a stray `main()` would call is
 * served by the test's own process: `spawnSync` would block the loop that
 * answers it (DECISIONS-LOG 2026-10-02).
 */

export interface ImporterRun {
  /** The exit code; `null` when the child was killed, which is how a timeout shows. */
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** `String(process.stdin.readableFlowing)` once the import settled; `null` if never recorded. */
  readonly flowing: string | null
  /** What the importer could still read from stdin afterwards; `null` if never recorded. */
  readonly unread: string | null
}

export interface ImporterOptions {
  /** The shim to import. */
  readonly shim: URL
  /** The importer's own file name. */
  readonly name: string
  /** What `main()` would act on, handed to the importer as if it were the shim. */
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly input: string
}

const TIMEOUT_MS = 10_000

export async function runImporter(options: ImporterOptions): Promise<ImporterRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-importer-'))
  try {
    const importer = path.join(dir, options.name)
    const flowing = path.join(dir, 'stdin-flowing.txt')
    const unread = path.join(dir, 'stdin-unread.txt')
    fs.writeFileSync(
      importer,
      [
        `import fs from 'node:fs'`,
        `await import(${JSON.stringify(options.shim.href)})`,
        `fs.writeFileSync(${JSON.stringify(flowing)}, String(process.stdin.readableFlowing))`,
        `let rest = ''`,
        `for await (const chunk of process.stdin) rest += chunk`,
        `fs.writeFileSync(${JSON.stringify(unread)}, rest)`,
        ''
      ].join('\n'),
      'utf8'
    )
    // The caller's environment, minus NODE_OPTIONS: a loader or flag there makes
    // Node itself write to stderr, which would fail a test for nothing the shim did.
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env }
    delete env['NODE_OPTIONS']

    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [importer, ...options.args], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: TIMEOUT_MS
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk
        })
        // A child that exits before reading stdin closes the pipe under this
        // write. Its exit code and the missing records already say so.
        child.stdin.on('error', () => undefined)
        child.on('error', reject)
        child.on('close', (status) => resolve({ status, stdout, stderr }))
        child.stdin.end(options.input)
      }
    )

    const recorded = (file: string): string | null =>
      fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    return { ...run, flowing: recorded(flowing), unread: recorded(unread) }
  } finally {
    removeTempDir(dir)
  }
}
