import {
  recallPassages,
  recallTerms,
  scorePassage,
  snippetOf,
  type RecallHit,
  type RecallRung,
  type RecallSource
} from '../shared/recall'
import type { IndexableDoc, IndexSyncReport, RecallIndex } from './library'

/**
 * The **FTS rung** of the recall ladder (ADR-0006 layer 2's fallback: "degrade
 * to SQLite FTS keyword search, then to plain grep").
 *
 * The rung is split in two on purpose. Everything that decides *behaviour* —
 * the mtime gate, passage splitting, scope filtering, how a row becomes a hit —
 * lives here and is ordinary TypeScript. Only the storage sits behind
 * `FtsStore`, because the shipped store is SQLite and SQLite is Electron-ABI
 * after `electron-rebuild`, which vitest cannot load (BUILD-PROMPT §10.3).
 *
 * That is the same split `CostLedger`/`LedgerStore` already uses, for the same
 * reason and with the same honest limit: what the seam cannot prove is SQLite's
 * own behaviour. What it does prove is the ladder — which is the surface the
 * Architect named as the tested one.
 */

/** What the index remembers about a document, for the mtime gate. */
export interface FtsDocState {
  readonly ref: string
  readonly mtimeMs: number
  readonly size: number
}

/** One indexed passage. */
export interface FtsPassageRow {
  readonly ref: string
  readonly source: RecallSource
  readonly scope: string
  readonly title: string
  readonly body: string
}

/** A scored row coming back out of a store. */
export interface FtsSearchRow extends FtsPassageRow {
  readonly score: number
}

/** The storage half of the FTS rung. */
export interface FtsStore {
  /** Every document currently indexed, with the stat facts it was indexed at. */
  states(): readonly FtsDocState[]
  /** Replaces one document's passages and its state, atomically per document. */
  replace(state: FtsDocState, passages: readonly FtsPassageRow[]): void
  /** Forgets a document that has left the corpus. */
  remove(ref: string): void
  /**
   * Contract: rows matching at least one term, best-first, at most `limit`.
   * Ties break deterministically on `ref` then `title` — the known-answer smoke
   * test depends on a stable order.
   */
  search(terms: readonly string[], scope: string | null, limit: number): readonly FtsSearchRow[]
  close(): void
}

export interface FtsIndexOptions {
  /** The opened store, or null when this rung could not be brought up. */
  readonly store: FtsStore | null
  /** Why the store is null — shown to the Architect and the agent, never hidden. */
  readonly because?: string
}

export class FtsIndex implements RecallIndex {
  readonly rung: RecallRung = 'fts'

  constructor(private readonly options: FtsIndexOptions) {}

  available(): boolean {
    return this.options.store !== null
  }

  unavailableBecause(): string {
    return this.options.store === null ? (this.options.because ?? 'no keyword index') : 'available'
  }

  /**
   * The mtime gate (ADR-0006 "mtime-gated incremental mining").
   *
   * Contract: a document whose `mtimeMs` and `size` both match what the index
   * already holds is not re-mined. Both, not just mtime: an edit that preserves
   * the timestamp is rare but a truncation that preserves the size is rarer
   * still, and the pair costs nothing.
   */
  async sync(docs: readonly IndexableDoc[]): Promise<IndexSyncReport> {
    const store = this.options.store
    if (!store) return { mined: 0, skipped: 0, removed: 0 }

    const known = new Map(store.states().map((state) => [state.ref, state]))
    let mined = 0
    let skipped = 0
    for (const doc of docs) {
      const state = known.get(doc.ref)
      known.delete(doc.ref)
      if (state && state.mtimeMs === doc.mtimeMs && state.size === doc.size) {
        skipped += 1
        continue
      }
      store.replace(
        { ref: doc.ref, mtimeMs: doc.mtimeMs, size: doc.size },
        recallPassages(doc).map((passage) => ({
          ref: doc.ref,
          source: doc.source,
          scope: doc.scope,
          title: passage.title,
          body: passage.text
        }))
      )
      mined += 1
    }

    // Anything still in `known` has left the corpus — an archived agent's
    // directory, a shelf document the Architect withdrew. The index is derived
    // state and must not outlive its source (SDD §2).
    let removed = 0
    for (const ref of known.keys()) {
      store.remove(ref)
      removed += 1
    }
    return { mined, skipped, removed }
  }

  async search(
    query: string,
    scope: string | null,
    limit: number
  ): Promise<readonly RecallHit[] | null> {
    const store = this.options.store
    if (!store) return null
    const terms = recallTerms(query)
    if (terms.length === 0) return []
    return store.search(terms, scope, limit).map((row) => ({
      ref: row.ref,
      source: row.source,
      scope: row.scope,
      title: row.title,
      snippet: snippetOf(row.body, terms),
      score: row.score
    }))
  }
}

/**
 * An in-process `FtsStore`.
 *
 * It scores with the same `scorePassage` the grep rung uses, so the two rungs
 * agree on known-answer queries by construction rather than by coincidence —
 * which is what "green at every available rung" is supposed to mean.
 */
export class MemoryFtsStore implements FtsStore {
  private readonly docs = new Map<string, { state: FtsDocState; passages: FtsPassageRow[] }>()

  states(): readonly FtsDocState[] {
    return [...this.docs.values()].map((entry) => entry.state)
  }

  replace(state: FtsDocState, passages: readonly FtsPassageRow[]): void {
    this.docs.set(state.ref, { state, passages: [...passages] })
  }

  remove(ref: string): void {
    this.docs.delete(ref)
  }

  search(terms: readonly string[], scope: string | null, limit: number): readonly FtsSearchRow[] {
    const rows: FtsSearchRow[] = []
    for (const entry of this.docs.values()) {
      for (const passage of entry.passages) {
        if (scope !== null && passage.scope !== scope && passage.source !== scope) continue
        const score = scorePassage(passage.body, terms)
        if (score === 0) continue
        rows.push({ ...passage, score })
      }
    }
    return rows
      .sort(
        (a, b) => b.score - a.score || a.ref.localeCompare(b.ref) || a.title.localeCompare(b.title)
      )
      .slice(0, limit)
  }

  close(): void {
    this.docs.clear()
  }
}
