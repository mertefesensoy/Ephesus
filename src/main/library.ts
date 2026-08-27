import fs from 'node:fs'
import path from 'node:path'
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
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
