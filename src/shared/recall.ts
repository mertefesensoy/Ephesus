import { z } from 'zod'

/**
 * Recall — the Library's search surface and its degradation ladder
 * (ADR-0006 layer 2, re-pointed at MemPalace by ADR-0016 §5).
 *
 * The ladder is the design, not a fallback bolted on afterwards:
 *
 *   mempalace → fts → grep
 *
 * and **every rung is visible** (invariant §7). "What does the company know?"
 * has to stay answerable by grep — that is ADR-0006's transparency floor — so
 * the bottom rung is implemented here, in pure code with no index, no native
 * module and no external process, and it is the one rung that can never be
 * unavailable.
 *
 * Everything in this module is pure and deterministic: the recall smoke test's
 * known-answer queries need the same answer every run, on every rung.
 */

/** The ladder, best first. The Memory panel shows which rung answered. */
export const RECALL_RUNGS = ['mempalace', 'fts', 'grep'] as const

export const recallRungSchema = z.enum(RECALL_RUNGS)

export type RecallRung = z.infer<typeof recallRungSchema>

/** Where a hit came from — three corpora, one search (ADR-0006 layers 1–2). */
export const RECALL_SOURCES = ['memory', 'archive', 'knowledge'] as const

export const recallSourceSchema = z.enum(RECALL_SOURCES)

export type RecallSource = z.infer<typeof recallSourceSchema>

/** Wire format between the `eph-recall` shim and main. */
export const RECALL_SCHEMA_VERSION = 1

/**
 * The HTTP path recall answers on — the SAME socket the hook plane uses.
 *
 * One socket, one 0600 file, one per-spawn token registry (ADR-0010,
 * ENGINEERING-STANDARDS §5). A second endpoint would be a second thing to
 * secure and a second thing to clean up after a crash, for no capability the
 * first one does not already have.
 */
export const RECALL_ENDPOINT_PATH = '/recall'

/** The default number of snippets an agent gets back. */
export const RECALL_DEFAULT_LIMIT = 5
export const RECALL_MAX_LIMIT = 25
/** Longest snippet returned, in characters — a recall answer is not a file. */
export const RECALL_SNIPPET_CHARS = 600

export const recallRequestSchema = z
  .object({
    schemaVersion: z.literal(RECALL_SCHEMA_VERSION),
    token: z.string().min(1).max(256),
    agentId: z.string().min(1).max(64),
    query: z.string().min(1).max(1_000),
    /**
     * Restrict to one agent's own memory (`agent.mason`) or one corpus
     * (`knowledge`). Absent = the whole company (ADR-0016's wing scoping,
     * expressed at the surface every rung shares).
     */
    scope: z.string().min(1).max(64).nullable(),
    limit: z.number().int().min(1).max(RECALL_MAX_LIMIT)
  })
  .strict()

export type RecallRequest = z.infer<typeof recallRequestSchema>

export const recallHitSchema = z
  .object({
    /** Where this came from, as a path an agent (or the Architect) can open. */
    ref: z.string().min(1).max(1_024),
    source: recallSourceSchema,
    /** The agent whose memory it is, or the shelf document's name. */
    scope: z.string().min(1).max(128),
    /** The section heading it was found under, or the file's name. */
    title: z.string().min(1).max(256),
    snippet: z.string().min(1).max(4_000),
    score: z.number()
  })
  .strict()

export type RecallHit = z.infer<typeof recallHitSchema>

export const recallResponseSchema = z
  .object({
    schemaVersion: z.literal(RECALL_SCHEMA_VERSION),
    query: z.string(),
    rung: recallRungSchema,
    hits: z.array(recallHitSchema).max(RECALL_MAX_LIMIT),
    /**
     * Why the answer came from this rung rather than the one above it — null
     * only on the top rung. Never empty when the ladder stepped down: the agent
     * reading this has to know it got the keyword answer, not the semantic one
     * (invariant §7).
     */
    degraded: z.string().max(500).nullable()
  })
  .strict()

export type RecallResponse = z.infer<typeof recallResponseSchema>

/** One searchable document, as every rung sees it. */
export interface RecallDoc {
  /** Stable identity: the absolute path of the file it came from. */
  readonly ref: string
  readonly source: RecallSource
  readonly scope: string
  readonly text: string
}

/**
 * Contract: the query's distinct search terms, lowercased.
 *
 * One-character tokens are dropped — they match everywhere and rank nothing.
 * No stemming and no stopword list: both are language-specific guesses, and the
 * grep rung's promise is "you can predict what it will find".
 */
export function recallTerms(query: string): readonly string[] {
  const seen = new Set<string>()
  for (const raw of query.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    const term = raw.replace(/^[.-]+|[.-]+$/g, '')
    if (term.length > 1) seen.add(term)
  }
  return [...seen]
}

/** A document split at its markdown headings — the unit a snippet comes from. */
export interface RecallPassage {
  readonly title: string
  readonly text: string
}

/**
 * Contract: splits a document at its markdown headings.
 *
 * Exported because **every rung must split the corpus the same way**. The FTS
 * rung indexes passages and the grep rung scans them; if the two disagreed
 * about what a passage is, "the same known-answer query on every rung" would be
 * comparing different things.
 */
export function recallPassages(doc: RecallDoc): readonly RecallPassage[] {
  const lines = doc.text.split('\n')
  const passages: RecallPassage[] = []
  let title = doc.scope
  let buffer: string[] = []
  const flush = (): void => {
    const text = buffer.join('\n').trim()
    if (text.length > 0) passages.push({ title, text })
    buffer = []
  }
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) {
      flush()
      title = line.replace(/^#+\s*/, '').trim()
    } else {
      buffer.push(line)
    }
  }
  flush()
  return passages
}

/**
 * Contract: how well one passage answers a query.
 *
 * Distinct terms dominate the total count — a passage mentioning every term
 * once beats one that repeats a single term twenty times, which is the whole
 * difference between an answer and a keyword pile. Returns 0 when no term is
 * present, and 0 never becomes a hit.
 */
export function scorePassage(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  const haystack = text.toLowerCase()
  let distinct = 0
  let occurrences = 0
  for (const term of terms) {
    const count = countOccurrences(haystack, term)
    if (count > 0) {
      distinct += 1
      occurrences += count
    }
  }
  if (distinct === 0) return 0
  return distinct * 10 + Math.min(occurrences, 20)
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + needle.length
  }
}

/** How many term occurrences are considered when choosing a snippet window. */
const SNIPPET_CANDIDATES = 200

/**
 * Contract: the window of `text` that answers best, bounded and whole-lined.
 *
 * "Best" is the window containing the most *distinct* query terms, earliest
 * wins on a tie. Windowing on the first match instead was wrong in a way only a
 * live run showed: in "why is checkout unreliable", `is` matches in the second
 * line of any document, so every snippet opened on the file's boilerplate while
 * the sentence that actually answered sat outside the window.
 */
export function snippetOf(text: string, terms: readonly string[]): string {
  if (text.length <= RECALL_SNIPPET_CHARS) return text
  const haystack = text.toLowerCase()

  const candidates: number[] = []
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = haystack.indexOf(term, from)
      if (at < 0 || candidates.length >= SNIPPET_CANDIDATES) break
      candidates.push(at)
      from = at + term.length
    }
  }
  candidates.sort((a, b) => a - b)

  let start = 0
  let best = -1
  for (const at of candidates) {
    const from = Math.max(0, at - Math.floor(RECALL_SNIPPET_CHARS / 3))
    const window = haystack.slice(from, from + RECALL_SNIPPET_CHARS)
    const distinct = terms.filter((term) => window.includes(term)).length
    if (distinct > best) {
      best = distinct
      start = from
    }
  }

  const cut = text.slice(start, start + RECALL_SNIPPET_CHARS)
  // Opening mid-line reads as a truncation bug; opening at the next line break
  // costs a few characters and reads as a quotation.
  const head = start > 0 ? cut.slice(cut.indexOf('\n') + 1) : cut
  return `${start > 0 ? '…' : ''}${head.trimEnd()}…`
}

/**
 * The **grep rung** (ADR-0006's transparency floor).
 *
 * Contract: deterministic. Ties break on `ref` then `title`, so the same corpus
 * and the same query always produce the same list in the same order — which is
 * what makes a known-answer smoke test possible at all.
 */
export function grepRecall(
  docs: readonly RecallDoc[],
  query: string,
  limit: number = RECALL_DEFAULT_LIMIT
): readonly RecallHit[] {
  const terms = recallTerms(query)
  if (terms.length === 0) return []
  const hits: RecallHit[] = []
  for (const doc of docs) {
    for (const passage of recallPassages(doc)) {
      const score = scorePassage(passage.text, terms)
      if (score === 0) continue
      hits.push({
        ref: doc.ref,
        source: doc.source,
        scope: doc.scope,
        title: passage.title,
        snippet: snippetOf(passage.text, terms),
        score
      })
    }
  }
  return hits
    .sort(
      (a, b) => b.score - a.score || a.ref.localeCompare(b.ref) || a.title.localeCompare(b.title)
    )
    .slice(0, limit)
}

/** Contract: whether a doc is in scope. `null` scope means the whole company. */
export function inScope(doc: RecallDoc, scope: string | null): boolean {
  if (scope === null) return true
  return doc.scope === scope || doc.source === scope
}

/**
 * What a probe of the agent-facing recall COMMAND found (M8c.7).
 *
 * Not of the endpoint — of the command string `EPH_RECALL` hands an agent. The
 * two are different things and only one of them was ever broken.
 */
export interface RecallProbe {
  /** The command as the agent would run it, for the message. */
  readonly command: string
  /** Exit code, or null when it never exited. */
  readonly code: number | null
  /** True when the probe hit its own deadline rather than the process ending. */
  readonly timedOut: boolean
  /** Everything the process wrote, both streams, trimmed. */
  readonly output: string
}

/**
 * Contract: pure. The condition a recall probe raises, or null when the command
 * answered at all.
 *
 * **Why the probe exists.** Finding 9 of the M8 exit run, in the health
 * watcher's own words: *"`$EPH_RECALL` is unavailable, not merely empty. Two
 * attempts (unscoped, and `--scope knowledge`) produced zero bytes of output and
 * never terminated; the second was killed at 90s, exit 143. So I could not fall
 * back on a colleague's transcription of the runbook either, and no agent can
 * currently look anything up."*
 *
 * `DIAGNOSIS.md` disclosed the MemPalace degradation and nothing else, so a
 * reader believed recall had gracefully degraded to a lesser rung. **A missing
 * optional that degrades is the documented design; a path that accepts the call,
 * returns nothing and never returns is a ninety-second timeout trap disclosed
 * nowhere.** Invariant §7 is about exactly this distinction.
 *
 * An ANSWER is enough — including a refusal. `eph-recall` exits 1 with a named
 * cause when the harness is down, and that is the shim working: the agent learns
 * something. What this catches is the case where nothing comes back at all.
 */
export function recallProbeCondition(
  probe: RecallProbe
): { readonly cause: string; readonly detail: string } | null {
  // Three ways to be unreachable, and they are different sentences because a
  // reader acts differently on each. A command that ANSWERED — including one
  // that refused with a named cause — is not any of them.
  if (probe.timedOut) {
    return unreachable(probe, 'never answered')
  }
  if (probe.code === null) {
    // Spawn failed: the shell could not start it at all. `output` carries the
    // system's own message, which is the actionable part.
    return unreachable(probe, `could not be run — ${probe.output || 'no reason given'}`)
  }
  if (probe.output.length === 0) {
    return unreachable(probe, `answered nothing (exit ${String(probe.code)})`)
  }
  return null
}

function unreachable(
  probe: RecallProbe,
  what: string
): { readonly cause: string; readonly detail: string } {
  return {
    cause: 'library/recall-command',
    detail:
      `recall is unreachable, not merely empty: \`${probe.command}\` ${what}. ` +
      'Every agent that tries to look something up will stall on it and then give ' +
      'up, and none of them can tell you why. This is NOT the documented MemPalace ' +
      'degradation — that one answers, on a lesser rung.'
  }
}
