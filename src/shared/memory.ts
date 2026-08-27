import { z } from 'zod'

/**
 * Library layer 1 — the shape of `memory.md` (ADR-0006, FR-6.1).
 *
 * ADR-0006 is explicit that structure is extracted at **read** time and never
 * imposed at write time: "LLMs write prose; forcing schema at write time loses
 * information and adds failure modes." So nothing here validates what an agent
 * *said*. What it owns is the harness's own framing — the dated section header
 * the harness writes and the parser that finds those headers again — plus the
 * injection budget, which decides how much of a long memory reaches a spawn.
 *
 * Everything is pure and free of prose: the elision notice an agent reads is a
 * prompt (invariant §8), rendered by the caller from the facts below.
 */

/** How a harness-written section is headed: `## <ISO date> — <author>`. */
const HEADING = /^##[ \t]+(\d{4}-\d{2}-\d{2})(?:[ \t]*—[ \t]*(.+?))?[ \t]*$/

/** Any `## …` line starts a section, dated or not — agents write prose. */
const ANY_HEADING = /^##[ \t]+\S/

/**
 * One section of a memory file, verbatim.
 *
 * `date` and `author` are null for anything that does not carry the harness's
 * framing — a heading an agent wrote its own way, or the preamble above the
 * first heading. That is not an error state: it is what "no schema at write
 * time" means, and the section's text is preserved either way.
 */
export interface MemorySection {
  /** The raw heading line, or null for the preamble above the first heading. */
  readonly heading: string | null
  /** `YYYY-MM-DD` when the heading carries the harness framing, else null. */
  readonly date: string | null
  /** Who wrote it, when the heading says, else null. */
  readonly author: string | null
  /** The prose under the heading, verbatim apart from surrounding blank lines. */
  readonly body: string
  /** Heading + body exactly as they appear in the file; sections re-join to it. */
  readonly text: string
}

/**
 * Contract: splits a memory file into sections in file order, losslessly —
 * `parseMemorySections(t).map(s => s.text).join('\n') + trailing` reproduces the
 * meaningful content of `t`. Never throws: an unreadable memory is still the
 * company's memory.
 */
export function parseMemorySections(text: string): readonly MemorySection[] {
  if (text.trim().length === 0) return []
  const lines = text.split('\n')
  const sections: MemorySection[] = []
  let heading: string | null = null
  let buffer: string[] = []

  const flush = (): void => {
    const body = buffer.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
    if (heading === null && body.length === 0) {
      buffer = []
      return
    }
    const matched = heading === null ? null : HEADING.exec(heading)
    sections.push({
      heading,
      date: matched?.[1] ?? null,
      author: matched?.[2]?.trim() ?? null,
      body,
      text: heading === null ? body : body.length > 0 ? `${heading}\n\n${body}` : heading
    })
    buffer = []
  }

  for (const line of lines) {
    if (ANY_HEADING.test(line)) {
      flush()
      heading = line.replace(/\s+$/, '')
    } else {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

/** The framing fields the harness owns. The body is prose and is not validated. */
export const memoryEntrySchema = z
  .object({
    /** ISO-8601 instant; only its date part reaches the heading. */
    at: z.string().min(1).max(64),
    /** An agent id, or a harness label like `harness`. */
    author: z.string().min(1).max(64),
    /** Prose. Bounded only so one runaway turn cannot make the file unreadable. */
    body: z.string().min(1).max(100_000)
  })
  .strict()

export type MemoryEntry = z.infer<typeof memoryEntrySchema>

/**
 * Contract: renders one dated section, ready to be appended to a memory file.
 * Always starts with a blank line so appending to a non-empty file cannot weld
 * the new heading onto the previous section's last paragraph.
 */
export function composeMemoryEntry(entry: MemoryEntry): string {
  const date = entry.at.slice(0, 10)
  const body = entry.body.replace(/\s+$/, '')
  return `\n## ${date} — ${entry.author}\n\n${body}\n`
}

/**
 * How much memory text one spawn may carry.
 *
 * A budget has to exist: `memory.md` grows without bound between reflections
 * (ADR-0006 layer 3 is what bounds it), and an agent whose whole history is
 * pasted into every spawn eventually spends its context on itself. 8 000
 * characters is roughly two thousand tokens — a few dozen dated sections, and
 * a small fraction of any current engine's window.
 */
export const MEMORY_INJECTION_BUDGET_CHARS = 8_000

/** What the budget did, so the caller can say so out loud (invariant §7). */
export interface MemoryInjection {
  /** The text to inject; empty when the file is empty. */
  readonly text: string
  readonly totalSections: number
  readonly includedSections: number
  /** Characters of section text left out. Zero when nothing was elided. */
  readonly elidedChars: number
  /** True when the budget bit — the caller owes the agent a visible notice. */
  readonly truncated: boolean
}

/**
 * Contract: the newest whole *written* sections that fit in `budget`, in file
 * order.
 *
 * Whole sections, never a prefix of one: half a learning is worse than none,
 * because the agent cannot tell it is reading half.
 *
 * The preamble — everything above the first heading, which is the seed header
 * the harness writes at hire — is never injected and never counted. It explains
 * the file to an agent that already has the same instruction in `PROTOCOL.md`,
 * and counting it would make a hire that has remembered nothing report that its
 * memory carried over. That log fact has to be true (M3.7's carried item), so
 * "nothing written yet" must come back as nothing.
 */
export function selectMemoryForInjection(
  text: string,
  budget: number = MEMORY_INJECTION_BUDGET_CHARS
): MemoryInjection {
  const sections = parseMemorySections(text).filter((section) => section.heading !== null)
  if (sections.length === 0) {
    return { text: '', totalSections: 0, includedSections: 0, elidedChars: 0, truncated: false }
  }

  const kept: MemorySection[] = []
  let used = 0
  let elidedChars = 0
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const section = sections[i]
    if (section === undefined) continue
    const cost = section.text.length + 2
    if (used + cost <= budget) {
      kept.unshift(section)
      used += cost
    } else {
      elidedChars += section.text.length
    }
  }

  return {
    text: kept.map((section) => section.text).join('\n\n'),
    totalSections: sections.length,
    includedSections: kept.length,
    elidedChars,
    truncated: kept.length < sections.length
  }
}
