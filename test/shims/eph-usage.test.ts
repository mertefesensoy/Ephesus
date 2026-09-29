// ADR-0023: usage-aware pacing. These helpers run in-process because the existing
// spawn tests exercise the shipped shim but are invisible to Vitest's V8 coverage.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseArgs,
  part,
  reportName,
  sessionCostOf,
  windowOf,
  writeAtomic
} from '../../shims/eph-usage.mjs'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usage-helpers-'))
  temps.push(dir)
  return dir
}

describe('eph-usage — argument parsing', () => {
  it('reads --dir when it has a value', () => {
    expect(parseArgs(['--dir', '/tmp/reports'])).toEqual({ dir: '/tmp/reports' })
  })

  it('leaves dir null when --dir has no value after it', () => {
    expect(parseArgs(['--dir'])).toEqual({ dir: null })
  })

  it('keeps the first --dir value when a later --dir has no value', () => {
    expect(parseArgs(['--dir', '/tmp/reports', '--dir'])).toEqual({ dir: '/tmp/reports' })
  })
})

describe('eph-usage — rate-limit windows', () => {
  it.each([
    [123.4567, 123457],
    [123.4562, 123456]
  ])('rounds a sub-millisecond reset to whole milliseconds: %s', (resetsAt, ms) => {
    expect(windowOf({ used_percentage: 1, resets_at: resetsAt })?.resetsAt).toBe(ms)
  })

  it('keeps a window at exactly 0%, the moment after a reset', () => {
    expect(windowOf({ used_percentage: 0, resets_at: 123 })).toEqual({
      usedPercent: 0,
      resetsAt: 123000
    })
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    'rejects an unusable percentage: %s',
    (used) => {
      expect(windowOf({ used_percentage: used, resets_at: 123 })).toBeNull()
    }
  )

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an unusable reset timestamp: %s',
    (resetsAt) => {
      expect(windowOf({ used_percentage: 1, resets_at: resetsAt })).toBeNull()
    }
  )
})

describe('eph-usage — report names', () => {
  it('uses the account report for a missing or empty id', () => {
    expect(reportName(null)).toBe('_account.json')
    expect(reportName('')).toBe('_account.json')
  })

  it('collapses runs of dots', () => {
    expect(reportName('part....tail')).toBe('part-tail.json')
  })

  it('caps the sanitized id at 100 characters', () => {
    expect(reportName('x'.repeat(101))).toBe(`${'x'.repeat(100)}.json`)
  })
})

describe('eph-usage — display and cost helpers', () => {
  it('rounds a displayed percentage', () => {
    expect(part({ usedPercent: 12.6 }, '5h')).toBe('5h 13%')
    expect(part({ usedPercent: 12.4 }, '7d')).toBe('7d 12%')
    expect(part(null, '5h')).toBeNull()
  })

  it('keeps an exact zero session cost because free and unreported are distinct', () => {
    expect(sessionCostOf({ total_cost_usd: 0 })).toBe(0)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 'free', null])(
    'rejects an unusable session cost: %s',
    (cost) => {
      expect(sessionCostOf(cost === null ? null : { total_cost_usd: cost })).toBeNull()
    }
  )
})

describe('eph-usage — atomic writes', () => {
  it('creates the directory, writes the complete file, and leaves no temp file behind', () => {
    const dir = tempDir()
    const file = path.join(dir, 'nested', 'report.json')

    writeAtomic(file, '{"ok":true}\n')

    expect(fs.readFileSync(file, 'utf8')).toBe('{"ok":true}\n')
    expect(fs.readdirSync(path.dirname(file))).toEqual(['report.json'])
  })

  it('replaces an existing report by rename, not by rewriting it in place', () => {
    const file = path.join(tempDir(), 'report.json')
    fs.writeFileSync(file, 'old\n', 'utf8')
    const before = fs.statSync(file, { bigint: true }).ino

    writeAtomic(file, 'new\n')

    expect(fs.readFileSync(file, 'utf8')).toBe('new\n')
    expect(fs.statSync(file, { bigint: true }).ino).not.toBe(before)
  })
})
