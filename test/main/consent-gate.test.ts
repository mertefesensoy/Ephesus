import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanyStart, CONSENT_UNWRITABLE, CONSENT_WITHHELD } from '../../src/main/consent'
import { ensureHarnessHome } from '../../src/main/home'
import {
  CONSENT_TERMS_VERSION,
  consentSentences,
  type ConsentDisclosure
} from '../../src/shared/consent'
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
  // M8c.3: a company WITH a ceiling, so every case below that is not about the
  // ceiling reads exactly as it did before. The unbudgeted cases set it to null
  // themselves, which is the state the whole package is about.
  dailyCeiling: 300_000
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
    blockedBy?: () => string | null
    /** M8c.3: a company nobody has set a ceiling for. */
    unbudgeted?: boolean
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
    disclose: () =>
      options.unbudgeted === true ? { ...DISCLOSURE, dailyCeiling: null } : DISCLOSURE,
    hire: () => hires.push(hires.length + 1),
    startSchedule: () => schedules.push(schedules.length + 1),
    report: (cause, detail) => reported.push({ cause, detail }),
    clear: (cause) => cleared.push(cause),
    log: (draft) => logged.push(draft),
    ...(options.blockedBy === undefined ? {} : { blockedBy: options.blockedBy }),
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

describe('another harness is working on this home (ADR-0034)', () => {
  const BUSY = 'another Ephesus harness is already working on this home (process 4321)'
  const consented = { grantedAt: '2026-09-01T00:00:00.000Z', terms: CONSENT_TERMS_VERSION }

  it('boots, hires nobody, arms nothing, and says why', () => {
    // Consent is ON FILE. Nothing is wrong with the answer the Architect gave;
    // what is wrong is that a second instance would share one book of record
    // and one single committer with the first.
    const r = rig({ record: consented, blockedBy: () => BUSY })
    r.gate.boot()
    expect(r.hires).toEqual([])
    expect(r.schedules).toEqual([])
    expect(r.reported).toEqual([{ cause: 'agora/home-occupied', detail: BUSY }])
    // Reported, NOT logged. The condition is this process's to show; the book
    // of record belongs to whoever owns the home (ADR-0034 second pass).
    expect(r.logged).toEqual([])
  })

  it('records a grant given anyway, and refuses to claim the company started', () => {
    // The Architect's answer is their answer; a busy home is not a reason to
    // forget it. What must not happen is `ephctl consent:grant` printing
    // "the company is starting" while nothing starts.
    const r = rig({ blockedBy: () => BUSY })
    const outcome = r.gate.grant()
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe(BUSY)
    expect(r.saved).toHaveLength(1)
    expect(r.hires).toEqual([])
    expect(r.logged).toEqual([])
  })

  it('refuses a grant on a home that had ALREADY consented, too', () => {
    const r = rig({ record: consented, blockedBy: () => BUSY })
    const outcome = r.gate.grant()
    expect(outcome.ok).toBe(false)
    expect(r.hires).toEqual([])
  })

  // There was a test here asserting the gate "does not latch" — that a company
  // blocked at boot starts once the other harness stops. It was DELETED rather
  // than kept: in production `blockedBy` closes over a decision boot took once
  // (`index.ts`, the `occupancy` const), so nothing can ever flip it inside a
  // process, and the refusal tells the reader to restart. A green test for a
  // path production cannot reach is worse than no test — it reports a guarantee
  // the product does not make. Recorded rather than silently dropped, because
  // the next reader of `startWork` will wonder why `started` is left false: it
  // is because a block is not a start, not because recovery is offered.

  it('still starts normally when nothing is blocking', () => {
    const r = rig({ record: consented, blockedBy: () => null })
    r.gate.boot()
    expect(r.hires).toHaveLength(1)
    expect(r.reported).toEqual([])
  })
})

/**
 * **M8c.3 — silence is not an answer about spend.**
 *
 * `unbudgeted` stays the shipped default (ADR-0029). What changes is that a
 * company may not START on it by omission. `EXIT-M8.md` §2 calls setting a
 * ceiling *"the step that is skipped and then regretted"*, and it was skipped on
 * both real runs precisely because it was optional — 2026-09-09 spent $11.22 and
 * the M8b rehearsal $17.77, neither bounded by anything.
 *
 * The Architect may still run unbudgeted, and often should. It just has to be an
 * ANSWER.
 */
describe('the ceiling is a question the grant must answer (M8c.3)', () => {
  it('REFUSES to start a company nobody has bounded, and names both ways out', () => {
    const r = rig({ unbudgeted: true })

    const outcome = r.gate.grant()

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('no daily token ceiling')
    // Both answers, by name — the refusal teaches the rule, to `watch:approve`'s
    // standard, rather than saying no and stopping.
    expect(outcome.reason).toContain('budget:set --daily')
    expect(outcome.reason).toContain('--unbudgeted true')
    // Nothing happened: not hired, not scheduled, and NOT written down. A
    // consent recorded for a start that was refused would come back next boot
    // as an answer nobody gave.
    expect(r.hires).toEqual([])
    expect(r.schedules).toEqual([])
    expect(r.saved).toEqual([])
  })

  it('starts unbudgeted when the Architect says so explicitly', () => {
    const r = rig({ unbudgeted: true })

    const outcome = r.gate.grant(true)

    expect(outcome.ok).toBe(true)
    expect(r.hires).toEqual([1])
    expect(r.schedules).toEqual([1])
    expect(r.saved).toHaveLength(1)
  })

  it('needs no answer when a ceiling is already set', () => {
    // The ordinary path: a company with a ceiling is not interrogated about one.
    const outcome = rig().gate.grant()

    expect(outcome.ok).toBe(true)
  })

  it('does not re-interrogate a company that already consented', () => {
    // The idempotent path. A grant on file is an answer already given, and a
    // second click on a running company must not refuse it — which would make
    // `grant()` stop being idempotent exactly when a second window opens.
    const r = rig({
      unbudgeted: true,
      record: { grantedAt: '2026-09-06T12:00:00.000Z', terms: CONSENT_TERMS_VERSION }
    })

    expect(r.gate.grant().ok).toBe(true)
  })

  it('re-asks a company that consented before the ceiling was a question', () => {
    // The terms version is exactly the mechanism for this: v1's disclosure said
    // "spending is unbudgeted until you set one in WATCH → settings" and asked
    // nothing. A grant made against that is not an answer to the question v2
    // asks, so it must not carry over — otherwise the one machine that has
    // already consented is the one machine this package does not reach.
    const stale = rig({
      unbudgeted: true,
      record: { grantedAt: '2026-09-06T12:00:00.000Z', terms: 1 }
    })

    expect(stale.gate.view().state).toBe('stale-terms')
    expect(stale.gate.view().mayStartWork).toBe(false)
    // And it meets the ceiling question, rather than being waved through.
    expect(stale.gate.grant().ok).toBe(false)
    expect(stale.gate.grant(true).ok).toBe(true)
  })

  it('says so on the consent screen, in the words the disclosure builds', () => {
    const sentences = consentSentences({ ...DISCLOSURE, dailyCeiling: null })

    expect(sentences.join(' ')).toContain('There is NO daily token ceiling')
    expect(sentences.join(' ')).toContain('Starting is refused until you answer')
  })

  it('CONTROL — the same sentences on a bounded company say the figure instead', () => {
    const sentences = consentSentences({ ...DISCLOSURE, dailyCeiling: 300_000 })

    expect(sentences.join(' ')).toContain('300,000 tokens a day')
    expect(sentences.join(' ')).not.toContain('Starting is refused')
  })
})
