import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeVersion } from '../../src/main/agents'
import type { BinarySpec } from '../../src/main/engines'
import { removeTempDir } from '../tmpdir'

/**
 * The engine version probe, run against real shims on disk (TEST-STRATEGY §2).
 *
 * This is a seam test on purpose. Both halves were fine: `probeVersion` shells
 * out correctly, and every adapter declares its `versionProbe` correctly. What
 * was wrong lived between them — the shell re-splits the command string on
 * whitespace, so an adapter that names an absolute path probed as *absent*.
 *
 * The consequence is not a crash, which is why it hid: core reads null as "the
 * engine is not installed" and answers with the FR-1.6 install offer. The agent
 * sits in `installing` forever, running an installer for a binary already on
 * disk, and the settings the spawn was supposed to write never get written.
 *
 * A path with a space is the normal case on Windows, not an exotic one —
 * `C:\Program Files\` is where installers put things.
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

const WINDOWS = process.platform === 'win32'

/**
 * Writes an executable shim that reports a version, inside a directory whose
 * name contains a space. On Windows it is a `.cmd` — the same shape as the real
 * `claude` shim, and the reason the probe needs a shell at all.
 */
function shimPrinting(text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph probe-'))
  temps.push(root)
  const dir = path.join(root, 'Program Files', 'engine vendor')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, WINDOWS ? 'engine.cmd' : 'engine.sh')
  fs.writeFileSync(file, WINDOWS ? `@echo off\r\necho ${text}\r\n` : `#!/bin/sh\necho "${text}"\n`)
  if (!WINDOWS) fs.chmodSync(file, 0o755)
  return file
}

function spec(command: string, args: readonly string[] = ['--version']): BinarySpec {
  return {
    name: command,
    install: { command: 'echo', args: ['pretend-install'] },
    versionProbe: { command, args },
    parseVersion: (stdout) => /v?(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null
  }
}

/**
 * Writes a shim that reports a version only when it receives its argument as a
 * SINGLE word — the shape that catches an argument split by the shell.
 */
function shimRequiringArg(arg: string, text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph probe-'))
  temps.push(root)
  const file = path.join(root, WINDOWS ? 'engine.cmd' : 'engine.sh')
  fs.writeFileSync(
    file,
    WINDOWS
      ? `@echo off\r\nif "%~1"=="${arg}" echo ${text}\r\n`
      : `#!/bin/sh\n[ "$1" = "${arg}" ] && echo "${text}"\nexit 0\n`
  )
  if (!WINDOWS) fs.chmodSync(file, 0o755)
  return file
}

describe('the engine version probe', () => {
  it('finds an engine whose path contains a space', async () => {
    expect(await probeVersion(spec(shimPrinting('v1.2.3')))).toBe('1.2.3')
  })

  /**
   * The exact shape that broke: an adapter naming an interpreter by absolute
   * path. `process.execPath` is `C:\Program Files\nodejs\node.exe` on a default
   * Windows install, which is what took the worktree and crash scenarios down.
   */
  it('finds an interpreter named by absolute path', async () => {
    expect(await probeVersion(spec(process.execPath))).toMatch(/^\d+\.\d+\.\d+$/)
  })

  /**
   * The other half of the contract, and the reason quoting had to be narrow
   * rather than blanket: a genuinely absent binary must still answer null, so
   * FR-1.6 can offer to install it. Quoting a missing path must not turn a
   * "not here" into something that looks present.
   */
  it('still reports an absent engine as absent, spaces or not', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph probe-'))
    temps.push(root)
    expect(
      await probeVersion(spec(path.join(root, 'Program Files', 'nothing here.exe')))
    ).toBeNull()
  })

  /**
   * An adapter is allowed to quote its own command, and some shells need it.
   * Quoting it a second time would produce `""C:\...""`, which is exactly the
   * breakage this fix exists to remove — so the quoting has to be able to see
   * that the work is already done.
   */
  it.runIf(WINDOWS)('leaves a command the adapter already quoted alone', async () => {
    expect(await probeVersion(spec(`"${shimPrinting('v4.5.6')}"`))).toBe('4.5.6')
  })

  /**
   * Arguments go through the same splitter as the command, and this is the half
   * that is easy to miss: quoting the command alone still delivers `hello world`
   * to the child as `hello`. No shipped adapter passes a spaced probe argument
   * today — they all pass `--version` — but `BinarySpec` permits one, and the
   * failure would look like a version the engine refused to report rather than
   * like a quoting bug.
   */
  it('passes an argument containing a space as ONE argument', async () => {
    const shim = shimRequiringArg('hello world', 'v2.3.4')
    expect(await probeVersion(spec(shim, ['hello world']))).toBe('2.3.4')
  })

  it('leaves an argument that needs no quoting untouched', async () => {
    const shim = shimRequiringArg('--version', 'v3.4.5')
    expect(await probeVersion(spec(shim, ['--version']))).toBe('3.4.5')
  })

  it('reports null when the probe runs but says nothing a version can be read from', async () => {
    expect(await probeVersion(spec(shimPrinting('no version here')))).toBeNull()
  })
})
