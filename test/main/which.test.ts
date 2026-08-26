import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveExecutable } from '../../src/main/which'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
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
