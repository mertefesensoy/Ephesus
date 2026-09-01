import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Library,
  type IndexSyncReport,
  type IndexableDoc,
  type RecallIndex
} from '../../src/main/library'
import { FtsIndex, MemoryFtsStore } from '../../src/main/library-fts'
import { PromptStore } from '../../src/main/prompts'
import type { RecallHit, RecallRung } from '../../src/shared/recall'
import { removeTempDir } from '../tmpdir'

/**
 * The recall ladder (ADR-0006 layer 2, ADR-0016 §5) against a real corpus on a
 * real filesystem.
 *
 * The suite's shape follows the Architect's directive that **the ladder is the
 * tested surface**: the same known-answer queries are asked on every rung that
 * can run here, and every step down the ladder has to be visible in the answer.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function rig(options: { indexes?: readonly RecallIndex[] } = {}): {
  library: Library
  agoraRoot: string
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-recall-'))
  temps.push(root)
  const agoraRoot = path.join(root, 'agora')
  const prompts = new PromptStore(path.join(root, 'prompts'), path.join(REPO, 'prompts'))
  const library = new Library({
    agoraRoot,
    prompts,
    ...(options.indexes ? { indexes: options.indexes } : {})
  })
  return { library, agoraRoot }
}

/** The corpus every known-answer query below is asked against. */
function seedCorpus(library: Library, agoraRoot: string): void {
  library.note(
    'agent.mason',
    'agent.mason',
    'The checkout suite is flaky because the fixture seeds two carts.'
  )
  library.note('agent.mason', 'agent.mason', 'Staging resets at 03:00 UTC.')
  library.note('agent.iris', 'agent.iris', 'The deploy pipeline needs a staging smoke test.')
  fs.mkdirSync(path.join(agoraRoot, 'agents', 'agent.mason', 'memory-archive'), {
    recursive: true
  })
  fs.writeFileSync(
    path.join(agoraRoot, 'agents', 'agent.mason', 'memory-archive', '2026-08-01.md'),
    '## 2026-08-01 — agent.mason\n\nThe old billing endpoint was retired in July.\n',
    'utf8'
  )
  fs.mkdirSync(path.join(agoraRoot, 'knowledge'), { recursive: true })
  fs.writeFileSync(
    path.join(agoraRoot, 'knowledge', 'release-runbook.md'),
    '# Release runbook\n\nTag, wait for CI, then promote staging to production.\n',
    'utf8'
  )
}

/** A rung that is present but refuses to answer — the "broken index" case. */
function brokenIndex(rung: RecallRung, because: string): RecallIndex {
  return {
    rung,
    available: () => true,
    unavailableBecause: () => because,
    sync: (): Promise<IndexSyncReport> => Promise.resolve({ mined: 0, skipped: 0, removed: 0 }),
    search: (): Promise<readonly RecallHit[] | null> => Promise.resolve(null)
  }
}

describe('Library.corpus', () => {
  it('gathers memory, archive and the knowledge shelf, in a stable order', async () => {
    const { library, agoraRoot } = rig()
    seedCorpus(library, agoraRoot)
    const corpus = library.corpus()
    // Agents in id order, each agent's live memory before its archive, the
    // shelf last — a fixed walk, so every rung is fed the same corpus.
    expect(corpus.map((doc) => doc.source)).toEqual(['memory', 'memory', 'archive', 'knowledge'])
    expect(corpus.map((doc) => doc.scope)).toEqual([
      'agent.iris',
      'agent.mason',
      'agent.mason',
      'release-runbook'
    ])
    expect(library.corpus().map((doc) => doc.ref)).toEqual(corpus.map((doc) => doc.ref))
  })

  it('answers nothing — not an error — for a company with no agents yet', async () => {
    const { library } = rig()
    expect(library.corpus()).toEqual([])
  })

  it('carries the stat facts the mtime gate compares', async () => {
    const { library, agoraRoot } = rig()
    seedCorpus(library, agoraRoot)
    for (const doc of library.corpus()) {
      expect(doc.size).toBeGreaterThan(0)
      expect(doc.mtimeMs).toBeGreaterThan(0)
    }
  })
})

describe('the ladder is visible at every rung (invariant §7)', () => {
  it('answers on grep with a reason when no index is configured', async () => {
    const { library, agoraRoot } = rig()
    seedCorpus(library, agoraRoot)
    expect(library.rung()).toEqual({
      rung: 'grep',
      degraded: 'no recall index configured — keyword search over markdown'
    })
    const answer = await library.recall('flaky checkout')
    expect(answer.rung).toBe('grep')
    expect(answer.degraded).toBe('no recall index configured — keyword search over markdown')
  })

  it('answers on fts, with nothing to report, when the index is up', async () => {
    const fts = new FtsIndex({ store: new MemoryFtsStore() })
    const { library, agoraRoot } = rig({ indexes: [fts] })
    seedCorpus(library, agoraRoot)
    await library.reindex()
    expect(library.rung()).toEqual({ rung: 'fts', degraded: null })
    expect((await library.recall('flaky checkout')).degraded).toBeNull()
  })

  it('names the rung it could not use when an index is absent', async () => {
    const absent = new FtsIndex({ store: null, because: 'no python' })
    const { library, agoraRoot } = rig({ indexes: [absent] })
    seedCorpus(library, agoraRoot)
    const answer = await library.recall('flaky checkout')
    expect(answer.rung).toBe('grep')
    expect(answer.degraded).toBe('fts: no python')
    expect(library.rung().degraded).toBe('fts: no python')
  })

  it('steps past a rung that is up but fails the query, and says which', async () => {
    const { library, agoraRoot } = rig({
      indexes: [brokenIndex('mempalace', 'up'), new FtsIndex({ store: new MemoryFtsStore() })]
    })
    seedCorpus(library, agoraRoot)
    await library.reindex()
    const answer = await library.recall('flaky checkout')
    expect(answer.rung).toBe('fts')
    expect(answer.degraded).toBe('mempalace: search failed')
    expect(answer.hits.length).toBeGreaterThan(0)
  })

  it('reaches grep even when every rung above it is broken — the floor holds', async () => {
    const { library, agoraRoot } = rig({
      indexes: [brokenIndex('mempalace', 'up'), brokenIndex('fts', 'up')]
    })
    seedCorpus(library, agoraRoot)
    const answer = await library.recall('flaky checkout')
    expect(answer.rung).toBe('grep')
    expect(answer.degraded).toBe('mempalace: search failed; fts: search failed')
    expect(answer.hits[0]?.snippet).toContain('two carts')
  })
})

describe('known-answer queries, on every rung available here', () => {
  const rungs: readonly { name: string; indexes: readonly RecallIndex[] }[] = [
    { name: 'grep', indexes: [] },
    { name: 'fts', indexes: [new FtsIndex({ store: new MemoryFtsStore() })] }
  ]

  for (const { name, indexes } of rungs) {
    describe(name, () => {
      const known: readonly { query: string; scope: string | null; expect: string }[] = [
        { query: 'flaky checkout fixture', scope: null, expect: 'two carts' },
        { query: 'staging resets', scope: 'agent.mason', expect: '03:00 UTC' },
        { query: 'deploy pipeline smoke', scope: null, expect: 'smoke test' },
        { query: 'promote production', scope: 'knowledge', expect: 'promote staging' },
        { query: 'billing endpoint retired', scope: null, expect: 'retired in July' }
      ]

      for (const item of known) {
        it(`"${item.query}" finds "${item.expect}"`, async () => {
          const { library, agoraRoot } = rig({ indexes })
          seedCorpus(library, agoraRoot)
          await library.reindex()
          const answer = await library.recall(item.query, item.scope)
          expect(answer.rung).toBe(name)
          expect(answer.hits.length).toBeGreaterThan(0)
          expect(answer.hits.map((hit) => hit.snippet).join('\n')).toContain(item.expect)
        })
      }

      it('answers nothing for something the company does not know', async () => {
        const { library, agoraRoot } = rig({ indexes })
        seedCorpus(library, agoraRoot)
        await library.reindex()
        expect((await library.recall('kubernetes helm chart')).hits).toEqual([])
      })

      it('keeps a scoped query inside its scope', async () => {
        const { library, agoraRoot } = rig({ indexes })
        seedCorpus(library, agoraRoot)
        await library.reindex()
        const answer = await library.recall('staging', 'agent.iris')
        expect(answer.hits.length).toBeGreaterThan(0)
        expect(answer.hits.every((hit) => hit.scope === 'agent.iris')).toBe(true)
      })
    })
  }
})

describe('mtime-gated incremental indexing (ADR-0006)', () => {
  it('mines every document once, then nothing until one changes', async () => {
    const fts = new FtsIndex({ store: new MemoryFtsStore() })
    const { library, agoraRoot } = rig({ indexes: [fts] })
    seedCorpus(library, agoraRoot)

    const first = (await library.reindex()).get('fts')
    expect(first).toEqual({ mined: 4, skipped: 0, removed: 0 })

    const second = (await library.reindex()).get('fts')
    expect(second).toEqual({ mined: 0, skipped: 4, removed: 0 })
  })

  it('re-mines exactly the document that changed', async () => {
    const fts = new FtsIndex({ store: new MemoryFtsStore() })
    const { library, agoraRoot } = rig({ indexes: [fts] })
    seedCorpus(library, agoraRoot)
    await library.reindex()

    library.note('agent.iris', 'agent.iris', 'The smoke test now runs against a seeded database.')
    const report = (await library.reindex()).get('fts')
    expect(report).toEqual({ mined: 1, skipped: 3, removed: 0 })
    expect((await library.recall('seeded database')).hits[0]?.scope).toBe('agent.iris')
  })

  it('forgets a document that has left the corpus — the index is derived state', async () => {
    const fts = new FtsIndex({ store: new MemoryFtsStore() })
    const { library, agoraRoot } = rig({ indexes: [fts] })
    seedCorpus(library, agoraRoot)
    await library.reindex()

    fs.rmSync(path.join(agoraRoot, 'knowledge', 'release-runbook.md'))
    expect((await library.reindex()).get('fts')).toEqual({ mined: 0, skipped: 3, removed: 1 })
    expect((await library.recall('promote production')).hits).toEqual([])
  })

  it('does not sync a rung that is not available', async () => {
    const absent = new FtsIndex({ store: null, because: 'no index' })
    const { library, agoraRoot } = rig({ indexes: [absent] })
    seedCorpus(library, agoraRoot)
    expect((await library.reindex()).size).toBe(0)
  })
})

describe('FtsIndex.search', () => {
  it('finds nothing to search for in a query of pure punctuation', async () => {
    const fts = new FtsIndex({ store: new MemoryFtsStore() })
    expect(await fts.search('?!', null, 5)).toEqual([])
  })

  it('reports itself unavailable, with a reason, when it has no store', async () => {
    const fts = new FtsIndex({ store: null, because: 'FTS5 not compiled in' })
    expect(fts.available()).toBe(false)
    expect(fts.unavailableBecause()).toBe('FTS5 not compiled in')
    expect(await fts.search('anything', null, 5)).toBeNull()
    expect(await fts.sync([] as readonly IndexableDoc[])).toEqual({
      mined: 0,
      skipped: 0,
      removed: 0
    })
  })
})
