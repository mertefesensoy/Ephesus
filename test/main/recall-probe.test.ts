import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  probeRecallCommand,
  reportRecallProbe,
  runRecallProbe,
  shellCommand
} from '../../src/main/recall-probe'
import { recallProbeCondition } from '../../src/shared/recall'

/**
 * **M8c.7 — recall must fail fast or not accept the call.**
 *
 * Finding 9 of the M8 exit run, in the health-watcher's own words:
 *
 * > `$EPH_RECALL` is **unavailable, not merely empty**. Two attempts (unscoped,
 * > and `--scope knowledge`) produced **zero bytes of output and never
 * > terminated**; the second was **killed at 90s, exit 143**. So I could not
 * > fall back on a colleague's transcription of the runbook either, and **no
 * > agent can currently look anything up**.
 *
 * `DIAGNOSIS.md` disclosed the MemPalace degradation and nothing else, so a
 * reader believed recall had gracefully degraded to a lesser rung. A missing
 * optional that degrades is the documented design; **a path that accepts the
 * call, returns nothing and never returns is a ninety-second timeout trap
 * disclosed nowhere.**
 *
 * The cause was not in the shim. `eph-recall.mjs` has had a ten-second timeout
 * and named refusals since it was written, and it never ran — `EPH_RECALL` is
 * built from `process.execPath`, which is Electron, and Electron handed a `.mjs`
 * treats it as an app to load. Exit 143 is SIGTERM: the agent gave up on it.
 */
describe('a recall command that never answers is a condition (M8c.7)', () => {
  const probe = {
    command: '/bin/electron /shims/eph-recall.mjs',
    code: null,
    timedOut: false,
    output: ''
  }

  it('reports a command that never answered', () => {
    const condition = recallProbeCondition({ ...probe, timedOut: true })

    expect(condition?.cause).toBe('library/recall-command')
    expect(condition?.detail).toContain('never answered')
    // The distinction the report failed to make on 2026-09-09.
    expect(condition?.detail).toContain('NOT the documented MemPalace')
    // And the consequence, which is what makes it worth a condition at all.
    expect(condition?.detail).toContain('none of them can tell you why')
  })

  it('reports a command that exited without saying anything', () => {
    const condition = recallProbeCondition({ ...probe, code: 0 })

    expect(condition?.cause).toBe('library/recall-command')
    expect(condition?.detail).toContain('answered nothing (exit 0)')
  })

  it('names the command, so the reader can run it themselves', () => {
    expect(recallProbeCondition({ ...probe, timedOut: true })?.detail).toContain(
      '/bin/electron /shims/eph-recall.mjs'
    )
  })

  it('reports NOTHING when the command answered — a refusal is an answer', () => {
    // `eph-recall` exits 1 with a named cause when the harness is down, and
    // that is the shim WORKING: the agent learns something. Treating a refusal
    // as a fault would make this condition fire on every correct install.
    expect(
      recallProbeCondition({
        ...probe,
        code: 1,
        output: 'recall unavailable: this process was not started by the harness'
      })
    ).toBeNull()
  })

  it('reports nothing for an ordinary successful answer', () => {
    expect(
      recallProbeCondition({ ...probe, code: 0, output: 'recall: 0 result(s) for "x" [fts]' })
    ).toBeNull()
  })

  it('CONTROL — silence and an answer are told apart by OUTPUT, not by exit code', () => {
    // The 2026-09-09 process was killed, so its code says nothing about whether
    // recall works. A check keyed on the exit code alone would have passed the
    // hang (no code) and failed the working refusal (code 1) — both backwards.
    expect(recallProbeCondition({ ...probe, code: 1, output: 'named cause' })).toBeNull()
    expect(recallProbeCondition({ ...probe, code: 0, output: '' })).not.toBeNull()
  })
})

describe('the probe runs the command an agent would actually run', () => {
  it('hands the decision the process result, and reports nothing on an answer', async () => {
    const condition = await probeRecallCommand({ command: 'irrelevant', env: {} }, () =>
      Promise.resolve({
        command: 'irrelevant',
        code: 1,
        timedOut: false,
        output: 'recall unavailable: named'
      })
    )

    expect(condition).toBeNull()
  })

  it('reports the condition when the injected run says nothing came back', async () => {
    const condition = await probeRecallCommand({ command: 'irrelevant', env: {} }, () =>
      Promise.resolve({ command: 'irrelevant', code: null, timedOut: true, output: '' })
    )

    expect(condition?.cause).toBe('library/recall-command')
  })

  it('really does spawn, and a command that says nothing is caught', async () => {
    // Not a stub: the whole finding is that nobody ever ran the command. A real
    // process that exits silently is the shape the trap had.
    const probe = await runRecallProbe({
      command: `${shellCommand(process.execPath, '-e')} "process.exit(0)"`,
      env: {},
      timeoutMs: 20_000
    })

    expect(probe.timedOut).toBe(false)
    expect(recallProbeCondition(probe)?.cause).toBe('library/recall-command')
  }, 30_000)

  it('really does spawn, and a command that ANSWERS is not a condition', async () => {
    const probe = await runRecallProbe({
      command: `${shellCommand(process.execPath, '-e')} "console.log('recall: 0 result(s)')"`,
      env: {},
      timeoutMs: 20_000
    })

    expect(probe.output).toContain('recall: 0 result(s)')
    expect(recallProbeCondition(probe)).toBeNull()
  }, 30_000)

  it('gives up on a command that hangs, rather than becoming the hang', async () => {
    // The boot must not wait on this. A probe that inherited the defect it
    // exists to report would be the M6 Herald shape with the roles reversed.
    const started = Date.now()
    const probe = await runRecallProbe({
      command: `${shellCommand(process.execPath, '-e')} "setTimeout(()=>{}, 60000)"`,
      env: {},
      timeoutMs: 1_500
    })

    expect(probe.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(recallProbeCondition(probe)?.detail).toContain('never answered')
  }, 30_000)
})

describe('a command that cannot be started at all', () => {
  it('reports it, with the system’s own reason', async () => {
    // Reachable only through the seam: with `shell: true` node emits `error`
    // when the SHELL cannot start, which a test cannot honestly produce. The
    // listener is still required — a child process without one throws — so the
    // choice is a branch nothing can cover or a seam that can.
    const probe = await runRecallProbe({ command: 'anything', env: {} }, () => {
      const handlers: Record<string, (value: never) => void> = {}
      queueMicrotask(() =>
        (handlers['error'] as unknown as (err: Error) => void)?.(new Error('spawn EACCES'))
      )
      return {
        stdout: null,
        stderr: null,
        on: (event: string, cb: (value: never) => void) => {
          handlers[event] = cb
          return undefined
        },
        kill: () => undefined
      }
    })

    expect(probe.timedOut).toBe(false)
    expect(probe.code).toBeNull()
    const condition = recallProbeCondition(probe)
    expect(condition?.detail).toContain('could not be run — spawn EACCES')
  })

  it('says so even when the system gave no reason', async () => {
    const probe = await runRecallProbe({ command: 'anything', env: {} }, () => {
      const handlers: Record<string, (value: never) => void> = {}
      queueMicrotask(() => (handlers['error'] as unknown as (err: Error) => void)?.(new Error('')))
      return {
        stdout: null,
        stderr: null,
        on: (event: string, cb: (value: never) => void) => {
          handlers[event] = cb
          return undefined
        },
        kill: () => undefined
      }
    })

    expect(recallProbeCondition(probe)?.detail).toContain('no reason given')
  })
})

describe('the command an agent is handed survives a path with a space', () => {
  it('quotes both halves', () => {
    // The defect this exists for: an unquoted `C:\Program Files\…\node.exe` is
    // three words to a shell, and the agent gets `C:\Program` not found.
    const program = ['C:', 'Program Files', 'nodejs', 'node.exe'].join(path.sep)
    const script = ['C:', 'My Apps', 'eph-recall.mjs'].join(path.sep)

    expect(shellCommand(program, script)).toBe(`"${program}" "${script}"`)
    expect(shellCommand(program, script).split('"')).toHaveLength(5)
  })

  it('really runs, with a space in the program path', async () => {
    // `process.execPath` on this machine may or may not contain a space, so the
    // assertion is that the QUOTED form runs whatever it is — which the
    // unquoted form did not, on the machine that wrote this.
    const probe = await runRecallProbe({
      command: `${shellCommand(process.execPath, '-e')} "console.log('ok')"`,
      env: {},
      timeoutMs: 20_000
    })

    expect(probe.output).toContain('ok')
    expect(recallProbeCondition(probe)).toBeNull()
  }, 30_000)
})

describe('what boot actually calls', () => {
  it('reports the condition through the degradation channel', async () => {
    const reported: { cause: string; detail: string }[] = []

    await reportRecallProbe(
      { command: 'x', env: {} },
      (cause, detail) => reported.push({ cause, detail }),
      () => Promise.resolve({ command: 'x', code: null, timedOut: true, output: '' })
    )

    expect(reported).toHaveLength(1)
    expect(reported[0]?.cause).toBe('library/recall-command')
  })

  it('reports nothing when recall answers', async () => {
    const reported: string[] = []

    await reportRecallProbe(
      { command: 'x', env: {} },
      (cause) => reported.push(cause),
      () =>
        Promise.resolve({ command: 'x', code: 0, timedOut: false, output: 'recall: 0 result(s)' })
    )

    expect(reported).toEqual([])
  })

  it('never rejects, so a probe that threw cannot take the boot with it', async () => {
    const reported: string[] = []

    await expect(
      reportRecallProbe(
        { command: 'x', env: {} },
        (cause) => reported.push(cause),
        () => Promise.reject(new Error('the probe itself broke'))
      )
    ).resolves.toBeUndefined()
    // And it says nothing, because a probe that threw has told us nothing about
    // recall — reporting a condition on its own failure would be a diagnostic
    // inventing the fault it exists to find.
    expect(reported).toEqual([])
  })
})
