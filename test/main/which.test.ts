import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExecutable, unwrapWindowsShim } from '../../src/main/which'
import { removeTempDir } from '../tmpdir'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function binDir(files: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-which-'))
  temps.push(dir)
  for (const file of files) fs.writeFileSync(path.join(dir, file), '', 'utf8')
  return dir
}

describe('resolveExecutable (Windows PTY spawn needs a real path)', () => {
  it('returns a command containing a separator unchanged', () => {
    expect(resolveExecutable('C:/tools/claude.exe', {})).toBe('C:/tools/claude.exe')
    expect(resolveExecutable('./local-bin', {})).toBe('./local-bin')
  })

  it('returns the bare name when nothing on PATH matches, so the OS reports the error', () => {
    expect(resolveExecutable('definitely-not-installed', { PATH: binDir([]) })).toBe(
      'definitely-not-installed'
    )
  })

  it('finds an exact filename on PATH', () => {
    const name = process.platform === 'win32' ? 'tool.exe' : 'tool'
    const dir = binDir([name])
    expect(resolveExecutable(name, { PATH: dir })).toBe(path.join(dir, name))
  })

  it('searches PATH entries in order', () => {
    const name = process.platform === 'win32' ? 'dup.exe' : 'dup'
    const first = binDir([name])
    const second = binDir([name])
    expect(resolveExecutable(name, { PATH: `${first}${path.delimiter}${second}` })).toBe(
      path.join(first, name)
    )
  })

  it('ignores empty and quoted PATH entries', () => {
    const name = process.platform === 'win32' ? 'q.exe' : 'q'
    const dir = binDir([name])
    const messy = `${path.delimiter}"${dir}"${path.delimiter}`
    expect(resolveExecutable(name, { PATH: messy })).toBe(path.join(dir, name))
  })

  it.runIf(process.platform === 'win32')(
    'appends PATHEXT extensions in order, which is what an npm shim needs',
    () => {
      const dir = binDir(['claude.cmd', 'claude.exe'])
      // Windows paths are case-insensitive, and the extension comes back in
      // PATHEXT's casing — what matters is which candidate won.
      const resolve = (pathext: string): string =>
        resolveExecutable('claude', { Path: dir, PATHEXT: pathext }).toLowerCase()

      expect(resolve('.EXE;.CMD')).toBe(path.join(dir, 'claude.exe').toLowerCase())
      expect(resolve('.CMD;.EXE')).toBe(path.join(dir, 'claude.cmd').toLowerCase())
    }
  )

  it.runIf(process.platform !== 'win32')('does not invent extensions off Windows', () => {
    const dir = binDir(['claude.cmd'])
    expect(resolveExecutable('claude', { PATH: dir })).toBe('claude')
  })
})

describe('a Windows shim is unwrapped to the executable it invokes', () => {
  /**
   * Why this matters, in one number: a `.cmd` runs under `cmd.exe`, whose
   * command line is capped at 8,191 characters, and Claude Code takes an
   * agent's whole identity on the command line. Pointed at a real repository
   * at M7.7 the orchestrator's identity reached 10,908 bytes and every spawn
   * died with "The command line is too long." Spawning the wrapped executable
   * gets CreateProcess's 32,767 instead.
   */
  const shims: string[] = []

  afterEach(() => {
    for (const dir of shims.splice(0)) removeTempDir(dir)
  })

  function shimDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-shim-'))
    shims.push(dir)
    return dir
  }

  it('follows an npm-style %dp0% shim to a real executable', () => {
    const dir = shimDir()
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg', 'bin'), { recursive: true })
    const exe = path.join(dir, 'node_modules', 'pkg', 'bin', 'tool.exe')
    fs.writeFileSync(exe, 'binary')
    const shim = path.join(dir, 'tool.cmd')
    fs.writeFileSync(
      shim,
      ['@ECHO off', 'SET dp0=%~dp0', '"%dp0%\\node_modules\\pkg\\bin\\tool.exe"   %*', ''].join(
        '\r\n'
      )
    )
    expect(unwrapWindowsShim(shim)).toBe(exe)
  })

  it('refuses to invent a path that is not there', () => {
    const dir = shimDir()
    const shim = path.join(dir, 'tool.cmd')
    // The shim names an exe that does not exist. Returning it would turn a
    // spawn that at least RAN into one that cannot start at all.
    fs.writeFileSync(shim, '"%dp0%\\missing\\tool.exe" %*\r\n')
    expect(unwrapWindowsShim(shim)).toBeNull()
  })

  it('ignores anything that is not a cmd or bat', () => {
    const dir = shimDir()
    const exe = path.join(dir, 'tool.exe')
    fs.writeFileSync(exe, 'binary')
    expect(unwrapWindowsShim(exe)).toBeNull()
  })

  it('returns null for an unreadable or unrecognised shim', () => {
    const dir = shimDir()
    const shim = path.join(dir, 'tool.cmd')
    fs.writeFileSync(shim, '@ECHO off\r\nnode "%dp0%\\cli.js" %*\r\n')
    // A shim wrapping a .js rather than an .exe is not one this understands;
    // the caller keeps the shim rather than getting a guess.
    expect(unwrapWindowsShim(shim)).toBeNull()
    expect(unwrapWindowsShim(path.join(dir, 'no-such.cmd'))).toBeNull()
  })
})
