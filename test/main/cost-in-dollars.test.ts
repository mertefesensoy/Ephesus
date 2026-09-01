import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeCostFacts } from '../../src/main/engines/claude'
import { ClaudeAdapter } from '../../src/main/engines/claude'
import { PromptStore } from '../../src/main/prompts'
import { BudgetWatcher, type BudgetedAgent } from '../../src/main/watch/budgets'
import { CostLedger, MemoryLedgerStore } from '../../src/main/watch/ledger'
import { sessionCostOf } from '../../src/shared/cost'
import type { AgentSpawnConfig, EngineAdapter } from '../../src/main/engines'

/**
 * Money in the ledger, from the engine's own figures (ADR-0011's `cost_usd`,
 * null from M3 until this change).
 *
 * The arithmetic is in `test/shared/fold-costs.test.ts`. This file owns the
 * path from a real transcript line to a dollar figure on `AgentSpend` — parser,
 * reader, ledger, and the production watcher that calls them — because a fold
 * nothing reaches is worth nothing.
 *
 * Production call path:
 *   src/main/watch/budgets.ts  foldOne() -> reader.costs() -> ledger.foldCosts()
 *   src/main/engines/claude.ts claudeTranscripts.costs -> claudeCostFacts()
 *   src/shared/cost.ts         foldCosts()
 *
 * Every fixture below is the shape of a REAL `cost-state` line, copied from the
 * corpus (see the parser's own comment for what that corpus established).
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-cost-'))
  temps.push(dir)
  return dir
}

/** A real cost-state line, trimmed to what the parser reads. */
function costState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'cost-state',
    sessionId: 'sess-1',
    totalCostUSD: 0.4845593999999999,
    totalAPIDuration: 125847,
    startTime: 1788268546940,
    modelUsage: {
      'claude-haiku-4-5-20251001': {
        inputTokens: 1966,
        outputTokens: 24,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.0020859999999999997
      },
      'claude-sonnet-5': {
        inputTokens: 1019,
        outputTokens: 7678,
        cacheReadInputTokens: 503917,
        cacheCreationInputTokens: 75718,
        webSearchRequests: 0,
        costUSD: 0.4824733999999999
      }
    },
    hasUnknownModelCost: false,
    ...over
  }
}

/** An assistant turn, so the ledger has dated token rows to bill money to. */
function assistantTurn(at: string, model = 'claude-sonnet-5'): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId: 'sess-1',
    timestamp: at,
    message: { model, usage: { input_tokens: 1019, output_tokens: 7678 } }
  }
}

describe('claudeCostFacts — reading a cost-state line', () => {
  it('yields one cumulative figure per model', () => {
    const facts = claudeCostFacts(costState())
    expect(facts).toHaveLength(2)
    const sonnet = facts.find((f) => f.model === 'claude-sonnet-5')
    expect(sonnet?.cumulativeUsd).toBeCloseTo(0.4824734, 9)
    expect(sonnet?.sessionId).toBe('sess-1')
    expect(sonnet?.priced).toBe(true)
  })

  it('ignores every line that is not a cost-state', () => {
    expect(claudeCostFacts(assistantTurn('2026-09-01T10:00:00Z'))).toEqual([])
    expect(claudeCostFacts({ type: 'user', message: {} })).toEqual([])
    expect(claudeCostFacts(null)).toEqual([])
    expect(claudeCostFacts('cost-state')).toEqual([])
  })

  it('refuses a cost-SHAPED line of some other type', () => {
    // The `type` check is the load-bearing one, and this is the case that
    // proves it: a line carrying a sessionId and a modelUsage-shaped object
    // that is NOT the engine's running total. Reading money out of a summary
    // line, or out of whatever a future transcript version calls this, would
    // add a bill nobody was charged. Duck-typing is not enough here.
    expect(claudeCostFacts(costState({ type: 'cost-state-v2' }))).toEqual([])
    expect(claudeCostFacts(costState({ type: 'summary' }))).toEqual([])
    const untyped = costState()
    delete untyped['type']
    expect(claudeCostFacts(untyped)).toEqual([])
  })

  it('marks the bill incomplete when the engine could not price a model', () => {
    const facts = claudeCostFacts(costState({ hasUnknownModelCost: true }))
    expect(facts.every((f) => f.priced)).toBe(false)
  })

  it('treats a missing flag as priced, never as incomplete', () => {
    const raw = costState()
    delete raw['hasUnknownModelCost']
    expect(claudeCostFacts(raw).every((f) => f.priced)).toBe(true)
  })

  it('skips a model entry whose cost is not a usable number', () => {
    const facts = claudeCostFacts(
      costState({
        modelUsage: {
          good: { costUSD: 0.25 },
          missing: { inputTokens: 5 },
          nan: { costUSD: Number.NaN },
          negative: { costUSD: -1 },
          wrongType: { costUSD: '0.25' }
        }
      })
    )
    expect(facts.map((f) => f.model)).toEqual(['good'])
  })

  it('refuses a line with no session to attribute the money to', () => {
    expect(claudeCostFacts(costState({ sessionId: '' }))).toEqual([])
    const raw = costState()
    delete raw['sessionId']
    expect(claudeCostFacts(raw)).toEqual([])
  })
})

describe('the adapter reader — many snapshots, one running total', () => {
  function transcriptWith(lines: readonly unknown[]): string {
    const dir = tempDir()
    const file = path.join(dir, 'sess-1.jsonl')
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
    return file
  }

  const adapter = (): EngineAdapter =>
    new ClaudeAdapter({ prompts: new PromptStore('x', 'y'), hookShimPath: 'shim' })

  it('yields the NEWEST figure when a file carries several', () => {
    // A resumed session leaves an older, smaller snapshot earlier in the file.
    // Both reaching the fold as separate figures would double-count.
    const file = transcriptWith([
      costState({ modelUsage: { 'claude-sonnet-5': { costUSD: 0.2 } } }),
      assistantTurn('2026-09-01T10:00:00Z'),
      costState({ modelUsage: { 'claude-sonnet-5': { costUSD: 0.5 } } })
    ])
    return adapter()
      .transcripts?.costs?.(file)
      .then((facts) => {
        expect(facts).toHaveLength(1)
        expect(facts[0]?.cumulativeUsd).toBe(0.5)
      })
  })

  it('collapses the duplicate line the engine writes at session end', async () => {
    // 17 of 17 files in the corpus wrote the same cost-state twice.
    const file = transcriptWith([assistantTurn('2026-09-01T10:00:00Z'), costState(), costState()])
    const facts = (await adapter().transcripts?.costs?.(file)) ?? []
    expect(facts).toHaveLength(2) // two MODELS, not two lines
    expect(facts.filter((f) => f.model === 'claude-sonnet-5')).toHaveLength(1)
  })

  it('reports nothing for a transcript with no cost-state at all', async () => {
    // 3 of 20 files had none — a killed session. That must stay tellable from
    // "$0", which it is: no facts means no rows means costUsd stays null.
    const file = transcriptWith([assistantTurn('2026-09-01T10:00:00Z')])
    expect(await adapter().transcripts?.costs?.(file)).toEqual([])
  })

  it('reports nothing for a file that is not there', async () => {
    expect(await adapter().transcripts?.costs?.(path.join(tempDir(), 'gone.jsonl'))).toEqual([])
  })

  it('skips a torn line rather than failing the whole read', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'sess-1.jsonl')
    fs.writeFileSync(file, `${JSON.stringify(costState())}\n{"type":"cost-sta`, 'utf8')
    const facts = (await adapter().transcripts?.costs?.(file)) ?? []
    expect(facts).toHaveLength(2)
  })
})

describe('the ledger records the money', () => {
  function ledgerRig() {
    const store = new MemoryLedgerStore()
    const regressed: string[] = []
    const incomplete: string[] = []
    const ledger = new CostLedger({
      store,
      now: () => new Date('2026-09-02T09:00:00Z'),
      onCostRegressed: (_source, session, model) => regressed.push(`${session}/${model}`),
      onCostIncomplete: (source) => incomplete.push(source)
    })
    return { store, ledger, regressed, incomplete }
  }

  it('puts a dollar figure on an agent whose ledger had none', async () => {
    const { ledger } = ledgerRig()
    ledger.fold('agent.artemis', 'sess-1.jsonl', [
      {
        sessionId: 'sess-1',
        model: 'claude-sonnet-5',
        inTokens: 1019,
        outTokens: 7678,
        costUsd: null,
        at: '2026-09-01T10:00:00Z'
      }
    ])
    expect(ledger.spendFor('agent.artemis', null).cumulativeTotals.costUsd).toBeNull()

    ledger.foldCosts('agent.artemis', 'sess-1.jsonl', [
      { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.4824734, priced: true }
    ])
    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.cumulativeTotals.costUsd).toBeCloseTo(0.4824734, 9)
    // The tokens are untouched — money added no tokens.
    expect(spend.cumulativeTotals.inTokens).toBe(1019)
    expect(spend.cumulativeTotals.outTokens).toBe(7678)
  })

  it('stays put when the same transcript is folded again and again', () => {
    const { ledger } = ledgerRig()
    for (let i = 0; i < 10; i++) {
      ledger.foldCosts('agent.artemis', 'sess-1.jsonl', [
        { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5, priced: true }
      ])
    }
    expect(ledger.spendFor('agent.artemis', null).cumulativeTotals.costUsd).toBe(0.5)
  })

  it('says so out loud when a running total goes backwards', () => {
    const { ledger, regressed } = ledgerRig()
    ledger.foldCosts('agent.artemis', 'sess-1.jsonl', [
      { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5, priced: true }
    ])
    ledger.foldCosts('agent.artemis', 'sess-1.jsonl', [
      { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.2, priced: true }
    ])
    expect(regressed).toEqual(['sess-1/claude-sonnet-5'])
    // …and the earlier, larger figure stands rather than being corrected down.
    expect(ledger.spendFor('agent.artemis', null).cumulativeTotals.costUsd).toBe(0.5)
  })

  it('says so out loud when the bill is an understatement', () => {
    const { ledger, incomplete } = ledgerRig()
    ledger.foldCosts('agent.artemis', 'sess-1.jsonl', [
      { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5, priced: false }
    ])
    expect(incomplete).toEqual(['sess-1.jsonl'])
    // The priced part is still recorded: it is true, just not the whole bill.
    expect(ledger.spendFor('agent.artemis', null).cumulativeTotals.costUsd).toBe(0.5)
  })

  it('keeps session and cumulative dollars apart, as ADR-0011 requires', () => {
    const { ledger } = ledgerRig()
    ledger.noteSession('agent.artemis', 'sess-2')
    ledger.foldCosts('agent.artemis', 'sess-1.jsonl', [
      { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5, priced: true }
    ])
    ledger.foldCosts('agent.artemis', 'sess-2.jsonl', [
      { sessionId: 'sess-2', model: 'claude-sonnet-5', cumulativeUsd: 0.25, priced: true }
    ])
    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.sessionTotals.costUsd).toBe(0.25)
    expect(spend.cumulativeTotals.costUsd).toBe(0.75)
  })
})

describe('the production watcher actually calls it', () => {
  /** An adapter over a directory the test controls, with real Claude parsing. */
  function watcherRig(dir: string, opts: { costs?: boolean } = {}) {
    const claude = new ClaudeAdapter({ prompts: new PromptStore('x', 'y'), hookShimPath: 'shim' })
    const transcripts = claude.transcripts
    if (!transcripts) throw new Error('the reference engine must report transcripts')
    const adapter = {
      ...claude,
      transcripts: {
        transcriptDir: () => dir,
        read: transcripts.read.bind(transcripts),
        // Omitting `costs` is the other engine tier: tokens but no dollars.
        ...(opts.costs === false ? {} : { costs: transcripts.costs?.bind(transcripts) })
      }
    } as unknown as EngineAdapter

    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({ store, now: () => new Date('2026-09-02T09:00:00Z') })
    const agent: BudgetedAgent = {
      agentId: 'agent.artemis',
      adapter,
      cfg: { cwd: dir } as unknown as AgentSpawnConfig,
      dailyTokens: null,
      sessionIds: ['sess-1']
    }
    const watcher = new BudgetWatcher({ ledger, agents: () => [agent] })
    return { watcher, ledger, agent }
  }

  function writeTranscript(dir: string, lines: readonly unknown[]): void {
    fs.writeFileSync(
      path.join(dir, 'sess-1.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8'
    )
  }

  it('turns a real transcript into tokens AND dollars on one tick', async () => {
    const dir = tempDir()
    writeTranscript(dir, [assistantTurn('2026-09-01T10:00:00Z'), costState(), costState()])
    const { watcher, ledger } = watcherRig(dir)

    await watcher.tick()

    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.cumulativeTotals.inTokens).toBe(1019)
    // Both models' figures, from the engine's own numbers.
    expect(spend.cumulativeTotals.costUsd).toBeCloseTo(0.4845594, 9)
  })

  it('does not move on a second tick over an unchanged transcript', async () => {
    const dir = tempDir()
    writeTranscript(dir, [assistantTurn('2026-09-01T10:00:00Z'), costState(), costState()])
    const { watcher, ledger } = watcherRig(dir)

    await watcher.tick()
    const first = ledger.spendFor('agent.artemis', null).cumulativeTotals
    await watcher.tick()
    await watcher.tick()
    const after = ledger.spendFor('agent.artemis', null).cumulativeTotals

    expect(after).toEqual(first)
  })

  it('bills the money to the day the tokens were spent, not the day we looked', async () => {
    // The clock says 2026-09-02; the work happened on 09-01. A cost-state line
    // carries no timestamp, so without this the dollars land on the wrong day.
    const dir = tempDir()
    writeTranscript(dir, [assistantTurn('2026-09-01T10:00:00Z'), costState()])
    const { watcher, ledger } = watcherRig(dir)

    await watcher.tick()

    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.todayTotals.costUsd).toBeCloseTo(0.0020859999999999997, 9) // haiku only
    expect(spend.cumulativeTotals.costUsd).toBeCloseTo(0.4845594, 9)
  })

  it('leaves dollars unreported for an engine that does not report them', async () => {
    const dir = tempDir()
    writeTranscript(dir, [assistantTurn('2026-09-01T10:00:00Z'), costState()])
    const { watcher, ledger } = watcherRig(dir, { costs: false })

    await watcher.tick()

    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.cumulativeTotals.inTokens).toBe(1019)
    // Null, never zero: "not reported" and "free" are different claims.
    expect(spend.cumulativeTotals.costUsd).toBeNull()
  })

  it('records nothing for a session that was killed before it could report', async () => {
    const dir = tempDir()
    writeTranscript(dir, [assistantTurn('2026-09-01T10:00:00Z')])
    const { watcher, ledger } = watcherRig(dir)

    await watcher.tick()

    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.cumulativeTotals.inTokens).toBe(1019)
    expect(spend.cumulativeTotals.costUsd).toBeNull()
  })
})

describe('the live figure and the durable one, reconciled', () => {
  /** A ledger whose live-cost lookup the test drives. */
  function rig(live: { session: string; usd: number } | null) {
    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({
      store,
      now: () => new Date('2026-09-02T09:00:00Z'),
      liveCost: () => live
    })
    ledger.noteSession('agent.artemis', 'sess-1')
    return ledger
  }

  it('shows the live figure while the session is still running', () => {
    // The durable figure cannot exist yet: the engine writes cost-state when a
    // session ENDS. This is the whole gap the live reading closes.
    const ledger = rig({ session: 'sess-1', usd: 0.3 })
    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.sessionTotals.costUsd).toBeNull()
    expect(spend.liveSessionCostUsd).toBe(0.3)
    expect(sessionCostOf(spend)).toEqual({ usd: 0.3, from: 'live' })
  })

  it('never adds the two together', () => {
    // The moment a session ends, both sources describe the SAME spend. Summing
    // is the double-count this reconciliation exists to prevent.
    const ledger = rig({ session: 'sess-1', usd: 0.48 })
    ledger.foldCosts('agent.artemis', 'sess-1.jsonl', [
      { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.4845594, priced: true }
    ])
    const spend = ledger.spendFor('agent.artemis', null)
    const shown = sessionCostOf(spend)
    expect(shown.usd).toBeCloseTo(0.4845594, 9)
    // The ledger's is the larger and the final one, so it wins.
    expect(shown.from).toBe('ledger')
  })

  it('prefers whichever is larger, so a stale reading cannot under-report', () => {
    // The live file lags the transcript by up to a poll interval.
    const ledger = rig({ session: 'sess-1', usd: 0.2 })
    ledger.foldCosts('agent.artemis', 'sess-1.jsonl', [
      { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5, priced: true }
    ])
    expect(sessionCostOf(ledger.spendFor('agent.artemis', null))).toEqual({
      usd: 0.5,
      from: 'ledger'
    })
  })

  it('does not go backwards when the live reading disappears', () => {
    // The agent exited; its report went stale and liveCostFor returns null. The
    // figure must fall back to the durable one, not to nothing.
    const ledger = rig(null)
    ledger.foldCosts('agent.artemis', 'sess-1.jsonl', [
      { sessionId: 'sess-1', model: 'claude-sonnet-5', cumulativeUsd: 0.5, priced: true }
    ])
    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.liveSessionCostUsd).toBeNull()
    expect(sessionCostOf(spend)).toEqual({ usd: 0.5, from: 'ledger' })
  })

  it('ignores a live figure left behind by a DIFFERENT session', () => {
    // The same mis-attribution in miniature: the previous session's running
    // total must not be shown against this one.
    const ledger = rig({ session: 'sess-OLD', usd: 99 })
    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.liveSessionCostUsd).toBeNull()
    expect(sessionCostOf(spend)).toEqual({ usd: null, from: 'none' })
  })

  it('leaves the durable totals untouched by the live figure', () => {
    // today/cumulative are folds over the append-only ledger. A file reading
    // must never leak into them, or a restart would change history.
    const ledger = rig({ session: 'sess-1', usd: 0.3 })
    const spend = ledger.spendFor('agent.artemis', null)
    expect(spend.todayTotals.costUsd).toBeNull()
    expect(spend.cumulativeTotals.costUsd).toBeNull()
  })

  it('says "none" when neither source has anything', () => {
    const ledger = rig(null)
    expect(sessionCostOf(ledger.spendFor('agent.artemis', null))).toEqual({
      usd: null,
      from: 'none'
    })
  })
})
