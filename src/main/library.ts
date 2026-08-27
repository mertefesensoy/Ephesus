import fs from 'node:fs'
import path from 'node:path'
import type { KnowledgeDoc, MemoryView } from '../shared/memory'
import {
  archiveFileName,
  nothingDestroyed,
  planReflection,
  type ReflectionPlan
} from '../shared/reflection'
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
const CONDENSED_PROMPT = path.join('library', 'memory-condensed.md')
const ARCHIVE_HEADER_PROMPT = path.join('library', 'memory-archive-header.md')
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
  /** Reflection's size threshold and keep count (ADR-0006 layer 3); test seams. */
  readonly reflection?: { readonly threshold?: number; readonly keep?: number }
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

  /**
   * A shelf document's path. Contract: refuses a name that is not a plain file
   * name — the shelf is a flat directory inside the Agora, and a name with a
   * separator or a `..` in it would let a register call write anywhere the
   * harness can reach.
   */
  knowledgePath(name: string): string {
    const base = name.endsWith('.md') ? name : `${name}.md`
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(base) || base.includes('..')) {
      throw new Error(`library: "${name}" is not a legal knowledge document name`)
    }
    return path.join(this.knowledgeDir(), base)
  }

  /** The shelf, as the Memory panel and the corpus see it (FR-6.4). */
  knowledge(): readonly KnowledgeDoc[] {
    return listFiles(this.knowledgeDir()).map((file) => {
      let bytes: number
      try {
        bytes = fs.statSync(file).size
      } catch {
        bytes = 0
      }
      return { name: path.basename(file), bytes, text: readOrNull(file) ?? '' }
    })
  }

  /**
   * Registers one reference document on the shelf (FR-6.4).
   *
   * Contract: writes the file atomically and returns its path; **committing is
   * the caller's**, through the single committer (ADR-0004). This module never
   * runs git, and the Agora's queue owns the retries.
   */
  registerKnowledge(name: string, text: string): string {
    const file = this.knowledgePath(name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeFileAtomic(file, text.endsWith('\n') ? text : `${text}\n`)
    return file
  }

  /**
   * Everything the Memory panel shows for one agent (SDD §5 `agora.memory(id)`).
   *
   * Assembled here rather than in the renderer because the renderer is a
   * projection (invariant §2): it renders this and holds no memory state of
   * its own.
   */
  memoryView(agentId: string): MemoryView {
    const plan = this.reflectionPlan(agentId)
    return {
      agentId,
      path: this.memoryPath(agentId),
      text: this.read(agentId),
      sections: this.sections(agentId).length,
      archive: this.archiveFiles(agentId).map((name) => ({
        name,
        text: readOrNull(path.join(this.archiveDir(agentId), name)) ?? ''
      })),
      reflection: { due: plan.due, because: plan.because, chars: plan.chars }
    }
  }

  /**
   * What reflection would do to this agent's memory right now (ADR-0006 layer
   * 3). Pure and inspectable — the scheduler asks every tick.
   */
  reflectionPlan(agentId: string): ReflectionPlan {
    return planReflection(this.read(agentId), this.options.reflection ?? {})
  }

  /** Dated archive files, newest last (SDD §2 `memory-archive/`). */
  archiveFiles(agentId: string): readonly string[] {
    try {
      return fs
        .readdirSync(this.archiveDir(agentId))
        .filter((name) => name.endsWith('.md'))
        .sort()
    } catch {
      return []
    }
  }

  /** Every archived section, for the "nothing was destroyed" check and the UI. */
  archiveText(agentId: string): string {
    return this.archiveFiles(agentId)
      .map((name) => readOrNull(path.join(this.archiveDir(agentId), name)) ?? '')
      .join('\n')
  }

  /**
   * Applies one condensation: the archive is written first, then `memory.md` is
   * rewritten as preamble + core + the kept sections.
   *
   * **This is the one method allowed to rewrite `memory.md`**, and it is allowed
   * only because nothing is lost: ADR-0006 layer 3 is "a compact core + dated
   * archive of what was condensed", and NFR-7's "nothing is destroyed" is
   * *checked here*, not assumed — the archive is a verbatim copy, and
   * `nothingDestroyed` verifies every old section survives before the new
   * memory is committed. A failed check writes nothing and throws.
   *
   * Order matters: archive first. A crash between the two writes leaves a
   * duplicated section, which is recoverable; the other order loses one.
   */
  condense(
    agentId: string,
    core: string,
    at: Date = this.now()
  ): { readonly archive: string; readonly condensed: number } {
    const plan = this.reflectionPlan(agentId)
    if (!plan.due) {
      throw new Error(`library: ${agentId} has nothing to condense — ${plan.because}`)
    }
    const before = this.read(agentId)

    let seq = this.archiveFiles(agentId).filter((name) =>
      name.startsWith(at.toISOString().slice(0, 10))
    ).length
    let archiveName = archiveFileName(at, seq + 1)
    while (fs.existsSync(path.join(this.archiveDir(agentId), archiveName))) {
      seq += 1
      archiveName = archiveFileName(at, seq + 1)
    }

    const header = this.options.prompts.render(ARCHIVE_HEADER_PROMPT, {
      agentId,
      date: at.toISOString().slice(0, 10),
      count: String(plan.condensing.length)
    })
    const archiveBody = `${header.trim()}\n\n${plan.condensing.map((s) => s.text).join('\n\n')}\n`
    fs.mkdirSync(this.archiveDir(agentId), { recursive: true })
    writeFileAtomic(path.join(this.archiveDir(agentId), archiveName), archiveBody)

    const condensedSection = this.options.prompts.render(CONDENSED_PROMPT, {
      date: at.toISOString().slice(0, 10),
      author: agentId,
      core: core.trim(),
      count: String(plan.condensing.length),
      archive: archiveName
    })
    const parts = [
      ...(plan.preamble === null ? [] : [plan.preamble.text]),
      condensedSection.trim(),
      ...plan.keeping.map((section) => section.text)
    ]
    const next = `${parts.join('\n\n')}\n`

    const check = nothingDestroyed(before, next, this.archiveText(agentId) + archiveBody)
    if (!check.ok) {
      // The archive is already on disk, so nothing is lost — but the rewrite is
      // refused, because a memory that dropped a section is the one outcome
      // NFR-7 forbids outright.
      throw new Error(
        `library: refusing to condense ${agentId} — ${String(check.missing.length)} section(s) would be lost: ${check.missing.join(', ')}`
      )
    }
    writeFileAtomic(this.memoryPath(agentId), next)
    return { archive: archiveName, condensed: plan.condensing.length }
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
