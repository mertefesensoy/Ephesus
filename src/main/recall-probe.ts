import { spawn } from 'node:child_process'
import { recallProbeCondition, type RecallProbe } from '../shared/recall'
import type { DegradationCause } from '../shared/degradation'

/**
 * Does the agent-facing recall command actually answer? (M8c.7)
 *
 * The M8 exit run's Finding 9 was not a bug in `eph-recall.mjs`. That shim has
 * had a ten-second timeout and named refusals since it was written, and it
 * **never ran**: `EPH_RECALL` is built from `process.execPath`, which in this
 * app is Electron rather than Node, and Electron handed a `.mjs` path treats it
 * as an app to load rather than a script to run. It starts, finds no entry
 * point, and sits there — zero bytes, no exit, until the agent kills it at 90s.
 *
 * `ELECTRON_RUN_AS_NODE` fixes that (see `claude.ts`). This exists because the
 * fix is invisible when it works and was invisible when it did not: a command
 * the harness composes and never runs itself is a command nothing checks. The
 * probe runs it once, at boot, with a trivial query and a short deadline, so a
 * configuration that cannot answer is a CONDITION rather than a trap every agent
 * discovers separately and expensively.
 *
 * An answer is enough, including a refusal — `eph-recall` exiting 1 with a named
 * cause is the shim working. What this catches is nothing coming back at all.
 */
/**
 * Contract: pure. One shell-safe command line from a program and its argument.
 *
 * Every part is double-quoted, because these strings are handed to AGENTS to run
 * in their own shell and an unquoted path splits at the first space — which
 * `C:\Program Files
odejs
ode.exe` has, and which is how the first real spawn
 * in this package's own tests failed. Both `cmd.exe` and POSIX shells treat a
 * double-quoted argument as one word.
 *
 * It does not try to escape a path containing a double quote. A filesystem path
 * with a `"` in it is not legal on Windows and is pathological elsewhere;
 * pretending to handle it would be a branch no test could honestly produce.
 */
export function shellCommand(program: string, argument: string): string {
  return `"${program}" "${argument}"`
}

export interface RecallProbeOptions {
  /** The command string as `EPH_RECALL` would hand it to an agent. */
  readonly command: string
  /** The environment an agent gets, so the probe tests what the agent runs. */
  readonly env: Readonly<Record<string, string>>
  /**
   * Long enough for a cold Node start on a loaded machine, short enough that a
   * hung boot is not one of the things this is meant to prevent.
   */
  readonly timeoutMs?: number
}

/**
 * What `runRecallProbe` needs of a child process, and no more.
 *
 * Injected so the error path is reachable from a test. With `shell: true`, node
 * emits `error` only when the SHELL itself cannot be started — a state a test
 * cannot honestly produce and a running machine hardly ever reaches. The
 * listener is still required: a child process with no `error` handler throws.
 * So the choice is a branch nothing can cover or a seam that can, and this
 * repository has already decided that a branch existing to be uncovered is the
 * worse of the two.
 */
export interface ProbeChild {
  readonly stdout: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  readonly stderr: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'close', cb: (code: number | null) => void): unknown
  kill(): unknown
}

/** Contract: runs the command once and reports what came back. Never throws. */
export function runRecallProbe(
  options: RecallProbeOptions,
  start: (command: string, env: Readonly<Record<string, string>>) => ProbeChild = (command, env) =>
    // A shell, because `EPH_RECALL` is a command STRING an agent pastes into
    // one — testing it any other way would test something the agent never runs.
    spawn(command, { shell: true, env: { ...process.env, ...env }, windowsHide: true })
): Promise<RecallProbe> {
  const timeoutMs = options.timeoutMs ?? 8_000
  return new Promise<RecallProbe>((resolve) => {
    const child = start(`${options.command} "ephesus recall probe"`, options.env)
    let output = ''
    let settled = false
    const finish = (probe: RecallProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(probe)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ command: options.command, code: null, timedOut: true, output: output.trim() })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      // A command that cannot be spawned at all HAS answered, in the only way
      // it can: the message is the finding, and the caller reports it.
      finish({ command: options.command, code: null, timedOut: false, output: err.message })
    })
    child.on('close', (code) => {
      finish({ command: options.command, code, timedOut: false, output: output.trim() })
    })
  })
}

/**
 * Contract: probes the command and hands back the condition to report, or null.
 *
 * Split from `runRecallProbe` so the DECISION is pure and testable without a
 * process, and the process work has nothing to decide — the split this
 * repository makes everywhere a judgement sits next to a side effect.
 */
export async function probeRecallCommand(
  options: RecallProbeOptions,
  run: (options: RecallProbeOptions) => Promise<RecallProbe> = runRecallProbe
): Promise<{ readonly cause: string; readonly detail: string } | null> {
  return recallProbeCondition(await run(options))
}

/**
 * Contract: probes, and reports the condition if there is one. Never throws,
 * never rejects, and never keeps the caller waiting.
 *
 * This exists so `index.ts` holds one call and no closures. The `boot` coverage
 * row measures how true *"index.ts holds no logic of its own"* is, and a
 * `.then(…, …)` there is two functions no test can enter — which is the same
 * refusal that reshaped M8c.8, and it was right about the design both times.
 */
export function reportRecallProbe(
  options: RecallProbeOptions,
  report: (cause: DegradationCause, detail: string) => void,
  run: (options: RecallProbeOptions) => Promise<RecallProbe> = runRecallProbe
): Promise<void> {
  return probeRecallCommand(options, run).then(
    (condition) => {
      if (condition !== null) report(condition.cause as DegradationCause, condition.detail)
    },
    // A probe that threw has told us nothing about recall, and a boot that
    // failed over a diagnostic would be worse than the diagnostic missing.
    () => undefined
  )
}
