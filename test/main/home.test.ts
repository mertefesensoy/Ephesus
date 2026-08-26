import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureHarnessHome, HOME_DIRS } from '../../src/main/home'
import { writeFileAtomic } from '../../src/main/fsx'

// Integration per TEST-STRATEGY §2: real fs in temp dirs, no mocking.
let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-home-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
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
