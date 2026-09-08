import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosisWriter, DIAGNOSIS_FILE } from '../../src/main/diagnosis'
import type { DiagnosisInput } from '../../src/shared/diagnosis'
import { removeTempDir } from '../tmpdir'

/**
 * The writer's seam (M8.13).
 *
 * `test/shared/diagnosis.test.ts` covers what the report SAYS; this covers what
 * happens when writing it goes wrong. That half matters more than usual here,
 * because this runs in the quit path: a diagnostic that could crash the thing it
 * is diagnosing would be worse than no diagnostic at all.
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-diag-'))
  temps.push(dir)
  return dir
}

const snapshot = (at = 1_000_000): DiagnosisInput => ({
  at,
  home: 'C:/home/.ephesus',
  pid: 4321,
  version: 'abc1234',
  conditions: [],
  events: [],
  fileWarnings: [],
  crew: [],
  consented: false,
  armed: []
})

describe('writing the report', () => {
  it('lands beside config.json, at the root of the home', () => {
    const root = home()
    const writer = new DiagnosisWriter({
      home: root,
      snapshot: () => snapshot(),
      onFailed: () => undefined
    })
    expect(writer.write()).toBe(path.join(root, DIAGNOSIS_FILE))
    expect(fs.existsSync(path.join(root, DIAGNOSIS_FILE))).toBe(true)
  })

  it('renders against the instant the snapshot was taken', () => {
    // Against the snapshot's own instant, never a clock. The writer holds no
    // clock at all, so "written now, reads as now" is true by construction
    // rather than by two time sources happening to agree.
    const root = home()
    new DiagnosisWriter({
      home: root,
      snapshot: () => snapshot(),
      onFailed: () => undefined
    }).write()
    expect(fs.readFileSync(path.join(root, DIAGNOSIS_FILE), 'utf8')).toContain('just now')
  })

  it('takes a FRESH snapshot on every write', () => {
    // Held state would make the second report a copy of the first, which is the
    // failure mode of every cached status page.
    const root = home()
    let calls = 0
    const writer = new DiagnosisWriter({
      home: root,
      snapshot: () => {
        calls += 1
        return snapshot()
      },
      onFailed: () => undefined
    })
    writer.write()
    writer.write()
    expect(calls).toBe(2)
  })

  it('ends with a newline, so appending or catting it does not run lines together', () => {
    const root = home()
    new DiagnosisWriter({
      home: root,
      snapshot: () => snapshot(),
      onFailed: () => undefined
    }).write()
    expect(fs.readFileSync(path.join(root, DIAGNOSIS_FILE), 'utf8').endsWith('\n')).toBe(true)
  })
})

describe('when writing goes wrong', () => {
  it('never throws — it runs in the quit path', () => {
    const writer = new DiagnosisWriter({
      home: path.join(home(), 'does', 'not', 'exist', 'and', 'cannot'),
      snapshot: () => snapshot(),
      onFailed: () => undefined
    })
    expect(() => writer.write()).not.toThrow()
  })

  it('reports the failure rather than swallowing it silently', () => {
    const failures: string[] = []
    new DiagnosisWriter({
      home: path.join(home(), 'nope', 'nope'),
      snapshot: () => snapshot(),
      onFailed: (d) => failures.push(d)
    }).write()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain(DIAGNOSIS_FILE)
  })

  it('returns null so a caller can tell a written report from an absent one', () => {
    expect(
      new DiagnosisWriter({
        home: path.join(home(), 'nope', 'nope'),
        snapshot: () => snapshot(),
        onFailed: () => undefined
      }).write()
    ).toBeNull()
  })

  it('survives a snapshot that throws', () => {
    // The gatherer reaches into a dozen live subsystems, any of which may be
    // half-constructed during boot or half-torn-down during quit.
    const failures: string[] = []
    const writer = new DiagnosisWriter({
      home: home(),
      snapshot: () => {
        throw new Error('agora is not available')
      },
      onFailed: (d) => failures.push(d)
    })
    expect(() => writer.write()).not.toThrow()
    expect(writer.write()).toBeNull()
    expect(failures[0]).toContain('agora is not available')
  })

  it('survives a reporter that itself throws', () => {
    // The last line of defence. If this rethrew, a broken degradation channel
    // would take the quit sequence down with it.
    expect(() =>
      new DiagnosisWriter({
        home: path.join(home(), 'nope'),
        snapshot: () => snapshot(),
        onFailed: () => {
          throw new Error('the channel is gone too')
        }
      }).write()
    ).not.toThrow()
  })
})

describe('a harness that does not own this home writes nothing (ADR-0034)', () => {
  it('writes no file at all when mayWrite says no', () => {
    // All three call sites go through `write()` — boot, the minute timer and
    // the quit path — so the rule is asked once and none of them can forget it.
    const root = home()
    let taken = 0
    const writer = new DiagnosisWriter({
      home: root,
      snapshot: () => {
        taken += 1
        return snapshot()
      },
      onFailed: () => undefined,
      mayWrite: () => false
    })
    expect(writer.write()).toBeNull()
    expect(fs.existsSync(path.join(root, DIAGNOSIS_FILE))).toBe(false)
    // Not even the fold is taken: a report nobody may write is work nobody asked
    // for, and `snapshot()` reads the whole book of record.
    expect(taken).toBe(0)
  })

  it('does not overwrite a report the owner already wrote', () => {
    // The defect this closes. Two instances wrote this file and disagreed
    // honestly — the owner's WORKING against the blocked one's WAITING FOR YOU
    // — and whichever wrote last was what a reader saw.
    const root = home()
    const owner = new DiagnosisWriter({
      home: root,
      snapshot: () => snapshot(),
      onFailed: () => undefined
    })
    expect(owner.write()).toBe(path.join(root, DIAGNOSIS_FILE))
    const theirs = fs.readFileSync(path.join(root, DIAGNOSIS_FILE), 'utf8')

    const blocked = new DiagnosisWriter({
      home: root,
      snapshot: () => snapshot(2_000_000),
      onFailed: () => undefined,
      mayWrite: () => false
    })
    expect(blocked.write()).toBeNull()
    expect(fs.readFileSync(path.join(root, DIAGNOSIS_FILE), 'utf8')).toBe(theirs)
  })

  it('writes normally when nothing says otherwise', () => {
    // The default is unchanged: an owner passes no predicate and still writes.
    const root = home()
    const writer = new DiagnosisWriter({
      home: root,
      snapshot: () => snapshot(),
      onFailed: () => undefined,
      mayWrite: () => true
    })
    expect(writer.write()).toBe(path.join(root, DIAGNOSIS_FILE))
  })
})
