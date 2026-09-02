import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KNOWN_TARGETS_REL, KnownTargets } from '../../src/main/known-targets'
import type { ActivationRequest } from '../../src/shared/profile-activation'
import { removeTempDir } from '../tmpdir'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-known-'))
  temps.push(dir)
  return dir
}

const request: ActivationRequest = {
  profile: 'skeleton-crew',
  target: { kind: 'repo', id: 'musahit', path: 'C:/repos/musahit' }
}

describe('the remembered-targets file', () => {
  it('offers nothing before anything has been activated', () => {
    expect(new KnownTargets(path.join(home(), KNOWN_TARGETS_REL)).list()).toEqual([])
  })

  it('survives a restart, which is the entire point of it', () => {
    const root = home()
    const file = path.join(root, KNOWN_TARGETS_REL)
    new KnownTargets(file).remember(request, '2026-09-01T06:00:00.000Z')
    // A second instance is what the next app start builds.
    const reopened = new KnownTargets(file)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.list()[0]?.target.path).toBe('C:/repos/musahit')
    expect(reopened.warning()).toBeNull()
  })

  it('writes a file carrying its schema version', () => {
    const file = path.join(home(), KNOWN_TARGETS_REL)
    new KnownTargets(file).remember(request, '2026-09-01T06:00:00.000Z')
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(written['schemaVersion']).toBe(1)
  })

  it('leaves no temp file behind (atomic write)', () => {
    const root = home()
    new KnownTargets(path.join(root, KNOWN_TARGETS_REL)).remember(
      request,
      '2026-09-01T06:00:00.000Z'
    )
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  /**
   * The opposite failure mode to `loadGatePolicy`, and deliberately so. A gate
   * policy that cannot be read must deny everything; a convenience list that
   * cannot be read must not stop the Architect activating anything. It costs
   * them one retyped path — exactly where they were before this file existed.
   */
  it('offers nothing, and says why, when the file is unreadable', () => {
    const file = path.join(home(), KNOWN_TARGETS_REL)
    fs.writeFileSync(file, '{ this is not json', 'utf8')
    const store = new KnownTargets(file)
    expect(store.list()).toEqual([])
    expect(store.warning()).toMatch(/unreadable/)
  })

  it('offers nothing, and says why, when the file is the wrong shape', () => {
    const file = path.join(home(), KNOWN_TARGETS_REL)
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, targets: [] }), 'utf8')
    const store = new KnownTargets(file)
    expect(store.list()).toEqual([])
    expect(store.warning()).toMatch(/invalid/)
  })

  it('recovers on the next successful write, clearing the warning', () => {
    const file = path.join(home(), KNOWN_TARGETS_REL)
    fs.writeFileSync(file, 'garbage', 'utf8')
    const store = new KnownTargets(file)
    expect(store.warning()).not.toBeNull()
    store.remember(request, '2026-09-01T06:00:00.000Z')
    expect(store.warning()).toBeNull()
    expect(new KnownTargets(file).list()).toHaveLength(1)
  })
})
