import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CostTotals } from '../../src/shared/cost'
import type { AgentSpawnConfig } from '../../src/main/engines'
import { CostLedger, MemoryLedgerStore, type LedgerStore } from '../../src/main/watch/ledger'
import { BudgetWatcher, type BudgetedAgent } from '../../src/main/watch/budgets'
import { makeFakeAdapter } from '../fakes/fake-adapter'
import { cleanupHomes, startCompany, type Company } from './company'

/**
 * **S-LEDGER** (TEST-STRATEGY §3): "cost folding across restart — the upstream
 * regression class: assert cumulative figure survives restart and session
 * figure resets, sourced from transcript fixtures."
 *
 * The regression class is worth naming, because it is what shapes every
 * assertion here: upstream kept a running total in memory, so a restart lost
 * the day's spend and the cap it was supposed to enforce. ADR-0011's answer is
 * that **cost figures come only from the durable ledger, never from an
 * in-memory counter** — so "restart" here means the harness objects are thrown
 * away and rebuilt over the same durable rows, exactly as a killed Electron
 * process and a new one would.
 *
 * The transcripts are not fixtures the test hand-placed: a REAL spawned
 * `fake-engine` writes them, in its own format, in its own directory, and the
 * adapter's own `TranscriptReader` folds them.
 *
 * `better-sqlite3` is Electron-ABI and cannot load under the Node test runner
 * (BUILD-PROMPT §10), so the durable plane appears here through its seam —
 * `LedgerStore`, which `db.ts` implements in production. What that seam cannot
 * prove is SQLite's own durability; what it does prove is the thing that
 * actually regressed, which is the harness keeping its own copy.
 */

const companies: Company[] = []

/** Tokens in a totals row — the figure a budget is measured in (ADR-0011). */
function tokens(totals: CostTotals): number {
  return totals.inTokens + totals.outTokens
}

function cumulative(company: Company, agentId: string, dailyTokens: number | null): number {
  return tokens(company.costs.spendFor(agentId, dailyTokens, 'engine').cumulativeTotals)
}

afterEach(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
})

/** A budgeted spawn over the real fake adapter, folded from a real cwd. */
function budgeted(
  company: Company,
  agentId: string,
  cwd: string,
  dailyTokens: number | null
): BudgetedAgent {
  const adapter = makeFakeAdapter({ scriptPath: path.join(company.home, 'unused.json') })
  const cfg: AgentSpawnConfig = {
    agentId,
    hookToken: 'scenario-token',
    hookEndpoint: company.hookServer.endpoint() ?? '',
    cwd,
    engineConfigDir: path.join(company.home, 'engine-config', agentId),
    commitIdentity: null,
    ghTokenCommand: '',
    envGrants: {},
    identityPath: path.join(company.agora.agentDir(agentId), 'identity.md'),
    protocolPath: company.agora.pathOf('PROTOCOL.md'),
    memory: '',
    recallCommand: '',
    autonomy: 'manual'
  }
  return { agentId, adapter, cfg, dailyTokens, sessionIds: [company.sessionOf(agentId)] }
}

/** Spends `inTokens`/`outTokens` through a real engine turn, then folds it. */
async function spend(
  company: Company,
  agentId: string,
  cwd: string,
  dailyTokens: number | null,
  facts: readonly { inTokens: number; outTokens: number }[]
): Promise<void> {
  await company.runTurnIn(
    agentId,
    cwd,
    facts.map((fact) => ({ kind: 'write-transcript', ...fact, model: 'fake-1' }))
  )
  await company.foldSpend(budgeted(company, agentId, cwd, dailyTokens), cwd)
}

async function boot(store?: LedgerStore): Promise<Company> {
  const company = await startCompany(store ? { ledgerStore: store } : {})
  companies.push(company)
  return company
}

describe('S-LEDGER — spend is folded from what the engine actually wrote', () => {
  it('folds a real transcript a real engine produced', async () => {
    const company = await boot()
    company.hire('agent.mason')
    const cwd = path.join(company.home, 'repo-mason')
    await spend(company, 'agent.mason', cwd, 100_000, [{ inTokens: 300, outTokens: 200 }])

    // The file exists because an engine wrote it, not because the test did.
    const transcripts = path.join(cwd, '.fake-engine', 'transcripts')
    expect(fs.readdirSync(transcripts)).toHaveLength(1)

    const spendNow = company.costs.spendFor('agent.mason', 100_000, 'engine')
    expect(tokens(spendNow.cumulativeTotals)).toBe(500)
    expect(tokens(spendNow.sessionTotals)).toBe(500)
  })

  it('adds a second turn to the same day rather than replacing it', async () => {
    const company = await boot()
    company.hire('agent.mason')
    const cwd = path.join(company.home, 'repo-mason')
    await spend(company, 'agent.mason', cwd, 100_000, [{ inTokens: 300, outTokens: 200 }])
    await spend(company, 'agent.mason', cwd, 100_000, [{ inTokens: 100, outTokens: 100 }])
    expect(cumulative(company, 'agent.mason', 100_000)).toBe(700)
  })

  it('does not double-count a transcript it has already folded', async () => {
    const company = await boot()
    company.hire('agent.mason')
    const cwd = path.join(company.home, 'repo-mason')
    await spend(company, 'agent.mason', cwd, 100_000, [{ inTokens: 300, outTokens: 200 }])
    // Folding again with nothing new written must be a no-op: the cursor is
    // what makes a periodic fold safe to run forever.
    await company.foldSpend(budgeted(company, 'agent.mason', cwd, 100_000), cwd)
    await company.foldSpend(budgeted(company, 'agent.mason', cwd, 100_000), cwd)
    expect(cumulative(company, 'agent.mason', 100_000)).toBe(500)
  })

  it('never attributes one agent’s spend to another', async () => {
    const company = await boot()
    company.hire('agent.mason')
    company.hire('agent.scribe')
    await spend(company, 'agent.mason', path.join(company.home, 'repo-a'), 100_000, [
      { inTokens: 300, outTokens: 200 }
    ])
    await spend(company, 'agent.scribe', path.join(company.home, 'repo-b'), 100_000, [
      { inTokens: 10, outTokens: 10 }
    ])
    expect(cumulative(company, 'agent.mason', 100_000)).toBe(500)
    expect(cumulative(company, 'agent.scribe', 100_000)).toBe(20)
  })
})

describe('S-LEDGER — the restart property (the upstream regression class)', () => {
  it('keeps the cumulative figure across a restart', async () => {
    const store = new MemoryLedgerStore()
    const first = await boot(store)
    first.hire('agent.mason')
    const cwd = path.join(first.home, 'repo-mason')
    await spend(first, 'agent.mason', cwd, 100_000, [{ inTokens: 300, outTokens: 200 }])
    expect(cumulative(first, 'agent.mason', 100_000)).toBe(500)

    // The harness dies. Everything it held in memory dies with it; the durable
    // rows do not.
    await first.close()
    const second = await boot(store)
    expect(cumulative(second, 'agent.mason', 100_000)).toBe(500)
  })

  it('resets the SESSION figure across a restart, because the session is gone', async () => {
    const store = new MemoryLedgerStore()
    const first = await boot(store)
    first.hire('agent.mason')
    const cwd = path.join(first.home, 'repo-mason')
    await spend(first, 'agent.mason', cwd, 100_000, [{ inTokens: 300, outTokens: 200 }])
    expect(tokens(first.costs.spendFor('agent.mason', 100_000, 'engine').sessionTotals)).toBe(500)

    await first.close()
    const second = await boot(store)
    // FR-11.2 shows both figures side by side precisely so this difference is
    // legible: what this run has spent, and what the day has.
    const after = second.costs.spendFor('agent.mason', 100_000, 'engine')
    expect(tokens(after.sessionTotals)).toBe(0)
    expect(tokens(after.cumulativeTotals)).toBe(500)
  })

  it('keeps counting the day after a restart, from where it left off', async () => {
    const store = new MemoryLedgerStore()
    const first = await boot(store)
    first.hire('agent.mason')
    await spend(first, 'agent.mason', path.join(first.home, 'repo-mason'), 100_000, [
      { inTokens: 300, outTokens: 200 }
    ])
    await first.close()

    const second = await boot(store)
    second.hire('agent.mason')
    await spend(second, 'agent.mason', path.join(second.home, 'repo-mason'), 100_000, [
      { inTokens: 50, outTokens: 50 }
    ])
    const after = second.costs.spendFor('agent.mason', 100_000, 'engine')
    expect(tokens(after.cumulativeTotals)).toBe(600)
    expect(tokens(after.sessionTotals)).toBe(100)
  })

  it('enforces a budget against the DAY, not against this run', async () => {
    const store = new MemoryLedgerStore()
    const first = await boot(store)
    first.hire('agent.mason')
    await spend(first, 'agent.mason', path.join(first.home, 'repo-mason'), 600, [
      { inTokens: 300, outTokens: 200 }
    ])
    expect(first.costs.spendFor('agent.mason', 600, 'engine').budget.state).toBe('ok')
    await first.close()

    // Upstream's bug in one assertion: after a restart the cap must still know
    // about the 500 already spent, or a crash-loop spends the budget N times.
    const second = await boot(store)
    second.hire('agent.mason')
    await spend(second, 'agent.mason', path.join(second.home, 'repo-mason'), 600, [
      { inTokens: 100, outTokens: 100 }
    ])
    expect(second.costs.spendFor('agent.mason', 600, 'engine').budget.state).toBe('breached')
  })
})

describe('S-LEDGER — a resumed session continues, a fresh one does not', () => {
  it('continues the session figure when the engine resumed the same session', async () => {
    const store = new MemoryLedgerStore()
    const first = await boot(store)
    first.hire('agent.mason')
    const session = first.sessionOf('agent.mason')
    await spend(first, 'agent.mason', path.join(first.home, 'repo-mason'), 100_000, [
      { inTokens: 300, outTokens: 200 }
    ])
    await first.close()

    // M3.7's respawn-with-memory: `--resume <session>` brings the same engine
    // session back, so "this session's spend" legitimately continues. A fresh
    // session, by contrast, starts at zero — that is the case above.
    const second = await boot(store)
    second.hire('agent.mason', session)
    expect(tokens(second.costs.spendFor('agent.mason', 100_000, 'engine').sessionTotals)).toBe(500)
  })
})

describe('S-LEDGER — the figures come from the store, never from memory', () => {
  it('re-reads the durable rows on every query', async () => {
    const store = new MemoryLedgerStore()
    let reads = 0
    const counting: LedgerStore = {
      append: (row) => store.append(row),
      rowsFor: (agentId) => {
        reads += 1
        return store.rowsFor(agentId)
      },
      cursor: (agentId, source) => store.cursor(agentId, source),
      saveCursor: (cursor) => store.saveCursor(cursor)
    }
    const ledger = new CostLedger({ store: counting })
    ledger.spendFor('agent.mason', 100_000, 'engine')
    const after = reads
    ledger.spendFor('agent.mason', 100_000, 'engine')
    // A harness that answered the second query from a cached total is the
    // regression this suite exists for.
    expect(reads).toBeGreaterThan(after)
  })

  it('reports an engine that cannot report usage as `none`, not as zero spend', async () => {
    const company = await boot()
    company.hire('agent.mason')
    const spendNow = company.costs.spendFor('agent.mason', 100_000, 'none')
    // A zero from an engine that cannot report and a zero from an agent that
    // spent nothing are different facts (invariant §7).
    expect(spendNow.reporting).toBe('none')
  })

  it('reports an unbudgeted agent as `unbudgeted`, never as breached', async () => {
    const company = await boot()
    company.hire('agent.mason')
    await spend(company, 'agent.mason', path.join(company.home, 'repo-mason'), null, [
      { inTokens: 9_000, outTokens: 9_000 }
    ])
    const spendNow = company.costs.spendFor('agent.mason', null, 'engine')
    expect(spendNow.budget.state).toBe('unbudgeted')
    expect(tokens(spendNow.cumulativeTotals)).toBe(18_000)
  })
})

describe('S-LEDGER — a fold never takes the harness down', () => {
  it('survives an unreadable transcript and folds the rest', async () => {
    const company = await boot()
    company.hire('agent.mason')
    const cwd = path.join(company.home, 'repo-mason')
    await spend(company, 'agent.mason', cwd, 100_000, [{ inTokens: 300, outTokens: 200 }])

    // A torn line from a killed engine. The reader skips what it cannot parse
    // rather than inventing facts (ADR-0009's TranscriptReader contract).
    const session = company.sessionOf('agent.mason')
    const file = path.join(cwd, '.fake-engine', 'transcripts', `${session}.jsonl`)
    fs.appendFileSync(file, '{ half a fact\n')
    fs.appendFileSync(
      file,
      `${JSON.stringify({ sessionId: session, model: 'fake-1', inTokens: 7, outTokens: 3, costUsd: null, at: new Date().toISOString() })}\n`
    )
    const watcher = new BudgetWatcher({ ledger: company.costs, agents: () => [] })
    await watcher.foldNow(budgeted(company, 'agent.mason', cwd, 100_000))
    expect(cumulative(company, 'agent.mason', 100_000)).toBe(510)
  })
})
