import { z } from 'zod'
import { parseMemorySections, type MemorySection } from './memory'

/**
 * Reflection — Library layer 3 (ADR-0006, FR-6.3, NFR-7).
 *
 * "A scheduled condensation job summarizes each `memory.md` past a size
 * threshold into a compact core + dated archive of what was condensed — memory
 * is bounded, and nothing is destroyed."
 *
 * Two rules from the documents shape everything here, and both are load-bearing:
 *
 * 1. **Nothing is destroyed** (NFR-7). What leaves `memory.md` is written to
 *    `memory-archive/` *verbatim* first. `core ∪ archive ⊇ old memory` is not a
 *    hope about a summary's quality — it holds because the archive is a copy.
 * 2. **The harness does not summarize.** ADR-0005 explicitly rejects "the
 *    harness calls a model API directly"; condensing is judgement, so it runs as
 *    a normal agent turn on a harness prompt. This module owns the *mechanism*
 *    (when, what moves, what is checked) and has no opinion about what a good
 *    condensation says.
 */

/**
 * When a memory is long enough to condense, in characters.
 *
 * Set well above the injection budget (`MEMORY_INJECTION_BUDGET_CHARS`, 8 000):
 * reflection should fire because memory has genuinely outgrown one session's
 * worth of context, not the moment the budget first elides anything. Three
 * times over is a memory that has been eliding for a while.
 */
export const REFLECTION_THRESHOLD_CHARS = 24_000

/** Sections left in `memory.md` untouched — the most recent working memory. */
export const REFLECTION_KEEP_SECTIONS = 5

/** Wire format of the condensation an agent proposes back. */
export const REFLECTION_SCHEMA_VERSION = 1

export const condensationSchema = z
  .object({
    schemaVersion: z.literal(REFLECTION_SCHEMA_VERSION),
    /** The agent's own compact account of what it condensed. Prose, unvalidated. */
    core: z.string().min(1).max(50_000)
  })
  .strict()

export type Condensation = z.infer<typeof condensationSchema>

export type CondensationParse =
  | { readonly ok: true; readonly condensation: Condensation }
  | { readonly ok: false; readonly reason: string }

/**
 * Contract: reads a condensation out of an agent's message body.
 *
 * Tolerant of the fenced code block engines love to wrap JSON in, and explicit
 * about every refusal — the reason goes back to the agent, which is the only
 * way it can fix its next attempt.
 */
export function parseCondensation(body: string): CondensationParse {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(body)
  const text = (fenced?.[1] ?? body).trim()
  if (text.length === 0) return { ok: false, reason: 'the message body is empty' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'the body is not valid JSON' }
  }
  const parsed = condensationSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map((issue) => issue.message).join('; ') }
  }
  return { ok: true, condensation: parsed.data }
}

/** What one condensation would move, decided before anything is written. */
export interface ReflectionPlan {
  /** True when this memory is over the threshold and has enough to condense. */
  readonly due: boolean
  /** Why not, when `due` is false — reflection never declines silently. */
  readonly because: string
  /** Sections that would move to the archive, verbatim and in file order. */
  readonly condensing: readonly MemorySection[]
  /** Sections that stay in `memory.md`. */
  readonly keeping: readonly MemorySection[]
  /** Everything above the first heading — the seed header, which always stays. */
  readonly preamble: MemorySection | null
  readonly chars: number
}

/**
 * Contract: what reflection would do to this memory, without doing it.
 *
 * Pure and inspectable on purpose: the scheduler asks this every tick, and a
 * plan that has to be executed to be understood is one nobody can reason about.
 */
export function planReflection(
  memory: string,
  options: { threshold?: number; keep?: number } = {}
): ReflectionPlan {
  const threshold = options.threshold ?? REFLECTION_THRESHOLD_CHARS
  const keep = options.keep ?? REFLECTION_KEEP_SECTIONS
  const all = parseMemorySections(memory)
  const preamble = all[0]?.heading === null ? (all[0] ?? null) : null
  const written = preamble === null ? all : all.slice(1)
  const chars = memory.length

  if (chars < threshold) {
    return {
      due: false,
      because: `memory is ${String(chars)} chars, under the ${String(threshold)} threshold`,
      condensing: [],
      keeping: written,
      preamble,
      chars
    }
  }
  if (written.length <= keep) {
    return {
      due: false,
      // A long memory in few sections is a real state: one enormous entry
      // cannot be condensed by moving sections, and pretending otherwise would
      // archive the whole file and leave nothing behind.
      because: `only ${String(written.length)} written section(s); ${String(keep)} are kept`,
      condensing: [],
      keeping: written,
      preamble,
      chars
    }
  }
  return {
    due: true,
    because: 'over the threshold',
    condensing: written.slice(0, written.length - keep),
    keeping: written.slice(written.length - keep),
    preamble,
    chars
  }
}

/**
 * Contract: `core ∪ archive ⊇ old memory` (NFR-7), checked rather than assumed.
 *
 * Every section of the old memory must appear, byte for byte, in the new memory
 * or in the archive. The condensed *core* the agent wrote is not counted as
 * containing anything — a summary is not the thing it summarizes, and treating
 * it as one is exactly how "nothing is destroyed" quietly stops being true.
 */
export function nothingDestroyed(
  oldMemory: string,
  newMemory: string,
  archive: string
): { readonly ok: true } | { readonly ok: false; readonly missing: readonly string[] } {
  const haystack = `${newMemory}\n${archive}`
  const missing = parseMemorySections(oldMemory)
    .filter((section) => !haystack.includes(section.text))
    .map((section) => section.heading ?? '(preamble)')
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

/** Contract: the archive file one condensation writes, `<date>-<seq>.md`. */
export function archiveFileName(at: Date, seq: number): string {
  return `${at.toISOString().slice(0, 10)}-${String(seq).padStart(3, '0')}.md`
}
