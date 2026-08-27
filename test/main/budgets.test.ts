import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSpend, BudgetVerdict } from '../../src/shared/cost'
import type { AgentSpawnConfig, EngineAdapter, UsageFact } from '../../src/main/engines'
import { BudgetWatcher, transcriptFiles, type BudgetedAgent } from '../../src/main/watch/budgets'
import { CostLedger, MemoryLedgerStore } from '../../src/main/watch/ledger'

/**
 * The budget watcher (ADR-0011, SDD §9) — the loop that turns transcripts into
 * ledger rows and a row into a verdict. Its arithmetic is asserted in
 * test/shared/cost.test.ts and its storage in test/main/ledger.test.ts; what
 * this file owns is the wiring in between, which is where an unproven rule
 * quietly stops running.
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-budgets-'))
  temps.push(dir)
  return dir
}

function fact(over: Partial<UsageFact> = {}): UsageFact {
  return {
    sessionId: 'sess-1',
    model: 'test-model',
    inTokens: 100,
    outTokens: 20,
    costUsd: null,
    at: null,
    ...over
  }
}

/** An adapter whose transcripts live in a directory the test controls. */
function adapterOver(dir: string, opts: { throws?: boolean; none?: boolean } = {}): EngineAdapter {
  const base = {
    id: 'fake' as const,
    hooks: 'native' as const,
    binary: () => {
      throw new Error('not used')
    },
    spawnArgs: () => {
      throw new Error('not used')
    },
    wireHooks: () => {
      throw new Error('not used')
    },
    injectIdentity: () => {},
    interrupt: () => ({ label: 'Escape', bytes: '' })
  }
  if (opts.none) return base as unknown as EngineAdapter
  return {
    ...base,
    transcripts: {
      transcriptDir: () => dir,
      read: async (filePath: string): Promise<readonly UsageFact[]> => {
        if (opts.throws) throw new Error('transcript unreadable')
        const raw = fs.readFileSync(filePath, 'utf8')
        return raw
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as UsageFact)
      }
    }
  } as unknown as EngineAdapter
}

function agent(over: Partial<BudgetedAgent> & { adapter: EngineAdapter }): BudgetedAgent {
  return {
    agentId: 'agent.mason',
    cfg: { cwd: '/repo' } as AgentSpawnConfig,
    dailyTokens: null,
    sessionIds: ['sess-1'],
    ...over
  }
}

function writeTranscript(dir: string, session: string, facts: readonly UsageFact[]): void {
  fs.writeFileSync(
    path.join(dir, `${session}.jsonl`),
    facts.map((f) => JSON.stringify(f)).join('\n') + '\n'
  )
}

interface Rig {
  readonly watcher: BudgetWatcher
  readonly ledger: CostLedger
  readonly changes: { agentId: string; verdict: BudgetVerdict; spend: AgentSpend }[]
  readonly degraded: string[]
}

function rig(agents: readonly BudgetedAgent[], now = (): Date => new Date(2026, 7, 27, 12)): Rig {
  const ledger = new CostLedger({ store: new MemoryLedgerStore(), now })
  const changes: Rig['changes'] = []
  const degraded: string[] = []
  const watcher = new BudgetWatcher({
    ledger,
    agents: () => agents,
    onBudgetChange: (agentId, verdict, spend) => changes.push({ agentId, verdict, spend }),
    onDegraded: (detail) => degraded.push(detail)
  })
  return { watcher, ledger, changes, degraded }
}

describe('transcriptFiles — only this spawn’s sessions', () => {
  it('returns the files the given sessions produced', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact()])
    writeTranscript(dir, 'sess-2', [fact()])
    const files = await transcriptFiles(dir, ['sess-1'])
    expect(files).toHaveLength(1)
    expect(files[0]?.endsWith('sess-1.jsonl')).toBe(true)
  })

  it('ignores a transcript belonging to nobody we know', async () => {
    const dir = tempDir()
    // The Architect's own claude history in the same repo. Folding it would
    // bill their personal sessions to an agent (ADR-0011 attribution).
    writeTranscript(dir, 'a-personal-session', [fact({ inTokens: 9_000_000 })])
    expect(await transcriptFiles(dir, ['sess-1'])).toEqual([])
  })

  it('returns nothing before any session is known', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact()])
    // Recording nothing until we know whose it is beats recording it as ours.
    expect(await transcriptFiles(dir, [])).toEqual([])
  })

  it('returns nothing for a directory that is not there', async () => {
    expect(await transcriptFiles(path.join(tempDir(), 'nope'), ['sess-1'])).toEqual([])
  })

  it('skips non-transcript files', async () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'sess-1.txt'), 'not a transcript')
    expect(await transcriptFiles(dir, ['sess-1'])).toEqual([])
  })
})

describe('the fold tick', () => {
  it('folds a spawn’s transcript into the ledger', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact(), fact({ outTokens: 5 })])
    const { watcher, ledger } = rig([agent({ adapter: adapterOver(dir) })])
    await watcher.tick()
    expect(ledger.spendFor('agent.mason', null).cumulativeTotals.rows).toBe(2)
  })

  it('does not double-count across ticks', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact()])
    const { watcher, ledger } = rig([agent({ adapter: adapterOver(dir) })])
    await watcher.tick()
    await watcher.tick()
    await watcher.tick()
    expect(ledger.spendFor('agent.mason', null).cumulativeTotals.rows).toBe(1)
  })

  it('keeps two agents sharing one repo apart', async () => {
    // FR-1.5 makes worktree isolation optional, so a shared cwd is the
    // documented default — and each agent must see only its own sessions.
    const dir = tempDir()
    writeTranscript(dir, 'sess-a', [fact({ sessionId: 'sess-a', inTokens: 10 })])
    writeTranscript(dir, 'sess-b', [fact({ sessionId: 'sess-b', inTokens: 700 })])
    const adapter = adapterOver(dir)
    const { watcher, ledger } = rig([
      agent({ agentId: 'agent.a', adapter, sessionIds: ['sess-a'] }),
      agent({ agentId: 'agent.b', adapter, sessionIds: ['sess-b'] })
    ])
    await watcher.tick()
    expect(ledger.spendFor('agent.a', null).cumulativeTotals.inTokens).toBe(10)
    expect(ledger.spendFor('agent.b', null).cumulativeTotals.inTokens).toBe(700)
  })

  it('reports a transcript it could not read instead of throwing', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact()])
    const { watcher, degraded } = rig([agent({ adapter: adapterOver(dir, { throws: true }) })])
    await expect(watcher.tick()).resolves.toBeUndefined()
    expect(degraded.join(' ')).toContain('transcript fold failed')
  })

  it('keeps folding the other agents after one fails', async () => {
    const good = tempDir()
    writeTranscript(good, 'sess-1', [fact()])
    const { watcher, ledger } = rig([
      agent({ agentId: 'agent.broken', adapter: adapterOver(tempDir(), { throws: true }) }),
      agent({ agentId: 'agent.fine', adapter: adapterOver(good) })
    ])
    await watcher.tick()
    expect(ledger.spendFor('agent.fine', null).cumulativeTotals.rows).toBe(1)
  })

  it('marks an engine with no transcript reader as reporting nothing', async () => {
    // A zero from an engine that cannot report must be distinguishable from an
    // agent that genuinely spent nothing (invariant §7).
    const { watcher, ledger } = rig([agent({ adapter: adapterOver(tempDir(), { none: true }) })])
    await watcher.tick()
    expect(ledger.spendFor('agent.mason', null, 'none').reporting).toBe('none')
  })
})

describe('budget events fire on transitions only (SDD §4.3 kind `budget`)', () => {
  it('says nothing at all while an agent is healthy', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact({ inTokens: 10, outTokens: 1 })])
    const { watcher, changes } = rig([agent({ adapter: adapterOver(dir), dailyTokens: 1_000_000 })])
    await watcher.tick()
    await watcher.tick()
    // A first sighting of `ok` is not news.
    expect(changes).toEqual([])
  })

  it('fires once when the budget breaks, not on every tick', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact({ inTokens: 900, outTokens: 200 })])
    const { watcher, changes } = rig([agent({ adapter: adapterOver(dir), dailyTokens: 1000 })])
    await watcher.tick()
    await watcher.tick()
    await watcher.tick()
    // A breached agent emitting every tick would turn the book of record into
    // a metronome, and the briefing that reads it would drown.
    expect(changes).toHaveLength(1)
    expect(changes[0]?.verdict.state).toBe('breached')
    expect(changes[0]?.agentId).toBe('agent.mason')
  })

  it('fires again when the state changes back', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact({ inTokens: 900, outTokens: 200 })])
    const live = agent({ adapter: adapterOver(dir), dailyTokens: 1000 })
    const store = new MemoryLedgerStore()
    const ledger = new CostLedger({ store, now: () => new Date(2026, 7, 27, 12) })
    const changes: string[] = []
    let budget: number | null = 1000
    const watcher = new BudgetWatcher({
      ledger,
      agents: () => [{ ...live, dailyTokens: budget }],
      onBudgetChange: (_id, verdict) => changes.push(verdict.state)
    })
    await watcher.tick()
    budget = 1_000_000
    await watcher.tick()
    expect(changes).toEqual(['breached', 'ok'])
  })

  it('re-reports after a respawn once the agent is forgotten', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact({ inTokens: 900, outTokens: 200 })])
    const { watcher, changes } = rig([agent({ adapter: adapterOver(dir), dailyTokens: 1000 })])
    await watcher.tick()
    expect(changes).toHaveLength(1)
    watcher.forget('agent.mason')
    await watcher.tick()
    expect(changes).toHaveLength(2)
  })
})

describe('the tick is safe to run repeatedly', () => {
  it('surfaces a failing agents source rather than crashing the timer', async () => {
    const ledger = new CostLedger({ store: new MemoryLedgerStore() })
    const degraded: string[] = []
    const watcher = new BudgetWatcher({
      ledger,
      agents: () => {
        throw new Error('roster exploded')
      },
      onDegraded: (detail) => degraded.push(detail)
    })
    // The timer path attaches a rejection handler — an unhandled rejection here
    // is the harness-killer class the M2 close-out audit closed.
    await expect(watcher.tick()).rejects.toThrow('roster exploded')
    watcher.start()
    watcher.stop()
    expect(degraded).toEqual([])
  })

  it('does not stack a second tick behind a slow one', async () => {
    const dir = tempDir()
    writeTranscript(dir, 'sess-1', [fact()])
    let reads = 0
    const slow = {
      transcriptDir: () => dir,
      read: async (): Promise<readonly UsageFact[]> => {
        reads += 1
        await new Promise((resolve) => setTimeout(resolve, 30))
        return [fact()]
      }
    }
    const adapter = { ...adapterOver(dir), transcripts: slow } as unknown as EngineAdapter
    const { watcher } = rig([agent({ adapter })])
    const first = watcher.tick()
    await watcher.tick()
    await first
    // The second call returned immediately rather than folding again.
    expect(reads).toBe(1)
  })
})
