import fs from 'node:fs'
import path from 'node:path'
import {
  grepRecall,
  inScope,
  RECALL_DEFAULT_LIMIT,
  RECALL_SCHEMA_VERSION,
  type RecallDoc,
  type RecallHit,
  type RecallResponse,
  type RecallRung
} from '../shared/recall'
import {
  composeMemoryEntry,
  memoryEntrySchema,
  parseMemorySections,
  selectMemoryForInjection,
  type MemoryEntry,
  type MemoryInjection,
  type MemorySection
} from '../shared/memory'
import { writeFileAtomic } from './fsx'
import type { PromptStore } from './prompts'

/**
 * The Library (SDD §1.1 `library.ts`, ADR-0006 / ADR-0016).
 *
 * M4.1 lands layer 1 — the markdown ground truth: `memory.md` per agent, seeded
 * at hire, appended to and never rewritten, and composed into the context a
 * spawn carries. Recall (layer 2) and reflection (layer 3) grow into this module
 * in M4.2–M4.4.
 *
 * Two rules shape every method here:
 *
 * - **Append-only, and atomic.** `memory.md` is read by a live agent process, so
 *   it is written temp+rename (invariant §3); and an append that lost the file's
 *   earlier bytes would destroy memory, which NFR-7 forbids outright. `append()`
 *   therefore re-reads and refuses rather than overwrite.
 * - **No schema at write time** (ADR-0006). The harness owns the dated heading
 *   and nothing else; the prose under it is the agent's, unvalidated, verbatim.
 */

/** SDD §2: `agora/agents/<id>/memory.md`. */
export const MEMORY_FILE = 'memory.md'
/** SDD §2: `agora/agents/<id>/memory-archive/` — reflection's output (M4.4). */
export const MEMORY_ARCHIVE_DIR = 'memory-archive'
/** SDD §2: `agora/knowledge/` — the Architect-registered shelf (FR-6.4). */
export const KNOWLEDGE_DIR = 'knowledge'

/**
 * One rung of the recall ladder, as an implementation.
 *
 * The FTS rung lives behind this seam because it is SQLite, and SQLite is
 * Electron-ABI after `electron-rebuild` — vitest cannot import it
 * (BUILD-PROMPT §10.3). The seam is also what ADR-0016 re-points at MemPalace
 * in M4.3 without the Library learning anything new.
 */
export interface RecallIndex {
  /** Which rung this is, for the state the UI shows. */
  readonly rung: RecallRung
  /**
   * Contract: whether this rung can answer right now. False is a normal,
   * *visible* state — a missing index degrades, it does not throw.
   */
  available(): boolean
  /** Why it cannot answer, when `available()` is false. */
  unavailableBecause(): string
  /**
   * Brings the index up to date with the corpus. Contract: mtime-gated —
   * a document whose `mtimeMs`/`size` are unchanged is not re-mined
   * (ADR-0006 "mtime-gated incremental mining").
   */
  sync(docs: readonly IndexableDoc[]): Promise<IndexSyncReport>
  /**
   * Contract: hits ordered best-first, or null when this rung just failed.
   *
   * Asynchronous because a rung may be a local subprocess (ADR-0016 drives
   * MemPalace as one). A semantic search takes seconds; doing it synchronously
   * would freeze the main process and, with it, every agent's terminal.
   */
  search(query: string, scope: string | null, limit: number): Promise<readonly RecallHit[] | null>
}

/** A corpus document plus the stat facts the mtime gate compares. */
export interface IndexableDoc extends RecallDoc {
  readonly mtimeMs: number
  readonly size: number
}

/** What one incremental sync actually did — the mtime gate, observable. */
export interface IndexSyncReport {
  readonly mined: number
  readonly skipped: number
  readonly removed: number
}

const SEED_PROMPT = path.join('library', 'memory-seed.md')
const LAYER_PROMPT = path.join('library', 'memory-layer.md')
const ELIDED_PROMPT = path.join('library', 'memory-elided.md')

export interface LibraryOptions {
  /** `<harness home>/agora` — the same root `AgentManager` writes identities in. */
  readonly agoraRoot: string
  readonly prompts: PromptStore
  /**
   * Reported when a memory file will not read or an append had to be refused.
   * Invariant §7: a memory the harness silently gave up on is the failure mode
   * this project treats as unforgivable — the caller surfaces this.
   */
  onDegraded?(detail: string): void
  /**
   * The rungs above grep, best first. Absent or unavailable rungs are stepped
   * over *visibly*; grep is implemented here and can never be unavailable, so
   * the ladder always has a bottom (ADR-0006's transparency floor).
   */
  readonly indexes?: readonly RecallIndex[]
  now?(): Date
}

/** What one composed memory layer carries, for the log and the agent card. */
export interface MemoryLayer {
  /** Ready to inject; empty string when the agent has written nothing yet. */
  readonly text: string
  readonly facts: MemoryInjection
}

export class Library {
  private readonly now: () => Date

  constructor(private readonly options: LibraryOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** `agora/agents/<id>` — the agent's own directory (SDD §2). */
  agentDir(agentId: string): string {
    return path.join(this.options.agoraRoot, 'agents', agentId)
  }

  memoryPath(agentId: string): string {
    return path.join(this.agentDir(agentId), MEMORY_FILE)
  }

  archiveDir(agentId: string): string {
    return path.join(this.agentDir(agentId), MEMORY_ARCHIVE_DIR)
  }

  /**
   * Writes the seed header for an agent that has no memory yet (FR-6.1, "seeded
   * at hire").
   *
   * Contract: never touches an existing file. Returns whether it wrote — a hire
   * that already remembers something is the normal case on every respawn, and
   * re-seeding it would be the one thing this module must never do.
   */
  seed(agentId: string): boolean {
    const file = this.memoryPath(agentId)
    if (fs.existsSync(file)) return false
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // The archive directory exists from the start so reflection (M4.4) never has
    // to decide whether an absent directory means "nothing archived" or "broken".
    fs.mkdirSync(this.archiveDir(agentId), { recursive: true })
    writeFileAtomic(file, `${this.options.prompts.render(SEED_PROMPT, { agentId }).trim()}\n`)
    return true
  }

  /** The memory file verbatim, or `''` when the agent has none. */
  read(agentId: string): string {
    const file = this.memoryPath(agentId)
    try {
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    } catch (err) {
      this.options.onDegraded?.(`memory.md for ${agentId} unreadable — ${reason(err)}`)
      return ''
    }
  }

  /** Read-time structure (ADR-0006) — never imposed on the writer. */
  sections(agentId: string): readonly MemorySection[] {
    return parseMemorySections(this.read(agentId))
  }

  /**
   * Appends one dated section.
   *
   * Contract: the file's previous bytes are a strict prefix of the new file, or
   * nothing is written. Both the harness and the agent's own process append
   * here, so the check is not paranoia — it is the only thing standing between
   * a racing writer and a destroyed memory (NFR-7).
   */
  append(agentId: string, entry: MemoryEntry): void {
    const parsed = memoryEntrySchema.safeParse(entry)
    if (!parsed.success) {
      throw new Error(`library: malformed memory entry for ${agentId} — ${parsed.error.message}`)
    }
    this.seed(agentId)
    const file = this.memoryPath(agentId)
    const before = this.read(agentId)
    const next = `${before.replace(/\s+$/, '')}\n${composeMemoryEntry(parsed.data)}`
    if (!next.startsWith(before.replace(/\s+$/, ''))) {
      // Unreachable by construction; asserted anyway, because "append-only" is a
      // claim this file makes to the rest of the system.
      throw new Error(`library: refusing a non-append write to ${file}`)
    }
    writeFileAtomic(file, next)
  }

  /** Convenience for harness-authored notes (crash notices, archive markers). */
  note(agentId: string, author: string, body: string): void {
    this.append(agentId, { at: this.now().toISOString(), author, body })
  }

  /**
   * The memory layer of a spawn's context (FR-6.1).
   *
   * Contract: `''` when the agent has written nothing beyond the seed, so a
   * brand-new hire carries no empty heading. When the budget bites, the notice
   * says so *to the agent* — a silently truncated memory would leave it
   * confidently wrong about what it knows (invariant §7).
   */
  layer(agentId: string): MemoryLayer {
    const facts = selectMemoryForInjection(this.read(agentId))
    if (facts.text.length === 0) return { text: '', facts }
    const notice = facts.truncated
      ? `\n${this.options.prompts
          .render(ELIDED_PROMPT, {
            included: String(facts.includedSections),
            total: String(facts.totalSections)
          })
          .trim()}\n`
      : ''
    return {
      text: this.options.prompts.render(LAYER_PROMPT, { memory: facts.text, notice }).trim(),
      facts
    }
  }

  /** `agora/knowledge` — the shelf the Architect registers docs into (FR-6.4). */
  knowledgeDir(): string {
    return path.join(this.options.agoraRoot, KNOWLEDGE_DIR)
  }

  /**
   * Everything the company knows, as documents (ADR-0006 layers 1–2): every
   * agent's `memory.md`, everything reflection has archived, and the knowledge
   * shelf. Deterministic order, because every rung is fed from here and the
   * smoke test's known answers depend on it.
   *
   * Contract: never throws. A directory that will not list contributes nothing
   * and is reported — "the company knows nothing" and "we cannot read what the
   * company knows" are different facts (invariant §7).
   */
  corpus(): readonly IndexableDoc[] {
    const docs: IndexableDoc[] = []
    const add = (file: string, source: RecallDoc['source'], scope: string): void => {
      const text = readOrNull(file)
      if (text === null) {
        this.options.onDegraded?.(`recall: ${file} unreadable`)
        return
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        return
      }
      docs.push({ ref: file, source, scope, text, mtimeMs: stat.mtimeMs, size: stat.size })
    }

    const agentsRoot = path.join(this.options.agoraRoot, 'agents')
    // No agents directory yet: a company before its first hire knows nothing,
    // which is a true answer and not a degradation.
    let agentIds: readonly string[]
    try {
      agentIds = fs
        .readdirSync(agentsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch {
      agentIds = []
    }
    for (const agentId of agentIds) {
      const memory = this.memoryPath(agentId)
      if (fs.existsSync(memory)) add(memory, 'memory', agentId)
      for (const file of listFiles(this.archiveDir(agentId))) add(file, 'archive', agentId)
    }
    for (const file of listFiles(this.knowledgeDir())) {
      add(file, 'knowledge', path.basename(file, '.md'))
    }
    return docs
  }

  /**
   * Brings every configured index up to date, mtime-gated.
   *
   * Contract: returns each rung's report. An index that throws while syncing is
   * reported and stepped over — a broken index must cost recall its quality,
   * never its availability (SDD §10 "recall index corrupt → delete + rebuild").
   */
  async reindex(): Promise<ReadonlyMap<RecallRung, IndexSyncReport>> {
    const docs = this.corpus()
    const reports = new Map<RecallRung, IndexSyncReport>()
    for (const index of this.options.indexes ?? []) {
      if (!index.available()) continue
      try {
        reports.set(index.rung, await index.sync(docs))
      } catch (err) {
        this.options.onDegraded?.(`recall: ${index.rung} index sync failed — ${reason(err)}`)
      }
    }
    return reports
  }

  /**
   * The rung recall would answer on right now, and why it is not higher.
   *
   * This is the state the Memory panel shows and `agora:health` reports. It is
   * computed rather than remembered, so it can never claim a rung that has since
   * gone away.
   */
  rung(): { readonly rung: RecallRung; readonly degraded: string | null } {
    const reasons: string[] = []
    for (const index of this.options.indexes ?? []) {
      if (index.available()) {
        return { rung: index.rung, degraded: reasons.length === 0 ? null : reasons.join('; ') }
      }
      reasons.push(`${index.rung}: ${index.unavailableBecause()}`)
    }
    return {
      rung: 'grep',
      // Grep is the floor, and reaching it with no reason recorded would be the
      // silent fallback this codebase treats as unforgivable.
      degraded:
        reasons.length === 0
          ? 'no recall index configured — keyword search over markdown'
          : reasons.join('; ')
    }
  }

  /**
   * Answers one recall query on the best rung that will answer it.
   *
   * Contract: always answers. Every rung above grep may be absent, broken or
   * simply fail this query; grep is computed here from the markdown itself and
   * has nothing left to fall back to. The response says which rung answered and
   * why it was not a higher one — an agent that got the keyword answer has to
   * know it did not get the semantic one.
   */
  async recall(
    query: string,
    scope: string | null = null,
    limit = RECALL_DEFAULT_LIMIT
  ): Promise<RecallResponse> {
    const stepped: string[] = []
    for (const index of this.options.indexes ?? []) {
      if (!index.available()) {
        stepped.push(`${index.rung}: ${index.unavailableBecause()}`)
        continue
      }
      let hits: readonly RecallHit[] | null
      try {
        hits = await index.search(query, scope, limit)
      } catch (err) {
        hits = null
        this.options.onDegraded?.(`recall: ${index.rung} search failed — ${reason(err)}`)
      }
      if (hits === null) {
        stepped.push(`${index.rung}: search failed`)
        continue
      }
      return {
        schemaVersion: RECALL_SCHEMA_VERSION,
        query,
        rung: index.rung,
        hits: [...hits],
        degraded: stepped.length === 0 ? null : stepped.join('; ')
      }
    }

    const docs = this.corpus().filter((doc) => inScope(doc, scope))
    return {
      schemaVersion: RECALL_SCHEMA_VERSION,
      query,
      rung: 'grep',
      hits: [...grepRecall(docs, query, limit)],
      degraded:
        stepped.length === 0
          ? 'no recall index configured — keyword search over markdown'
          : stepped.join('; ')
    }
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Reads a file, or null when it will not read. Never throws. */
function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function listFiles(dir: string): readonly string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}
