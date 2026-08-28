import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GYM_SCHEMA_VERSION } from '../../src/shared/gym'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { ODEON_ENDPOINT } from '../../src/shared/reserved'
import { Gymnasium } from '../../src/main/gymnasium'

/**
 * The Gymnasium's ledger and loop (ADR-0015, FR-12, SDD §7.6).
 *
 * The ledger is the company's memory of how it changed, so the tests that
 * matter most are the ones about what it will NOT do: refuse a shapeless
 * proposal before a human sees it, refuse a widening proposal whoever asks, and
 * never lose a row.
 */

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

let seq = 0

function proposal(over: Record<string, unknown> = {}, from = 'agent.artemis'): Message {
  seq += 1
  return composeMessage({
    id: makeMessageId(new Date(2026, 7, 28, 12, 0, seq), 'ee55'),
    conversation: 'conv-gym',
    in_reply_to: null,
    from,
    to: ODEON_ENDPOINT,
    act: 'propose',
    subject: 'improvement',
    body: JSON.stringify({
      schemaVersion: GYM_SCHEMA_VERSION,
      kind: 'gym-proposal',
      title: 'Shorten the wake nudge',
      class: 'craft',
      evidence: ['log#412'],
      change: 'Trim the wake nudge prompt to two sentences.',
      costRisk: 'Low: one prompt file, reversible.',
      metric: { what: 'median turns after a wake', target: '2', windowDays: 14 },
      rollback: 'Restore the previous prompt file from git.',
      ...over
    }),
    hops: 0,
    created_at: new Date().toISOString()
  })
}

interface Rig {
  readonly gym: Gymnasium
  readonly logs: Record<string, unknown>[]
  readonly degradations: string[]
  readonly agoraRoot: string
  ledger(): string
  proposals(): string[]
}

function rig(over: { seed?: string | null; spend?: number } = {}): Rig {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-gym-'))
  homes.push(home)
  const agoraRoot = path.join(home, 'agora')

  // A FIXTURE archive by default, not the repo’s real one: the real archive
  // grows every week, and a suite that broke because the company filed another
  // proposal would be testing the wrong thing. One case below seeds from the
  // real `docs/gymnasium/` on purpose, to assert FR-12.6’s continuity.
  const seedFrom =
    over.seed === null
      ? path.join(home, 'no-such-archive')
      : (over.seed ?? 'test/fixtures/gymnasium-seed')

  const logs: Record<string, unknown>[] = []
  const degradations: string[] = []
  const gym = new Gymnasium({
    agoraRoot,
    seedFrom,
    // Omitted when a case sets no spend, so slice() honestly reports the
    // missing attribution as null (finding 2) rather than a constant zero.
    ...(over.spend === undefined ? {} : { gymSpend: () => over.spend as number }),
    onLogEvent: (draft) => logs.push(draft),
    onDegraded: (detail) => degradations.push(detail),
    now: () => new Date('2026-08-28T12:00:00.000Z')
  })

  return {
    gym,
    logs,
    degradations,
    agoraRoot,
    ledger: () => fs.readFileSync(path.join(agoraRoot, 'gymnasium', 'LEDGER.md'), 'utf8'),
    proposals: () => {
      const dir = path.join(agoraRoot, 'gymnasium', 'proposals')
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []
    }
  }
}

describe('FR-12.6 — the ledger seeds from the repo’s own archive', () => {
  it('carries the REAL build-phase archive into the running system', () => {
    // Seeded from `docs/gymnasium/` on purpose — the one case that should.
    // FR-12.6: the improvement record is continuous from the build phase, so
    // the running system inherits the rows rather than starting over.
    const r = rig({ seed: 'docs/gymnasium' })
    const rows = r.gym.rows()

    expect(rows.length).toBeGreaterThan(0)
    expect(r.logs.find((log) => log['event'] === 'seeded')).toBeDefined()
    // The archive links each id to its proposal file; the rows must survive
    // that formatting, or a seeded ledger reads as empty and the next mint
    // collides with a row already on the page.
    expect(rows.every((row) => /^GYM-\d{3,}$/.test(row.id))).toBe(true)
  })

  it('mints past everything the real archive already holds', () => {
    const r = rig({ seed: 'docs/gymnasium' })
    const highest = r.gym.rows().length
    expect(highest).toBeGreaterThan(0)

    const outcome = r.gym.propose(proposal())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Not GYM-001: that id is taken by the archive it inherited.
    expect(r.gym.rows().some((row) => row.id === outcome.id)).toBe(true)
    expect(r.gym.rows().filter((row) => row.id === outcome.id)).toHaveLength(1)
  })

  it('seeds the proposal files beside the ledger, so no link on the page is broken', () => {
    // SDD §2: `proposals/GYM-*.md` is seeded WITH the ledger. Before the M5
    // close-out audit (finding 4) only LEDGER.md crossed over, so every
    // seeded row's link pointed at nothing and `proposalDoc()` was null.
    const r = rig({ seed: 'docs/gymnasium' })
    expect(r.gym.rows().length).toBeGreaterThan(0)
    expect(r.proposals().some((name) => name.startsWith('GYM-001'))).toBe(true)
  })

  it("the archive's Measured cells survive the first new proposal (R2)", () => {
    // The real archive carries `due 2026-09-11` Measured notes. Before the
    // audit's finding 1 fix, the first propose() — which rewrites every row —
    // erased them all permanently.
    const r = rig({ seed: 'docs/gymnasium' })
    const before = r.gym.rows().find((row) => row.measured !== null)
    expect(before).toBeDefined()

    expect(r.gym.propose(proposal()).ok).toBe(true)
    const after = r.gym.rows().find((row) => row.id === before!.id)
    expect(after?.measured).toEqual(before!.measured)
    expect(r.ledger()).toContain(before!.measured ?? '')
  })

  it('starts from a fixture archive in every other case, so the suite does not', () => {
    // …break each time the company files another real proposal.
    expect(rig().gym.rows()).toEqual([])
  })

  it('starts empty and SAYS SO when there is no archive to seed from', () => {
    const r = rig({ seed: null })
    expect(r.gym.rows()).toEqual([])
    expect(r.degradations.join(' ')).toContain('the ledger starts empty')
  })

  it('seeds once — a second read does not re-seed over what has happened since', () => {
    const r = rig()
    r.gym.propose(proposal())
    r.gym.rows()
    expect(r.logs.filter((log) => log['event'] === 'seeded')).toHaveLength(1)
    expect(r.gym.rows()).toHaveLength(1)
  })
})

describe('a proposal is refused before a human ever sees it (FR-12.2)', () => {
  it('files a complete proposal and writes its own document', () => {
    const r = rig()
    const outcome = r.gym.propose(proposal())

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.id).toBe('GYM-001')
    expect(r.proposals()[0]).toContain('GYM-001')
    const doc = fs.readFileSync(
      path.join(r.agoraRoot, 'gymnasium', 'proposals', r.proposals()[0] ?? ''),
      'utf8'
    )
    expect(doc).toContain('## Success metric')
    expect(doc).toContain('## Rollback')
    expect(doc).toContain('log#412')
  })

  it('REFUSES a proposal with no rollback, and writes nothing', () => {
    const r = rig()
    const outcome = r.gym.propose(proposal({ rollback: '' }))
    expect(outcome.ok).toBe(false)
    expect(r.gym.rows()).toEqual([])
    expect(r.proposals()).toEqual([])
  })

  it('REFUSES a widening proposal, whoever filed it', () => {
    const r = rig()
    const outcome = r.gym.propose(
      proposal({ change: 'Amend ADR-0004 so agents may commit directly.' })
    )
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reasons.join(' ')).toContain('may not')
    expect(r.gym.rows()).toEqual([])
    // Recorded as its own event: an attempt to widen authority is exactly what
    // a later reader will want to find (NFR-13).
    expect(r.logs.find((log) => log['event'] === 'refused-widening')).toBeDefined()
  })

  it('refuses new work once the budget slice is spent (R3)', () => {
    const r = rig({ spend: 10_000_000 })
    const outcome = r.gym.propose(proposal())
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reasons.join(' ')).toContain('R3')
  })

  it('reports the slice for the standup brief (FR-12.5)', () => {
    expect(rig({ spend: 25 }).gym.slice()).toMatchObject({ spentTokens: 25 })
  })

  it('reports NULL, not zero, when nothing attributes gym spend yet', () => {
    // Finding 2 of the M5 close-out audit: production wires no gymSpend
    // source, and the brief was narrating the resulting constant 0 as if it
    // were a ledger figure. A missing measurement must read as missing.
    expect(rig().gym.slice().spentTokens).toBeNull()
  })
})

describe('R1 — the verdict is the Architect’s, enforced here too', () => {
  it('records an Architect approval', () => {
    const r = rig()
    r.gym.propose(proposal())
    const outcome = r.gym.verdict('GYM-001', 'approved', 'architect')

    expect(outcome.ok).toBe(true)
    expect(r.gym.rows()[0]?.status).toBe('approved')
  })

  it.each(['agent.artemis', 'agent.mason', 'human'])('REFUSES a verdict from %s', (decider) => {
    const r = rig()
    r.gym.propose(proposal())
    const outcome = r.gym.verdict('GYM-001', 'approved', decider)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('R1')
    expect(r.gym.rows()[0]?.status).toBe('proposed')
    expect(r.logs.find((log) => log['event'] === 'verdict-refused')).toBeDefined()
  })

  it('refuses a verdict on a proposal that is not on file', () => {
    expect(rig().gym.verdict('GYM-999', 'approved', 'architect').ok).toBe(false)
  })
})

describe('R2 — the ledger is total, and rows are never lost', () => {
  it('keeps a rejected row as training data', () => {
    const r = rig()
    r.gym.propose(proposal())
    r.gym.verdict('GYM-001', 'rejected', 'architect')

    const rows = r.gym.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('rejected')
    expect(r.ledger()).toContain('GYM-001')
  })

  it('never shrinks: every transition leaves the row count where it was or higher', () => {
    const r = rig()
    r.gym.propose(proposal())
    r.gym.propose(proposal({ title: 'Second idea' }))
    const before = r.gym.rows().length

    r.gym.verdict('GYM-001', 'approved', 'architect')
    r.gym.land('GYM-001')
    r.gym.measure('GYM-001', 'median turns fell to 2')

    expect(r.gym.rows().length).toBeGreaterThanOrEqual(before)
    expect(r.gym.rows().map((row) => row.id)).toEqual(['GYM-001', 'GYM-002'])
  })

  it('a measured outcome survives the NEXT rewrite — R2, asserted end to end', () => {
    // M5 close-out audit, findings 1 + 10: `measure()` used to record an
    // outcome that `rows()` immediately read back as null (the seven-cell
    // render), and the next `propose()` — which rewrites every row — erased
    // it from the file permanently. The ledger is total, provably.
    const r = rig()
    r.gym.propose(proposal())
    r.gym.verdict('GYM-001', 'approved', 'architect')
    r.gym.land('GYM-001')
    r.gym.measure('GYM-001', 'median turns fell to 2')

    const measured = r.gym.rows().find((row) => row.id === 'GYM-001')
    expect(measured?.status).toBe('validated')
    expect(measured?.outcome).toBe('median turns fell to 2')
    expect(measured?.measured).not.toBeNull()

    // The erasure path: a later proposal rewrites the whole table.
    r.gym.propose(proposal({ title: 'A later idea' }))
    const after = r.gym.rows().find((row) => row.id === 'GYM-001')
    expect(after?.outcome).toBe('median turns fell to 2')
    expect(after?.measured).toEqual(measured?.measured)
  })

  it('walks the documented flow and refuses to skip a step', () => {
    const r = rig()
    r.gym.propose(proposal())
    // Not approved yet, so it cannot land.
    expect(r.gym.land('GYM-001').ok).toBe(false)
    r.gym.verdict('GYM-001', 'approved', 'architect')
    // Not landed yet, so it cannot be measured.
    expect(r.gym.measure('GYM-001', 'x').ok).toBe(false)
    expect(r.gym.land('GYM-001').ok).toBe(true)
    expect(r.gym.measure('GYM-001', 'x').ok).toBe(true)
    expect(r.gym.rows()[0]?.status).toBe('validated')
  })

  it('REGRESSES a landed change whose metric could not be measured (FR-12.4)', () => {
    const r = rig()
    r.gym.propose(proposal())
    r.gym.verdict('GYM-001', 'approved', 'architect')
    r.gym.land('GYM-001')
    r.gym.measure('GYM-001', null)

    expect(r.gym.rows()[0]?.status).toBe('regressed')
    const event = r.logs.find((log) => log['event'] === 'regressed')
    expect(event).toMatchObject({ kind: 'gym', rollback: true })
  })

  it('records every transition in the book of record (NFR-13)', () => {
    const r = rig()
    r.gym.propose(proposal())
    r.gym.verdict('GYM-001', 'approved', 'architect')
    r.gym.land('GYM-001')
    r.gym.measure('GYM-001', 'done')

    expect(r.logs.map((log) => log['event'])).toEqual(
      expect.arrayContaining(['seeded', 'proposed', 'approved', 'landed', 'validated'])
    )
  })
})
