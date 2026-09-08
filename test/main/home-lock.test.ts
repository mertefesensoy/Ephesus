import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HOME_OCCUPIED, isListening, occupiedBy } from '../../src/main/home-lock'
import { ControlServer, controlEndpointFor } from '../../src/main/control'
import { HookServer, hookEndpointFor } from '../../src/main/hooks'
import { CONTROL_ADDRESS_FILE } from '../../src/shared/control'
import type { ControlDeps } from '../../src/main/control'
import type { DiagnosisInput } from '../../src/shared/diagnosis'
import { removeTempDir } from '../tmpdir'

/**
 * One harness per home (ADR-0034).
 *
 * Driven against REAL servers on real addresses, because the whole question is
 * whether something is answering — and a stubbed probe would be a test of the
 * stub. The injected `probe` seam exists for the cases a real socket cannot
 * produce on demand (an address that answers on the second try, an address list
 * whose order matters), not as the default.
 */

const temps: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function home(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

const SNAPSHOT: DiagnosisInput = {
  at: 0,
  home: '',
  pid: 4321,
  version: '0.0.1',
  conditions: [],
  events: [],
  fileWarnings: [],
  crew: [],
  consented: false,
  armed: []
}

const controlDeps = {
  consent: { view: () => ({}), grant: () => ({}) },
  agents: { list: () => [] },
  agora: { appendLog: () => undefined, tailLog: () => [] },
  profilesList: () => [],
  profilesInstances: () => [],
  profilesActivate: () => Promise.resolve({ ok: false, reasons: [] }),
  profilesDeactivate: () => ({ ok: true, reason: null }),
  convene: () => ({ ok: true, id: 'm' }),
  diagnosis: { snapshot: () => SNAPSHOT }
} as unknown as ControlDeps

async function startControl(root: string): Promise<ControlServer> {
  const server = new ControlServer({ deps: controlDeps, onDegraded: () => undefined })
  await server.start(root)
  closers.push(() => server.stop())
  return server
}

async function startHooks(root: string): Promise<HookServer> {
  const server = new HookServer({ onEvent: () => undefined, onRejected: () => undefined })
  await server.start(root)
  closers.push(() => server.stop())
  return server
}

const ask = (
  root: string
): Promise<ReturnType<typeof occupiedBy> extends Promise<infer T> ? T : never> =>
  occupiedBy({
    addressFile: path.join(root, CONTROL_ADDRESS_FILE),
    endpoints: [hookEndpointFor(root), controlEndpointFor(root)]
  })

describe('isListening', () => {
  it('says yes to an address a harness is serving', async () => {
    const root = home('eph-lock-yes-')
    await startControl(root)
    await expect(isListening(controlEndpointFor(root))).resolves.toBe(true)
  })

  it('says no to an address nothing serves, without throwing', async () => {
    // A `false`, not a rejection: the caller is deciding whether a leftover is
    // rubbish, and an exception there would take the boot down over a file.
    const root = home('eph-lock-no-')
    await expect(isListening(controlEndpointFor(root))).resolves.toBe(false)
  })
})

describe('an empty home', () => {
  it('is free', async () => {
    expect(await ask(home('eph-lock-free-'))).toEqual({ occupied: false })
  })
})

describe('a home a harness is working on', () => {
  it('is occupied when the CONTROL endpoint answers', async () => {
    const root = home('eph-lock-ctl-')
    await startControl(root)
    const answer = await ask(root)
    expect(answer.occupied).toBe(true)
    expect(answer.occupied && answer.because).toContain('already working on this home')
    expect(answer.occupied && answer.because).toContain('hire nobody and arm no schedule')
  })

  it('is occupied when only the HOOK endpoint answers', async () => {
    // The half a control-plane-only check would miss: a harness whose control
    // surface failed to bind is still serving its agents, and still committing.
    const root = home('eph-lock-hook-')
    await startHooks(root)
    const answer = await ask(root)
    expect(answer.occupied).toBe(true)
    expect(answer.occupied && answer.because).toContain(hookEndpointFor(root))
  })

  it('names the owning process when the address file says who', async () => {
    const root = home('eph-lock-who-')
    await startControl(root)
    const answer = await ask(root)
    expect(answer.occupied && answer.because).toContain(`process ${String(process.pid)}`)
  })

  it('is free again once that harness stops', async () => {
    const root = home('eph-lock-stop-')
    const server = await startControl(root)
    expect((await ask(root)).occupied).toBe(true)
    await server.stop()
    expect(await ask(root)).toEqual({ occupied: false })
  })
})

describe('the address file is a courtesy, never the authority', () => {
  it('does not make a home occupied on its own', async () => {
    // The exact residue a killed harness leaves. Refusing to start the company
    // over a stale FILE would turn every crash into an outage.
    const root = home('eph-lock-stale-')
    fs.writeFileSync(
      path.join(root, CONTROL_ADDRESS_FILE),
      JSON.stringify({
        schemaVersion: 1,
        endpoint: controlEndpointFor(root),
        path: '/control',
        pid: 999999,
        startedAt: '2026-09-09T00:00:00.000Z'
      })
    )
    expect(await ask(root)).toEqual({ occupied: false })
  })

  it('still refuses, unnamed, when the file is unreadable but an endpoint answers', async () => {
    const root = home('eph-lock-junk-')
    // Clobbered AFTER the server starts: `start()` writes this file itself, so
    // seeding it first would only test that the harness overwrote it.
    await startControl(root)
    fs.writeFileSync(path.join(root, CONTROL_ADDRESS_FILE), '{not json')
    const answer = await ask(root)
    expect(answer.occupied).toBe(true)
    expect(answer.occupied && answer.because).not.toContain('process')
  })

  it('still refuses, unnamed, when the file fails its schema', async () => {
    const root = home('eph-lock-schema-')
    await startControl(root)
    fs.writeFileSync(path.join(root, CONTROL_ADDRESS_FILE), JSON.stringify({ schemaVersion: 1 }))
    const answer = await ask(root)
    expect(answer.occupied).toBe(true)
    expect(answer.occupied && answer.because).not.toContain('process')
  })
})

describe('occupiedBy, driven through its seams', () => {
  it('asks every endpoint until one answers, and stops there', async () => {
    const asked: string[] = []
    const answer = await occupiedBy({
      addressFile: 'nowhere',
      endpoints: ['a', 'b', 'c'],
      readFile: () => {
        throw new Error('no file')
      },
      probe: (endpoint) => {
        asked.push(endpoint)
        return Promise.resolve(endpoint === 'b')
      }
    })
    expect(answer.occupied).toBe(true)
    // 'c' is never asked: one live address is the whole answer.
    expect(asked).toEqual(['a', 'b'])
  })

  it('is free when no endpoint answers, however many there are', async () => {
    const answer = await occupiedBy({
      addressFile: 'nowhere',
      endpoints: ['a', 'b', 'c'],
      readFile: () => '',
      probe: () => Promise.resolve(false)
    })
    expect(answer).toEqual({ occupied: false })
    expect(
      (await occupiedBy({ addressFile: 'x', endpoints: [], probe: () => Promise.resolve(true) }))
        .occupied
    ).toBe(false)
  })

  it('never throws when the address file cannot be read at all', async () => {
    const answer = await occupiedBy({
      addressFile: 'nowhere',
      endpoints: ['a'],
      readFile: () => {
        throw new Error('EACCES')
      },
      probe: () => Promise.resolve(true)
    })
    expect(answer.occupied).toBe(true)
  })
})

describe('the condition it reports', () => {
  it('is an agora cause, because that is what two instances endanger', () => {
    // One book of record, one single committer (invariant §4/§5, ADR-0004).
    // A `home/*` cause would show in the conditions list and turn no row in
    // DIAGNOSIS.md, since the probe table has no `home` area.
    expect(HOME_OCCUPIED).toBe('agora/home-occupied')
  })
})
