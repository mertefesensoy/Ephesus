import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MIN_FREE_BYTES,
  SWEEP_OLDER_THAN_MS,
  headroomRefusal,
  requireHeadroom,
  sweepStaleTempDirs
} from './global-setup'
import { removeTempDir } from './tmpdir'

/**
 * The suite's own housekeeping, and the guard that keeps it honest.
 *
 * Written after an audit on 2026-09-07 found **3 279 `eph-*` directories —
 * 42 910 files across 24 405 directories — in `%TEMP%`**, accumulated since
 * 2026-08-26 on a disk that was 92% full. Nothing had failed; the suite had
 * simply been leaving six to eleven directories behind on every run for two
 * weeks, and nothing anywhere would ever have said so.
 *
 * One file was responsible for 1 391 of them by calling `mkdtempSync` and
 * removing nothing. That is a one-line mistake that no review caught and no
 * test could catch, which is the definition of a check worth making
 * structural — so the guard below fails the suite the next time somebody makes
 * it, instead of an audit finding it in a month.
 */

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) removeTempDir(home)
})

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-hygiene-'))
  homes.push(dir)
  return dir
}

/** Every `.ts`/`.tsx` file under `test/`, as repo-relative slash paths. */
function testFiles(dir = 'test', out: string[] = []): readonly string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) testFiles(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full.split(path.sep).join('/'))
  }
  return out
}

/**
 * Contract: pure. Whether `source` makes a temp directory and never removes one.
 *
 * It looks for a CALL — `removeTempDir(` — and not for the name, which is the
 * difference between a guard and a guard-shaped thing. Written first as
 * `includes('removeTempDir')`, it survived the one mutation that mattered:
 * deleting a teardown's body leaves the `import { removeTempDir }` line behind,
 * so the file still "mentioned" the helper while removing nothing. A shape
 * check standing in for a semantic one is this repository's oldest recurring
 * defect, and it had reproduced inside the very test written to prevent it.
 */
export function leaksTempDirs(source: string): boolean {
  if (!source.includes('mkdtempSync')) return false
  return !source.includes('removeTempDir(') && !source.includes('rmSync(')
}

describe('a test that makes a temp directory takes it away again', () => {
  it('holds for every file in the tree', () => {
    // The guard. `mkdtempSync` with no removal anywhere in the same file is the
    // exact shape of the defect this fixed, and it is invisible in review
    // because the missing thing is a line nobody wrote.
    const offenders = testFiles().filter((file) => leaksTempDirs(fs.readFileSync(file, 'utf8')))

    expect(offenders, `these files create temp directories and never remove one`).toEqual([])
  })

  it('catches a file that makes a directory and removes nothing', () => {
    expect(leaksTempDirs("const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-x-'))")).toBe(
      true
    )
  })

  it('is not satisfied by an IMPORT of the helper, only by a call', () => {
    // The mutation that defeated the first version of this guard, kept as its
    // regression: the teardown's body was deleted and the import stayed.
    const importedButUnused = [
      "import { removeTempDir } from '../tmpdir'",
      "const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-x-'))"
    ].join('\n')
    expect(leaksTempDirs(importedButUnused)).toBe(true)
  })

  it('accepts a file that actually calls one of the two removers', () => {
    // Both directions, or the guard could pass by refusing everything.
    expect(leaksTempDirs('fs.mkdtempSync(x)\nremoveTempDir(home)')).toBe(false)
    expect(leaksTempDirs('fs.mkdtempSync(x)\nfs.rmSync(home, { recursive: true })')).toBe(false)
  })

  it('says nothing about a file that makes no temp directory', () => {
    expect(leaksTempDirs('const x = 1')).toBe(false)
  })
})

describe('sweeping what per-file teardown cannot reach', () => {
  it('removes a directory older than the age gate', () => {
    const root = scratch()
    const stale = path.join(root, 'eph-old-abc123')
    fs.mkdirSync(stale)
    fs.writeFileSync(path.join(stale, 'f.txt'), 'x')
    const now = Date.now() + SWEEP_OLDER_THAN_MS + 60_000

    expect(sweepStaleTempDirs(now, SWEEP_OLDER_THAN_MS, root)).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
  })

  it('leaves a LIVE run alone, which is the whole reason for the age gate', () => {
    // This repository is regularly worked on from more than one worktree at
    // once, so a sweep that removed a fresh directory would break somebody
    // else's suite while tidying. Two hours against a 30 s per-test timeout is
    // that margin.
    const root = scratch()
    const fresh = path.join(root, 'eph-live-xyz789')
    fs.mkdirSync(fresh)

    expect(sweepStaleTempDirs(Date.now(), SWEEP_OLDER_THAN_MS, root)).toBe(0)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('touches nothing that is not ours', () => {
    const root = scratch()
    const theirs = path.join(root, 'some-other-tool-cache')
    fs.mkdirSync(theirs)
    const now = Date.now() + SWEEP_OLDER_THAN_MS + 60_000

    expect(sweepStaleTempDirs(now, SWEEP_OLDER_THAN_MS, root)).toBe(0)
    expect(fs.existsSync(theirs)).toBe(true)
  })

  it('never throws when a directory cannot be read or removed', () => {
    // Tidying is a courtesy. A sweep that failed a run would be worse than the
    // residue it was cleaning.
    expect(() =>
      sweepStaleTempDirs(Date.now(), 0, path.join(os.tmpdir(), 'eph-does-not-exist-at-all'))
    ).not.toThrow()
  })
})

describe('refusing to start on a machine that cannot run the suite', () => {
  it('refuses below the measured floor', () => {
    expect(() => requireHeadroom(MIN_FREE_BYTES - 1, 16_800_000_000)).toThrow(
      /Not enough free memory/
    )
  })

  it('allows exactly the floor', () => {
    // Stated rather than left to whichever comparison was typed.
    expect(() => requireHeadroom(MIN_FREE_BYTES, 16_800_000_000)).not.toThrow()
  })

  it('names the numbers, because a refusal that cannot be acted on is noise', () => {
    const said = headroomRefusal(370_000_000, 16_800_000_000)
    expect(said).toContain('0.37 GB free of 16.80 GB')
    expect(said).toContain('2 GB')
  })

  it('says what the failure LOOKS like, which is the part that cost an hour', () => {
    // The refusal exists because the symptom is unrecognisable: a few dozen
    // unrelated tests failing, a different set each run. Telling somebody only
    // "out of memory" would not stop them reading the next red run as a
    // regression.
    const said = headroomRefusal(110_000_000, 16_800_000_000)
    expect(said).toMatch(/does NOT look like a memory problem/)
    expect(said).toMatch(/regression/)
  })
})
