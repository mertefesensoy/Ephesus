import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Library, type RecallIndex } from '../../src/main/library'
import { FtsIndex, MemoryFtsStore } from '../../src/main/library-fts'
import { MemPalaceIndex } from '../../src/main/library-mempalace'
import { PromptStore } from '../../src/main/prompts'
import { RECALL_RUNGS, type RecallRung } from '../../src/shared/recall'

/**
 * **The recall smoke test** (ADR-0006's "conformance suite includes a retrieval
 * smoke test with known-answer queries"; IMPLEMENTATION M4 exit).
 *
 * One fixture corpus, one set of known-answer queries, run against **every rung
 * the machine can actually offer**. The grep rung is always available — it is
 * ADR-0006's transparency floor and has no index, no native module and no
 * subprocess. The FTS rung runs behind its in-process store. The MemPalace rung
 * runs only where a real `mempalace` is installed, and when it is not, this
 * suite says so out loud rather than passing quietly: an optional external that
 * silently skipped its own smoke test would be exactly the invisible
 * degradation invariant §7 forbids.
 *
 * Point `EPH_MEMPALACE` at a real binary to include the top rung:
 *   EPH_MEMPALACE=/path/to/mempalace npx vitest run test/conformance/recall-smoke.test.ts
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const MEMPALACE = process.env['EPH_MEMPALACE'] ?? ''
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * The known answers. Each query names something exactly one document in the
 * fixture corpus says, phrased the way a colleague would ask — so a rung that
 * answers is genuinely retrieving, not pattern-matching a title.
 */
const KNOWN: readonly {
  readonly query: string
  readonly scope: string | null
  readonly expect: string
  /** Rungs that must answer this. Keyword rungs cannot answer a paraphrase. */
  readonly rungs: readonly RecallRung[]
}[] = [
  {
    query: 'flaky checkout fixture',
    scope: null,
    expect: 'seeds two carts',
    rungs: [...RECALL_RUNGS]
  },
  {
    query: 'staging resets',
    scope: 'agent.mason',
    expect: '03:00 UTC',
    rungs: [...RECALL_RUNGS]
  },
  {
    query: 'promote production',
    scope: 'knowledge',
    expect: 'promote staging',
    rungs: [...RECALL_RUNGS]
  },
  {
    query: 'billing endpoint retired',
    scope: null,
    expect: 'retired in July',
    rungs: [...RECALL_RUNGS]
  },
  {
    query: 'deploy pipeline smoke',
    scope: 'agent.iris',
    expect: 'smoke test',
    rungs: [...RECALL_RUNGS]
  }
]

/** Something the company genuinely does not know; every rung must say nothing. */
const UNKNOWN = 'kubernetes helm chart rollout'

function seed(library: Library, agoraRoot: string): void {
  library.note(
    'agent.mason',
    'agent.mason',
    'The checkout suite is flaky because the fixture seeds two carts.'
  )
  library.note('agent.mason', 'agent.mason', 'Staging resets at 03:00 UTC every night.')
  library.note('agent.iris', 'agent.iris', 'The deploy pipeline needs a staging smoke test.')
  fs.mkdirSync(path.join(agoraRoot, 'agents', 'agent.mason', 'memory-archive'), {
    recursive: true
  })
  fs.writeFileSync(
    path.join(agoraRoot, 'agents', 'agent.mason', 'memory-archive', '2026-08-01-001.md'),
    '## 2026-08-01 — agent.mason\n\nThe old billing endpoint was retired in July.\n',
    'utf8'
  )
  fs.mkdirSync(path.join(agoraRoot, 'knowledge'), { recursive: true })
  fs.writeFileSync(
    path.join(agoraRoot, 'knowledge', 'release-runbook.md'),
    '# Release runbook\n\nTag the commit, wait for CI, then promote staging to production.\n',
    'utf8'
  )
}

function libraryWith(indexes: readonly RecallIndex[]): Library {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-recall-smoke-'))
  temps.push(home)
  const agoraRoot = path.join(home, 'agora')
  const library = new Library({
    agoraRoot,
    prompts: new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts')),
    indexes
  })
  seed(library, agoraRoot)
  return library
}

/** Whether a real MemPalace is reachable — decided by running it, not assumed. */
async function mempalaceAvailable(): Promise<boolean> {
  if (MEMPALACE.length === 0) return false
  return new Promise((resolve) => {
    execFile(MEMPALACE, ['--version'], { timeout: 20_000 }, (err, stdout) =>
      resolve(err === null && /MemPalace/i.test(String(stdout)))
    )
  })
}

describe('recall smoke — the grep rung (ADR-0006 transparency floor)', () => {
  runRung('grep', () => libraryWith([]))
})

describe('recall smoke — the fts rung', () => {
  runRung('fts', () => libraryWith([new FtsIndex({ store: new MemoryFtsStore() })]))
})

describe('recall smoke — the mempalace rung', () => {
  it('is reported when it cannot run here, and fails loudly when misconfigured', async () => {
    const available = await mempalaceAvailable()
    if (MEMPALACE.length > 0) {
      // EPH_MEMPALACE names a binary, so the rung MUST work: a configured-but-
      // broken MemPalace passing silently would be the invisible degradation
      // invariant §7 forbids. (The M4 close-out audit found the old assertion
      // here was a tautology that could never fail.)
      expect(available).toBe(true)
      return
    }
    // Optional external absent (ADR-0016 §6): the untested top rung is visible
    // as this suite's skip count, and the absence is asserted, not assumed.
    expect(available).toBe(false)
  })

  it.runIf(MEMPALACE.length > 0)(
    'answers every known-answer query',
    async () => {
      if (!(await mempalaceAvailable())) return
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-recall-smoke-mp-'))
      temps.push(home)
      const agoraRoot = path.join(home, 'agora')
      const palace = new MemPalaceIndex({
        palaceRoot: path.join(home, 'index'),
        agoraRoot,
        command: MEMPALACE
      })
      const library = new Library({
        agoraRoot,
        prompts: new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts')),
        indexes: [palace]
      })
      seed(library, agoraRoot)
      await palace.probe()
      expect(palace.available()).toBe(true)
      await library.reindex()

      for (const item of KNOWN) {
        const answer = await library.recall(item.query, item.scope, 5)
        expect(answer.rung, `"${item.query}" should be answered on mempalace`).toBe('mempalace')
        expect(
          answer.hits.map((hit) => hit.snippet).join('\n'),
          `"${item.query}" should recall "${item.expect}"`
        ).toContain(item.expect)
      }
    },
    600_000
  )
})

function runRung(rung: RecallRung, make: () => Library): void {
  for (const item of KNOWN.filter((known) => known.rungs.includes(rung))) {
    it(`"${item.query}" recalls "${item.expect}"`, async () => {
      const library = make()
      await library.reindex()
      const answer = await library.recall(item.query, item.scope, 5)

      expect(answer.rung).toBe(rung)
      expect(answer.hits.length).toBeGreaterThan(0)
      expect(answer.hits.map((hit) => hit.snippet).join('\n')).toContain(item.expect)
      // A scoped query never leaks out of its scope.
      if (item.scope !== null) {
        expect(
          answer.hits.every((hit) => hit.scope === item.scope || hit.source === item.scope)
        ).toBe(true)
      }
    })
  }

  it('answers nothing for something the company does not know', async () => {
    const library = make()
    await library.reindex()
    const answer = await library.recall(UNKNOWN, null, 5)
    expect(answer.rung).toBe(rung)
    expect(answer.hits).toEqual([])
  })

  it('says which rung answered, and why it is not a higher one', async () => {
    const library = make()
    await library.reindex()
    const answer = await library.recall(KNOWN[0]?.query ?? 'flaky', null, 5)
    expect(RECALL_RUNGS).toContain(answer.rung)
    // The floor rung must always carry a reason; a higher one may carry none.
    if (answer.rung === 'grep') expect(answer.degraded).not.toBeNull()
  })
}
