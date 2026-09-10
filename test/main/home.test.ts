import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureHarnessHome, HOME_DIRS, seededConfigConditions } from '../../src/main/home'
import { writeFileAtomic } from '../../src/main/fsx'
import { removeTempDir } from '../tmpdir'

// Integration per TEST-STRATEGY §2: real fs in temp dirs, no mocking.
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-home-'))
})
afterEach(() => {
  removeTempDir(root)
})

describe('ensureHarnessHome (SDD §2)', () => {
  it('creates the top-level directories and a valid default config.json', () => {
    const home = ensureHarnessHome(root)
    for (const dir of HOME_DIRS) expect(fs.statSync(path.join(root, dir)).isDirectory()).toBe(true)
    const onDisk: unknown = JSON.parse(fs.readFileSync(home.configPath, 'utf8'))
    expect(onDisk).toEqual({ schemaVersion: 1 })
    expect(home.config).toEqual({ schemaVersion: 1 })
    expect(home.configWarning).toBeNull()
    expect(home.dbPath).toBe(path.join(root, 'db.sqlite'))
  })

  it('is idempotent and preserves an existing valid config', () => {
    ensureHarnessHome(root)
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ schemaVersion: 1 }))
    const again = ensureHarnessHome(root)
    expect(again.configWarning).toBeNull()
    expect(again.config).toEqual({ schemaVersion: 1 })
  })

  it('surfaces a warning for invalid config.json and leaves the file untouched', () => {
    ensureHarnessHome(root)
    const configPath = path.join(root, 'config.json')
    fs.writeFileSync(configPath, '{"schemaVersion": 999}')
    const home = ensureHarnessHome(root)
    expect(home.configWarning).toContain('config.json invalid')
    expect(home.config).toEqual({ schemaVersion: 1 }) // runs on defaults
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"schemaVersion": 999}') // untouched
  })

  it('surfaces a warning for unparseable JSON', () => {
    ensureHarnessHome(root)
    fs.writeFileSync(path.join(root, 'config.json'), 'not json {')
    expect(ensureHarnessHome(root).configWarning).toContain('config.json invalid')
  })
})

describe('writeFileAtomic (BUILD-PROMPT §3.3)', () => {
  it('writes new files and replaces existing ones', () => {
    const target = path.join(root, 'file.json')
    writeFileAtomic(target, 'one')
    expect(fs.readFileSync(target, 'utf8')).toBe('one')
    writeFileAtomic(target, 'two')
    expect(fs.readFileSync(target, 'utf8')).toBe('two')
  })

  it('leaves no temp files behind', () => {
    const target = path.join(root, 'file.json')
    writeFileAtomic(target, 'data')
    writeFileAtomic(target, 'data2')
    expect(fs.readdirSync(root).filter((f) => f.includes('.tmp'))).toEqual([])
  })
})

/**
 * **M8c.5 — a deduplicated condition must not lose what distinguishes its
 * occurrences.**
 *
 * Finding 2 of the M8 exit run. `DIAGNOSIS.md` said:
 *
 * ```text
 * `home/seeded-config` — authority.json was missing and has been created … (×2)
 * ```
 *
 * while `log.jsonl` seq 1 recorded **`gate-policy.json`** under the same cause.
 * Two files, one cause key, one surviving message: the ring dedupes on cause, so
 * the count reached 2 and only the LAST file's message was rendered, while the
 * book of record kept the FIRST. A reader of either artifact learned one file
 * and could not tell there was another.
 *
 * It is not cosmetic. The file the report dropped is `gate-policy.json` — the
 * one the README calls the company-wide autonomy ceiling, and the file SRS
 * §6.1's last clause depends on entirely.
 */
describe('a seeded file names itself in its own cause (M8c.5)', () => {
  it('reports one condition per file, keyed by the file', () => {
    const conditions = seededConfigConditions(['gate-policy.json', 'authority.json'], '/home/eph')

    expect(conditions.map((c) => c.cause)).toEqual([
      'home/seeded-config:gate-policy.json',
      'home/seeded-config:authority.json'
    ])
  })

  it('keeps the cause distinct, which is what stops the dedupe losing one', () => {
    const conditions = seededConfigConditions(['gate-policy.json', 'authority.json'], '/home/eph')
    const causes = new Set(conditions.map((c) => c.cause))

    // The assertion that would have failed on 2026-09-09: two files, two keys.
    expect(causes.size).toBe(conditions.length)
  })

  it('names the file and the home in every detail', () => {
    for (const condition of seededConfigConditions(['gate-policy.json'], '/home/eph')) {
      expect(condition.detail).toContain('gate-policy.json')
      expect(condition.detail).toContain('/home/eph')
      expect(condition.detail).toContain('shipped default')
    }
  })

  it('keeps the `home` source, so the diagnosis probe still finds it', () => {
    // `PROBES` matches on the part before the slash. A key that stopped
    // starting with `home/` would move the condition off the row that reports
    // it — a fix that hid the thing it was fixing.
    for (const condition of seededConfigConditions(['authority.json'], '/home/eph')) {
      expect(condition.cause.split('/')[0]).toBe('home')
    }
  })

  it('reports nothing when the harness seeded nothing', () => {
    expect(seededConfigConditions([], '/home/eph')).toEqual([])
  })

  it('CONTROL — a constant cause WOULD collapse the two, which is the defect', () => {
    // The predicate above is only meaningful if it can fail. This is the shape
    // the code had: one key for every file.
    const asShipped = ['gate-policy.json', 'authority.json'].map(() => 'home/seeded-config')
    expect(new Set(asShipped).size).toBe(1)
  })
})
