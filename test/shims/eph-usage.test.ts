// ADR-0023: usage-aware pacing. These helpers run in-process because the existing
// spawn tests exercise the shipped shim but are invisible to Vitest's V8 coverage.
// One test still spawns a process: that importing the shim runs nothing is a fact
// about a whole process, observable only from outside one.
import { execFileSync } from 'node:child_process'
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
import { removeTempDir } from '../tmpdir'

const SHIM_URL = new URL('../../shims/eph-usage.mjs', import.meta.url).href
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
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

  it.each([null, undefined, 'five_hour', 42])(
    'reads a window the engine did not send as no window: %s',
    (raw) => {
      // The first render of every session carries no `rate_limits` block at all.
      expect(windowOf(raw)).toBeNull()
    }
  )

  it('stores the percentage the engine reported, unrounded', () => {
    // Pacing compares this figure with its thresholds (slow at 90%, hold at 97% by
    // default — `src/shared/pacing.ts`). Rounded here, 96.5% would read as 97 and
    // hold a company that should only have slowed. Only the status line rounds.
    expect(windowOf({ used_percentage: 96.5, resets_at: 123 })?.usedPercent).toBe(96.5)
  })
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

describe('eph-usage — importing it', () => {
  it('runs nothing: reads no stdin, draws no status line, writes no report', () => {
    // The guard at the bottom of the shim is what lets this file import it at all.
    // A process imports it from a file that is not the shim, as this file does, and
    // is handed everything a run of `main()` would act on: a status document on
    // stdin, a `--dir` to write into and an agent to name the report after.
    const dir = tempDir()
    const importer = path.join(dir, 'importer.mjs')
    fs.writeFileSync(importer, `await import(${JSON.stringify(SHIM_URL)})\n`, 'utf8')
    const reports = path.join(dir, 'reports')

    const stdout = execFileSync(process.execPath, [importer, '--dir', reports], {
      input: JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 12, resets_at: 1788294000 } }
      }),
      encoding: 'utf8',
      env: { ...process.env, EPH_AGENT_ID: 'agent.importer' },
      timeout: 10_000
    })

    expect(stdout).toBe('')
    expect(fs.existsSync(reports)).toBe(false)
  })
})
