import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentSpawner } from '../../src/main/agents'
import type { SpawnPlan } from '../../src/main/engines'

/**
 * `AgentSpawner` over real child processes.
 *
 * `PtyManager` is the production implementation and cannot load under the Node
 * test runner (it imports node-pty, which `electron-rebuild` links against
 * Electron's ABI — BUILD-PROMPT §10.3). This is the same seam with
 * `child_process` behind it, which is enough for the one thing S-CRASH needs
 * and cannot fake: a **real process that can really be SIGKILLed**. A stubbed
 * spawner would let the scenario pass with the whole crash path deleted.
 *
 * ## Why this fake keeps a record of failure
 *
 * It used to throw failure away. `stderr` was drained to nothing with
 * `stderr.resume()`, and a child that could not start at all was handled with
 * `child.on('error', () => this.children.delete(id))` — no record, no exit, no
 * sign anywhere that a process had been asked for and never arrived.
 *
 * On 2026-09-01 that cost hours. A quoting bug in the engine version probe
 * (`src/main/agents.ts`) made every spawn take the FR-1.6 install branch, so
 * seven tests across `agent-worktree` and `s-crash` failed as
 * `timed out waiting for the agent to start` — a symptom three layers from its
 * cause, naming nothing. The cause became obvious the moment this file was
 * instrumented by hand to print one line it had been discarding. Test
 * infrastructure that hides why a test failed costs more than the test is
 * worth, so the instrumentation is now permanent and `diagnose()` is what a
 * timeout reports.
 *
 * ## Where it deliberately differs from the real thing
 *
 * A PTY has ONE stream: `PtyManager` hands the Architect stdout and stderr
 * already merged, so in production nothing a child prints is invisible.
 * `child_process` splits them, and this class keeps them split — `stdoutOf` is
 * still stdout alone, because tests assert on it and a merged buffer would let
 * a stray stderr line satisfy an assertion about what the agent *said*.
 * `stderrOf` is kept beside it rather than folded in, and `diagnose()` reports
 * both.
 */
export class ProcessSpawner implements AgentSpawner {
  private readonly children = new Map<string, ChildProcess>()
  private readonly exitHandlers: ((id: string, exitCode: number) => void)[] = []
  private readonly output = new Map<string, string>()
  private readonly errOutput = new Map<string, string>()
  /** What was asked for, kept so a failure can say what it tried to run. */
  private readonly plans = new Map<string, { command: string; args: string[]; cwd: string }>()
  /** Spawn failures — the case that used to vanish entirely. */
  private readonly failures = new Map<string, string>()
  private readonly exits = new Map<string, { code: number | null; signal: string | null }>()
  /** Ids whose exit handlers have already run, so `error` + `exit` cannot double-fire. */
  private readonly reaped = new Set<string>()

  spawnAgent(id: string, plan: SpawnPlan): void {
    const [command, ...args] = plan.argv
    if (command === undefined) throw new Error(`process-spawner: empty argv for "${id}"`)
    this.plans.set(id, { command, args, cwd: plan.cwd })
    this.output.set(id, '')
    this.errOutput.set(id, '')
    this.failures.delete(id)
    this.exits.delete(id)
    this.reaped.delete(id)

    const child = spawn(command, args, {
      cwd: plan.cwd,
      env: { ...plan.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.children.set(id, child)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      this.output.set(id, (this.output.get(id) ?? '') + chunk)
    })
    // KEPT, not drained. This is where a child says why it is about to die, and
    // `stderr.resume()` was throwing exactly that away.
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.errOutput.set(id, (this.errOutput.get(id) ?? '') + chunk)
    })

    child.on('error', (err: Error) => {
      // The process could not be spawned at all (ENOENT, EACCES…). Node says
      // `exit` MAY OR MAY NOT follow an `error`, so this reaps the id itself and
      // guards against reporting the same death twice.
      //
      // Reaping rather than staying silent is the faithful choice: production
      // fails LOUDER than this, not quieter — `pty.spawn` throws synchronously
      // out of `PtyManager.spawnAgent`, so a failed spawn there is an exception
      // the manager must handle. `child_process` only emits an async `error`,
      // and swallowing it left the manager believing an agent existed that
      // never had.
      this.children.delete(id)
      this.failures.set(id, err.message)
      this.reap(id, -1)
    })

    child.on('exit', (code, signal) => {
      this.children.delete(id)
      this.exits.set(id, { code, signal })
      // A SIGKILLed process reports a null code; the harness's contract is a
      // number, and -1 says "died on a signal" rather than "exited cleanly".
      this.reap(id, code ?? -1)
    })
  }

  /** Fires the exit handlers once per spawn, whatever killed it. */
  private reap(id: string, exitCode: number): void {
    if (this.reaped.has(id)) return
    this.reaped.add(id)
    for (const handler of this.exitHandlers) handler(id, exitCode)
  }

  write(id: string, data: string): void {
    this.children.get(id)?.stdin?.write(data)
  }

  /** SIGKILL: the crash S-CRASH is about, not a polite shutdown. */
  kill(id: string): void {
    this.children.get(id)?.kill('SIGKILL')
  }

  has(id: string): boolean {
    return this.children.has(id)
  }

  onExit(cb: (id: string, exitCode: number) => void): void {
    this.exitHandlers.push(cb)
  }

  /** Everything this spawn has printed to stdout — how the agent reports back. */
  stdoutOf(id: string): string {
    return this.output.get(id) ?? ''
  }

  /** Everything this spawn has printed to stderr — how it says what went wrong. */
  stderrOf(id: string): string {
    return this.errOutput.get(id) ?? ''
  }

  /** The spawn error for an id that never started, or null. */
  failureOf(id: string): string | null {
    return this.failures.get(id) ?? null
  }

  /**
   * Everything known about the spawns, as text fit for a failure message.
   *
   * Contract: never throws and never blocks — it is called from the unhappy
   * path, where an exception of its own would bury the failure it exists to
   * explain. Returns a short line per spawn: what ran, where, whether it is
   * alive, how it ended, and the tail of each stream.
   *
   * Pass no `id` for every spawn this rig made, which is the useful default
   * when the thing that timed out is "no agent ever appeared".
   */
  diagnose(id?: string): string {
    const ids = id === undefined ? [...this.plans.keys()] : [id]
    if (ids.length === 0) return 'no process was ever spawned'
    return ids
      .map((each) => {
        const plan = this.plans.get(each)
        if (plan === undefined) return `${each}: never spawned`
        const parts = [`cwd=${plan.cwd}`, `argv=${[plan.command, ...plan.args].join(' ')}`]
        const failure = this.failures.get(each)
        if (failure !== undefined) parts.push(`SPAWN FAILED: ${failure}`)
        const exit = this.exits.get(each)
        if (exit !== undefined)
          parts.push(`exit=${exit.code ?? 'null'} signal=${exit.signal ?? 'none'}`)
        else if (this.children.has(each)) parts.push('still running')
        const out = tail(this.output.get(each) ?? '')
        const err = tail(this.errOutput.get(each) ?? '')
        parts.push(`stdout=${out.length === 0 ? '(empty)' : JSON.stringify(out)}`)
        parts.push(`stderr=${err.length === 0 ? '(empty)' : JSON.stringify(err)}`)
        return `${each}: ${parts.join(' | ')}`
      })
      .join('\n')
  }

  /** Kills anything still alive; teardown must not leak processes into CI. */
  killAll(): void {
    for (const id of [...this.children.keys()]) this.kill(id)
  }
}

/** The last of a stream, which is where a dying process says why. */
function tail(text: string, limit = 400): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}
