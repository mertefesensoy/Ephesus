import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MemorySettingsRegistry,
  sweepInstalledSettings,
  type InstalledSettings
} from '../../src/main/settings-registry'
import { InstalledSettingsPlan } from '../../src/main/engines/settings-install'

/**
 * The M1 carried item: a *force-killed* harness used to leave
 * `settings.local.json` in the Architect's working tree with no record that we
 * put it there. These tests simulate exactly that — install, then throw the
 * plan away without uninstalling, as a SIGKILL would — and assert the next boot
 * undoes it.
 */

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-settings-'))
  temps.push(dir)
  return dir
}

const BACKUP_SUFFIX = '.eph-backup'

function planFor(cwd: string, registry: MemorySettingsRegistry): InstalledSettingsPlan {
  return new InstalledSettingsPlan(
    [{ path: path.join(cwd, '.claude', 'settings.local.json'), contents: '{"hooks":{}}\n' }],
    'agent.mason',
    BACKUP_SUFFIX,
    registry
  )
}

describe('MemorySettingsRegistry', () => {
  it('records, lists and clears by agent', () => {
    const registry = new MemorySettingsRegistry()
    const entry: InstalledSettings = {
      agentId: 'agent.mason',
      path: '/repo/.claude/settings.local.json',
      backupPath: null,
      createdDir: true
    }
    registry.record(entry)
    registry.record({ ...entry, agentId: 'agent.artemis', path: '/other/.claude/s.json' })

    expect(registry.list()).toHaveLength(2)
    registry.clear('agent.mason')
    expect(registry.list().map((r) => r.agentId)).toEqual(['agent.artemis'])
  })
})

describe('settings installation is recorded before the file is written', () => {
  it('records the installation, and clears it on a graceful uninstall', async () => {
    const cwd = tempCwd()
    const registry = new MemorySettingsRegistry()
    const plan = planFor(cwd, registry)

    await plan.install()
    expect(registry.list()).toEqual([
      {
        agentId: 'agent.mason',
        path: path.join(cwd, '.claude', 'settings.local.json'),
        backupPath: null,
        createdDir: true
      }
    ])

    await plan.uninstall()
    expect(registry.list()).toEqual([])
  })

  it('records the backup path when it displaced an existing file', async () => {
    const cwd = tempCwd()
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), '{"mine":true}\n', 'utf8')

    const registry = new MemorySettingsRegistry()
    await planFor(cwd, registry).install()

    expect(registry.list()[0]?.backupPath).toBe(
      path.join(cwd, '.claude', `settings.local.json${BACKUP_SUFFIX}`)
    )
    expect(registry.list()[0]?.createdDir).toBe(false)
  })
})

describe('startup sweep undoes what a killed harness left behind', () => {
  it('restores a displaced file byte-for-byte and drops the backup', async () => {
    const cwd = tempCwd()
    const target = path.join(cwd, '.claude', 'settings.local.json')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const original = '{\r\n  "permissions": { "allow": ["Bash(ls)"] }\r\n}\r\n'
    fs.writeFileSync(target, original, 'utf8')
    const before = fs.readFileSync(target)

    const registry = new MemorySettingsRegistry()
    await planFor(cwd, registry).install()
    // SIGKILL: the plan object is simply dropped, uninstall never runs.

    const result = sweepInstalledSettings(registry)

    expect(result.restored).toEqual([target])
    expect(fs.readFileSync(target).equals(before)).toBe(true)
    expect(fs.existsSync(`${target}${BACKUP_SUFFIX}`)).toBe(false)
    expect(registry.list()).toEqual([])
  })

  it('removes a file the harness created, and the directory with it', async () => {
    const cwd = tempCwd()
    const registry = new MemorySettingsRegistry()
    await planFor(cwd, registry).install()
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(true)

    const result = sweepInstalledSettings(registry)

    expect(result.removed).toEqual([path.join(cwd, '.claude', 'settings.local.json')])
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false)
    expect(fs.readdirSync(cwd)).toEqual([])
  })

  it('leaves a directory that already had other files in it', async () => {
    const cwd = tempCwd()
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), '{}', 'utf8')

    const registry = new MemorySettingsRegistry()
    await planFor(cwd, registry).install()
    sweepInstalledSettings(registry)

    expect(fs.existsSync(path.join(cwd, '.claude', 'settings.json'))).toBe(true)
  })

  it('is a no-op when the file is already gone', async () => {
    const cwd = tempCwd()
    const registry = new MemorySettingsRegistry()
    await planFor(cwd, registry).install()
    fs.rmSync(path.join(cwd, '.claude', 'settings.local.json'), { force: true })

    const result = sweepInstalledSettings(registry)

    expect(result.restored).toEqual([])
    expect(result.removed).toEqual([])
    expect(result.failed).toEqual([])
    expect(registry.list()).toEqual([])
  })

  it('reports a file it cannot restore instead of throwing the boot away', () => {
    const cwd = tempCwd()
    const registry = new MemorySettingsRegistry()
    // A directory where the settings file belongs: unwritable as a file.
    const target = path.join(cwd, '.claude', 'settings.local.json')
    fs.mkdirSync(target, { recursive: true })
    const backup = `${target}${BACKUP_SUFFIX}`
    fs.writeFileSync(backup, 'original', 'utf8')
    registry.record({
      agentId: 'agent.mason',
      path: target,
      backupPath: backup,
      createdDir: false
    })

    const result = sweepInstalledSettings(registry)

    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.path).toBe(target)
    expect(result.failed[0]?.reason.length).toBeGreaterThan(0)
  })

  it('does nothing at all when nothing was installed', () => {
    expect(sweepInstalledSettings(new MemorySettingsRegistry())).toEqual({
      restored: [],
      removed: [],
      failed: []
    })
  })
})
