import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ATOMIC_RENAME_BUDGET_MS, writeFileAtomic } from '../../src/main/fsx'
import { renameBlocks, type RenameProbe } from '../pin'
import { removeTempDir } from '../tmpdir'

/**
 * The atomic write (BUILD-PROMPT §3.3) — temp file plus rename, which is what
 * every file another process may read goes through.
 *
 * ## The blind spot, stated because a green run would otherwise hide it
 *
 * The retry these tests are mostly about can only be provoked on Windows.
 * Holding the destination open there makes `renameSync` fail with `EPERM` and
 * leaves the OLD contents in place — the write is lost. On POSIX the same
 * rename succeeds: the reader keeps the old inode and nothing fails. So on CI
 * (ubuntu-latest) the retry is unreachable, and a test asserting the block
 * would FAIL rather than merely prove nothing.
 *
 * Those cases are therefore guarded on `renameBlocks()`, measured at run time.
 * Where it does not block, the retry is simply not covered — and the probe
 * failing to answer is a FAILURE here, not a skip, because "no block" and
 * "never actually contended" are indistinguishable from the outside.
 */

const PROBE: RenameProbe =
  process.env['EPH_FORCE_NO_RENAME_BLOCK'] === '1' ? { blocks: false } : renameBlocks()
const RENAME_BLOCKS = PROBE.blocks === true

const temps: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-fsx-'))
  temps.push(dir)
  return dir
}

/** Leftover `.tmp` files are the residue this whole design exists to avoid. */
const strays = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n.includes('.tmp'))

/**
 * Holds `target` open from ANOTHER process for `holdMs`, then releases it.
 *
 * Another process, not this one, because the retry blocks the thread: a handle
 * this thread was supposed to close on a timer would never be released, and the
 * test would measure the budget expiring rather than the retry working.
 * Resolves only once the handle is confirmed open.
 */
async function heldOpenElsewhere(target: string, holdMs: number): Promise<void> {
  const flag = `${target}.held`
  const source =
    `const fs = require('fs');` +
    ` const fd = fs.openSync(${JSON.stringify(target)}, 'r');` +
    ` fs.writeFileSync(${JSON.stringify(flag)}, 'x');` +
    ` setTimeout(() => fs.closeSync(fd), ${String(holdMs)})`
  const child = spawn(process.execPath, ['-e', source], { stdio: 'ignore' })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  for (let i = 0; i < 600 && !fs.existsSync(flag); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!fs.existsSync(flag)) throw new Error('the holding child never opened the destination')
  fs.rmSync(flag, { force: true })
}

describe.skipIf(PROBE.blocks !== null)('the rename probe', () => {
  it('could not determine whether this platform blocks a held rename', () => {
    expect.fail(PROBE.blocks === null ? PROBE.reason : 'unreachable')
  })
})

describe('writeFileAtomic — on any platform', () => {
  it('writes a new file and leaves no temp residue', () => {
    const dir = tempDir()
    const target = path.join(dir, 'cursor.json')

    writeFileAtomic(target, '{"schemaVersion":1}')

    expect(fs.readFileSync(target, 'utf8')).toBe('{"schemaVersion":1}')
    expect(strays(dir)).toEqual([])
  })

  it('replaces an existing file rather than appending to it', () => {
    const dir = tempDir()
    const target = path.join(dir, 'registry.json')
    writeFileAtomic(target, 'first')

    writeFileAtomic(target, 'second')

    expect(fs.readFileSync(target, 'utf8')).toBe('second')
    expect(strays(dir)).toEqual([])
  })

  it('writes a Buffer verbatim, without re-encoding it (ADR-0009)', () => {
    const dir = tempDir()
    const target = path.join(dir, 'settings.bin')
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80])

    writeFileAtomic(target, bytes)

    expect(fs.readFileSync(target).equals(bytes)).toBe(true)
  })

  it('rethrows a permanent failure at once instead of spending the budget', () => {
    const dir = tempDir()
    // Windows reports EPERM for renaming over a DIRECTORY too — the same code a
    // transient hold gives. It is permanent and a caller bug, so it must not be
    // waited on.
    const target = path.join(dir, 'a-directory')
    fs.mkdirSync(target, { recursive: true })
    const startedAt = Date.now()

    expect(() => writeFileAtomic(target, 'nope')).toThrow()

    expect(Date.now() - startedAt).toBeLessThan(ATOMIC_RENAME_BUDGET_MS)
    // And the temp file is not left behind on the failure path.
    expect(strays(dir)).toEqual([])
  })

  it('keeps the budget small enough to bound a stall on the main process', () => {
    // It blocks the thread, so this is a latency ceiling, not a patience knob.
    expect(ATOMIC_RENAME_BUDGET_MS).toBeGreaterThan(0)
    expect(ATOMIC_RENAME_BUDGET_MS).toBeLessThanOrEqual(1_000)
  })
})

describe.skipIf(!RENAME_BLOCKS)('writeFileAtomic — when the destination is briefly held', () => {
  it('waits the holder out and lands the write, instead of losing it', async () => {
    const dir = tempDir()
    const target = path.join(dir, 'cursor.json')
    writeFileAtomic(target, 'old')
    await heldOpenElsewhere(target, 250)

    // Unretried this threw, and the write was gone — a lost cursor write
    // surfacing as a degradation rather than as the transient it was.
    expect(() => writeFileAtomic(target, 'new')).not.toThrow()

    expect(fs.readFileSync(target, 'utf8')).toBe('new')
    expect(strays(dir)).toEqual([])
  })

  it('still throws, and cleans up, when the destination is never released', async () => {
    const dir = tempDir()
    const target = path.join(dir, 'cursor.json')
    writeFileAtomic(target, 'old')
    await heldOpenElsewhere(target, 60_000)
    const startedAt = Date.now()

    // A hold that outlasts the budget is a real failure and stays one: silently
    // dropping the write would be worse than the error.
    expect(() => writeFileAtomic(target, 'new')).toThrow(/EPERM|EACCES|EBUSY/)

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(ATOMIC_RENAME_BUDGET_MS)
    expect(fs.readFileSync(target, 'utf8')).toBe('old')
    // The temp file must not survive a failed write.
    expect(strays(dir)).toEqual([])
  })
})
