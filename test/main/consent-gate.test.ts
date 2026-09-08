import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanyStart, CONSENT_UNWRITABLE, CONSENT_WITHHELD } from '../../src/main/consent'
import { ensureHarnessHome } from '../../src/main/home'
import { CONSENT_TERMS_VERSION, type ConsentDisclosure } from '../../src/shared/consent'
import type { ConsentRecord } from '../../src/shared/consent'
import type { DegradationCause } from '../../src/shared/degradation'
import { removeTempDir } from '../tmpdir'

/**
 * The consent gate's WIRING (DD-6, M8.12) — the half a pure predicate cannot
 * cover.
 *
 * `decideConsent` says whether work may start; this says what actually happens
 * when it does or does not. It exists because the same decision written inline
 * in `index.ts` would be reachable only by booting Electron, which is how three
 * previous findings in this repository (the Herald, M7.2's inert trigger,
 * M7.7's silent standup) sat behind a green suite.
 *
 * Nothing here grants consent in a helper. Every test that wants a started
 * company says so out loud, because the SHIPPED DEFAULT is what a stranger
 * meets and a rig that quietly answered the question would be testing a product
 * nobody ships.
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

const DISCLOSURE: ConsentDisclosure = {
  hire: { agentId: 'artemis', engine: 'claude' },
  triggers: [{ id: 'standup', everyMs: 1_800_000 }],
  dailyCeiling: null
}

interface Rig {
  readonly gate: CompanyStart
  readonly hires: number[]
  readonly schedules: number[]
  readonly saved: ConsentRecord[]
  readonly reported: { cause: DegradationCause; detail: string }[]
  readonly cleared: DegradationCause[]
  readonly logged: Record<string, unknown>[]
}

function rig(
  options: {
    record?: ConsentRecord
    saveThrows?: Error
    termsVersion?: number
  } = {}
): Rig {
  const hires: number[] = []
  const schedules: number[] = []
  const saved: ConsentRecord[] = []
  const reported: { cause: DegradationCause; detail: string }[] = []
  const cleared: DegradationCause[] = []
  const logged: Record<string, unknown>[] = []
  let held = options.record
  const gate = new CompanyStart({
    record: () => held,
    save: (next) => {
      if (options.saveThrows) throw options.saveThrows
      saved.push(next)
      held = next
    },
    disclose: () => DISCLOSURE,
    hire: () => hires.push(hires.length + 1),
    startSchedule: () => schedules.push(schedules.length + 1),
    report: (cause, detail) => reported.push({ cause, detail }),
    clear: (cause) => cleared.push(cause),
    log: (draft) => logged.push(draft),
    now: () => new Date('2026-09-07T22:00:00.000Z'),
    ...(options.termsVersion === undefined ? {} : { termsVersion: options.termsVersion })
  })
  return { gate, hires, schedules, saved, reported, cleared, logged }
}

describe('boot on a machine nobody has consented on', () => {
  it('hires nobody and starts no clock', () => {
    const r = rig()
    const verdict = r.gate.boot()
    expect(verdict.mayStartWork).toBe(false)
    expect(r.hires).toEqual([])
    expect(r.schedules).toEqual([])
  })

  it('reports the withheld state, so a stopped company is not a quiet one', () => {
    const r = rig()
    r.gate.boot()
    // Invariant §7. Asserting the CAUSE and not just "something was reported":
    // the ring is keyed by cause, and a report under the wrong key is a report
    // the clear below can never find.
    expect(r.reported.map((row) => row.cause)).toEqual([CONSENT_WITHHELD])
    expect(r.reported[0]?.detail).toContain('not working')
  })

  it('gates BOTH halves — this is the decision, not a detail', () => {
    // Recorded in DECISIONS-LOG 2026-09-07: consent covers the company starting
    // work, not just the hire. A gate that only guarded `artemis.start` would
    // leave standup, retro and reflection firing sixty seconds later. Mutating
    // `startWork` to call only `hire()` has to fail here.
    const r = rig()
    r.gate.boot()
    expect([...r.hires, ...r.schedules]).toEqual([])
  })
})

describe('boot on a machine that has consented', () => {
  it('hires and starts the clock, in that order, exactly once', () => {
    const r = rig({
      record: { grantedAt: '2026-09-01T00:00:00.000Z', terms: CONSENT_TERMS_VERSION }
    })
    expect(r.gate.boot().mayStartWork).toBe(true)
    expect(r.hires).toEqual([1])
    expect(r.schedules).toEqual([1])
    expect(r.reported).toEqual([])
  })

  it('does not re-write the standing grant', () => {
    const r = rig({
      record: { grantedAt: '2026-09-01T00:00:00.000Z', terms: CONSENT_TERMS_VERSION }
    })
    r.gate.boot()
    r.gate.grant()
    // `grantedAt` says when consent was FIRST given; overwriting it would erase
    // how long the company has been authorised.
    expect(r.saved).toEqual([])
    expect(r.gate.view().grantedAt).toBe('2026-09-01T00:00:00.000Z')
  })
})

describe('the Architect says go', () => {
  it('records the grant, then hires, then starts the clock', () => {
    const r = rig()
    r.gate.boot()
    const outcome = r.gate.grant()
    expect(outcome.ok).toBe(true)
    expect(outcome.reason).toBeNull()
    expect(r.saved).toEqual([
      { grantedAt: '2026-09-07T22:00:00.000Z', terms: CONSENT_TERMS_VERSION }
    ])
    expect(r.hires).toEqual([1])
    expect(r.schedules).toEqual([1])
  })

  it('clears the withheld degradation so the strip stops reporting it', () => {
    const r = rig()
    r.gate.boot()
    r.gate.grant()
    expect(r.cleared).toContain(CONSENT_WITHHELD)
  })

  it('takes effect in THIS process — a grant is not a restart instruction', () => {
    const r = rig()
    r.gate.boot()
    expect(r.hires).toEqual([])
    r.gate.grant()
    expect(r.hires).toEqual([1])
    expect(r.gate.view().mayStartWork).toBe(true)
  })

  it('is idempotent across a second click', () => {
    const r = rig()
    r.gate.boot()
    r.gate.grant()
    r.gate.grant()
    r.gate.grant()
    expect(r.hires).toEqual([1])
    expect(r.schedules).toEqual([1])
    expect(r.saved).toHaveLength(1)
  })

  it('does NOT start the company on a grant it could not write down', () => {
    // The direction that matters. Work running under a consent the next boot
    // will not find spends tokens against a record that does not exist, and the
    // Architect is asked again with agents already going.
    const r = rig({ saveThrows: new Error('EROFS: read-only file system') })
    r.gate.boot()
    const outcome = r.gate.grant()
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('EROFS')
    expect(r.hires).toEqual([])
    expect(r.schedules).toEqual([])
    expect(r.reported.map((row) => row.cause)).toContain(CONSENT_UNWRITABLE)
  })

  it('still reports the company as not working after a failed grant', () => {
    const r = rig({ saveThrows: new Error('disk full') })
    r.gate.boot()
    expect(r.gate.grant().view.mayStartWork).toBe(false)
  })
})

describe('the terms moving under a standing grant', () => {
  it('pauses the company rather than carrying the old consent forward', () => {
    const r = rig({
      record: { grantedAt: '2026-09-01T00:00:00.000Z', terms: 1 },
      termsVersion: 2
    })
    expect(r.gate.boot().state).toBe('stale-terms')
    expect(r.hires).toEqual([])
  })

  it('re-grants against the new terms and starts', () => {
    const r = rig({
      record: { grantedAt: '2026-09-01T00:00:00.000Z', terms: 1 },
      termsVersion: 2
    })
    r.gate.boot()
    expect(r.gate.grant().ok).toBe(true)
    expect(r.saved).toEqual([{ grantedAt: '2026-09-07T22:00:00.000Z', terms: 2 }])
    expect(r.hires).toEqual([1])
  })
})

describe('the view the renderer gets', () => {
  it('carries the live disclosure, not a copy taken at construction', () => {
    const r = rig()
    expect(r.gate.view().disclosure).toEqual(DISCLOSURE)
    expect(r.gate.view().terms).toBe(CONSENT_TERMS_VERSION)
    expect(r.gate.view().grantedAt).toBeNull()
  })
})

/**
 * The upgrade path, against a home that PREDATES the feature.
 *
 * This is the M8.4 trap restated: `ensureHarnessHome` seeds a file only when it
 * is ABSENT, so no decision ever reaches a machine set up before it. The
 * Architect's `gate-policy.json` sat three days behind DD-1 for exactly this
 * reason. A consent record has the same shape, so the case that must be tested
 * is not a fresh home — it is an old one.
 */
describe('a home written before M8.12 existed', () => {
  const homes: string[] = []
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env['EPH_HOME']
  })

  afterEach(() => {
    vi.resetModules()
    if (saved === undefined) delete process.env['EPH_HOME']
    else process.env['EPH_HOME'] = saved
    for (const dir of homes.splice(0)) removeTempDir(dir)
  })

  function oldHome(config: Record<string, unknown>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-consent-old-'))
    homes.push(root)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return root
  }

  it('stays VALID and reads as un-consented', () => {
    // Literally what a pre-M8.12 `config.json` looks like, written to disk and
    // read back through the real `ensureHarnessHome`.
    const root = oldHome({ schemaVersion: 1, mode: 'directed', everEnabledImproving: false })
    const home = ensureHarnessHome(root)
    expect(home.configWarning).toBeNull()
    expect(home.config.consent).toBeUndefined()

    const r = rig()
    expect(r.gate.boot().mayStartWork).toBe(false)
  })

  it('is not given a consent record by the harness — seeding only fills absences', () => {
    const root = oldHome({ schemaVersion: 1 })
    ensureHarnessHome(root)
    ensureHarnessHome(root)
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(onDisk['consent']).toBeUndefined()
  })

  it('a corrupt config.json runs on defaults, which grant nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-consent-bad-'))
    homes.push(root)
    fs.writeFileSync(path.join(root, 'config.json'), '{ "schemaVersion": 1, "consent": 7 }', 'utf8')
    const home = ensureHarnessHome(root)
    expect(home.configWarning).not.toBeNull()
    expect(home.config.consent).toBeUndefined()
    // A damaged file must never be the thing that authorises spending.
    expect(
      rig({ ...(home.config.consent ? { record: home.config.consent } : {}) }).gate.boot()
        .mayStartWork
    ).toBe(false)
  })

  it('a grant written through the real saveConfig survives a fresh read', async () => {
    const root = oldHome({ schemaVersion: 1, mode: 'directed' })
    process.env['EPH_HOME'] = root
    vi.resetModules()
    const config = await import('../../src/main/config')
    config.initHome()
    config.saveConfig({ consent: { grantedAt: '2026-09-07T22:00:00.000Z', terms: 1 } })

    // Read back from DISK through the real loader, not from the cached home:
    // the whole point of persisting is that the next boot finds it.
    const reread = ensureHarnessHome(root)
    expect(reread.configWarning).toBeNull()
    expect(reread.config.consent).toEqual({ grantedAt: '2026-09-07T22:00:00.000Z', terms: 1 })
    // And the fields that were already there are still there.
    expect(reread.config.mode).toBe('directed')
  })
})

describe('the book of record says the company started, whichever path started it', () => {
  it('writes awaiting-consent when boot finds no grant', () => {
    const r = rig()
    r.gate.boot()
    expect(r.logged).toHaveLength(1)
    expect(r.logged[0]).toMatchObject({
      kind: 'orchestrator',
      event: 'awaiting-consent',
      state: 'never-asked'
    })
  })

  it('writes consented, marked `boot`, when boot finds one', () => {
    const r = rig({
      record: { grantedAt: '2026-09-01T00:00:00.000Z', terms: CONSENT_TERMS_VERSION }
    })
    r.gate.boot()
    expect(r.logged).toHaveLength(1)
    expect(r.logged[0]).toMatchObject({ event: 'consented', from: 'boot' })
  })

  it('writes consented, marked `grant`, when the Architect says go in this session', () => {
    // The defect the live proof found: until M8.14 a grant given in THIS
    // session wrote no row at all, so a company started from the banner — or
    // from `ephctl` — produced four spawns with nothing above them saying why,
    // and `orchestrator/consented` did not appear until the next restart.
    const r = rig()
    r.gate.boot()
    r.gate.grant()
    expect(r.logged.map((entry) => entry['event'])).toEqual(['awaiting-consent', 'consented'])
    expect(r.logged[1]).toMatchObject({ event: 'consented', from: 'grant', state: 'granted' })
  })

  it('says the company started ONCE, however many times it is asked', () => {
    const r = rig()
    r.gate.grant()
    r.gate.grant()
    r.gate.boot()
    expect(r.logged.filter((entry) => entry['event'] === 'consented')).toHaveLength(1)
    expect(r.hires).toHaveLength(1)
  })

  it('writes nothing when the grant could not be recorded', () => {
    // Work running under a consent the next boot will not find is worse than a
    // button that reports its own failure — and a row claiming the company
    // started would be the same lie in the book of record.
    const r = rig({ saveThrows: new Error('EACCES: permission denied') })
    const outcome = r.gate.grant()
    expect(outcome.ok).toBe(false)
    expect(r.logged).toEqual([])
    expect(r.hires).toEqual([])
  })
})
