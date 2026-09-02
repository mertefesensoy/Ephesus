import { z } from 'zod'

/**
 * Root-cause claims and the independent verdicts on them (FR-9.2, UC-09 — the
 * second reconciliation gap the 2026-09-01 live run named).
 *
 * ## Why this module exists
 *
 * On 2026-09-01 the on-call agent triaged a real CI failure on
 * `mertefesensoy/MUSAHIT` and produced a detailed, well-argued diagnosis. Most
 * of it verified: the test really does pin `NOW = datetime(2026, 5, 23)`, the
 * window really is 30 days, the failing branch really is the one it named. Its
 * ROOT CAUSE was false and took ten seconds to check — the function it said had
 * no injectable clock already takes one, documented, and already threads it
 * through. The proposed fix was work already done.
 *
 * Nothing in the company could see that. `checkTriage` reconciles a report's
 * LEDGER claims against `tasks.json` and deliberately stops there — it checks
 * claims, never judgement. But "the cause is X" is not judgement in the way a
 * severity is: it is an assertion about the CONTENT OF A FILE, and a file can be
 * read by somebody else. That is the whole opening this module works in.
 *
 * ## The two rules, and why they are the same rule
 *
 * 1. **A root cause must be citeable.** `rootCauseSchema` cannot represent a
 *    claim with no citation, and a citation cannot be represented without a
 *    file, a line, and the TEXT the agent says is on it. This is
 *    `checkNarrative` at one remove: a brief sentence citing a ref no fact
 *    supports is refused, so a diagnosis pointing at source nobody can find is
 *    refused too.
 *
 *    The quote is the load-bearing field. "ArcLinker has no injectable clock" is
 *    unfalsifiable prose; `linker.py:122 — "async def run(self, run_id: str)"`
 *    is a statement a second reader can hold against the file and watch fail.
 *    Requiring the quote is what turns a confident sentence into a checkable
 *    one, and it is the cheapest half of this whole design.
 *
 * 2. **The verifier is held to the same rule.** A verdict carries what the
 *    verifier READ, in the same shape, and `checkVerdict` refuses an `agree` or
 *    a `refute` that cites nothing, or that cites only files the claim never
 *    mentioned. A verifier that could say "wrong" without evidence would be a
 *    second confident voice with no more standing than the first, and the
 *    Architect's position on this is explicit: the verdict is recorded BESIDE
 *    the claim rather than replacing it, because **the verifier can be wrong
 *    too.** A verdict that must show its work is one the Architect can referee.
 *
 * ## What this module cannot do, and does not pretend to
 *
 * It never compares a quote to a file. The harness has not read the repository
 * and must not start: ADR-0005 puts judgement on the agent's side of the line,
 * and a harness that graded diagnoses would be making exactly the call this path
 * exists to have a second pair of eyes make. Everything here is DISCIPLINE — is
 * the claim shaped so it can be checked, did the verdict come with evidence,
 * does that evidence overlap what was claimed. Whether the quote is really on
 * line 122 is the verifier's finding, and the verifier is an agent.
 */

/**
 * Its own version rather than the incident protocol's, because a verdict is a
 * separate document with a separate author: the verifier is not the on-call
 * agent, and the two can migrate at different times. Deliberately does not
 * import `INCIDENT_SCHEMA_VERSION` — `incident.ts` imports THIS module, and a
 * cycle in a module zod initializes at import time is a crash, not a style
 * problem (the reasoning `reserved.ts` already records).
 */
export const ROOT_CAUSE_SCHEMA_VERSION = 1

/**
 * One thing an agent says it read, and where.
 *
 * All three fields are required. A citation with no line is a file
 * recommendation; a citation with no quote is an assertion about a line rather
 * than a reading of it, and that is precisely the shape the false MUSAHIT
 * diagnosis had. The maximum on `quote` is a line or two, not a region: an agent
 * that needs 400 characters to show what it saw is quoting a scroll, and a
 * scroll cannot be checked at a glance.
 */
export const sourceCitationSchema = z
  .object({
    /** Repository-relative path, as the agent read it. */
    file: z.string().min(1).max(400),
    line: z.number().int().min(1).max(10_000_000),
    /** The text the agent says is at that line, verbatim. */
    quote: z.string().min(1).max(400)
  })
  .strict()

export type SourceCitation = z.infer<typeof sourceCitationSchema>

/**
 * A root cause, as the on-call agent asserts it.
 *
 * `cites` is `.min(1)` — an unciteable root cause is unrepresentable, which is
 * the strongest available form of "refusing an unciteable claim is a legitimate
 * option". The alternative (accept it, mark it unverifiable) was rejected: an
 * unverifiable diagnosis in the log reads exactly like a verified one three
 * weeks later, and the company already has one recorded instance of that costing
 * a day of work.
 */
export const rootCauseSchema = z
  .object({
    /** The claim itself, in the agent's words, carried verbatim everywhere. */
    claim: z.string().min(1).max(2_000),
    cites: z.array(sourceCitationSchema).min(1).max(16)
  })
  .strict()

export type RootCause = z.infer<typeof rootCauseSchema>

/**
 * The three answers a verifier may give.
 *
 * `cannot-tell` is a first-class result and not a failure. A verifier that could
 * only agree or refute would be forced to guess when the file moved, the branch
 * was gone, or the claim was about behaviour rather than source — and a guess is
 * the thing this whole path exists to catch. Making the honest answer available
 * is what keeps the other two meaning something.
 */
export const ROOT_CAUSE_VERDICTS = ['agree', 'refute', 'cannot-tell'] as const

export const rootCauseVerdictKindSchema = z.enum(ROOT_CAUSE_VERDICTS)

export type RootCauseVerdictKind = z.infer<typeof rootCauseVerdictKindSchema>

/**
 * What the verifier sends back.
 *
 * `read` is what it actually opened — not what it thinks about the claim, but
 * the lines it puts its own name to. `because` is its reasoning in its own
 * words, carried verbatim into the log for the same reason the triage summary
 * is: a rewritten sentence is a claim nobody made.
 */
export const rootCauseVerdictSchema = z
  .object({
    schemaVersion: z.literal(ROOT_CAUSE_SCHEMA_VERSION),
    kind: z.literal('root-cause-verdict'),
    /** The incident key the claim was about — `<repo>#<kind>:<ref>`. */
    incident: z.string().min(1).max(200),
    verdict: rootCauseVerdictKindSchema,
    /** One paragraph, the verifier's words. */
    because: z.string().min(1).max(2_000),
    /**
     * The source the verifier read. Bounded by `checkVerdict` rather than by the
     * schema, because how much evidence is owed depends on the verdict, and a
     * schema cannot say "at least one, unless you could not tell".
     */
    read: z.array(sourceCitationSchema).max(16)
  })
  .strict()

export type RootCauseVerdict = z.infer<typeof rootCauseVerdictSchema>

export type RootCauseVerdictParse =
  | { readonly ok: true; readonly verdict: RootCauseVerdict }
  | { readonly ok: false; readonly reasons: readonly string[] }

/**
 * Contract: parses a verifier's verdict, or lists everything wrong with it.
 * Pure; never throws.
 *
 * Mirrors `parseTriageReport` exactly, including the refusal to default: an
 * unreadable verdict does not become `cannot-tell`. "The verifier's answer was
 * unreadable" and "the verifier could not tell" are different facts, and
 * collapsing them would put a conclusion in the log that nobody reached.
 */
export function parseRootCauseVerdict(body: string): RootCauseVerdictParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return {
      ok: false,
      reasons: [
        `root-cause verdict: not JSON — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
      ]
    }
  }
  const parsed = rootCauseVerdictSchema.safeParse(raw)
  if (parsed.success) return { ok: true, verdict: parsed.data }
  return {
    ok: false,
    reasons: parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : 'root-cause verdict'
      return `${where}: ${issue.message}`
    })
  }
}

/**
 * Path comparison for citations: separators normalized, case folded.
 *
 * Case-insensitive on purpose, though a POSIX repository is not. The question
 * this answers is "did the verifier look at the file the claim pointed at", and
 * a claim citing `Musahit/arcs/linker.py` against a verdict citing
 * `musahit/arcs/linker.py` is one file and a transcription slip. Refusing that
 * would teach agents to fight the checker rather than read the source, which is
 * the failure a checker nobody trusts always produces.
 */
function samePath(a: string, b: string): boolean {
  const normalize = (file: string): string =>
    file.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase()
  return normalize(a) === normalize(b)
}

export interface VerdictCheck {
  readonly ok: boolean
  readonly reasons: readonly string[]
}

/**
 * Contract: pure. Whether a verdict is EVIDENCED — not whether it is right.
 *
 * Three rules, and each is the claimant's own rule turned around:
 *
 * 1. An `agree` or a `refute` must cite something. A verdict with no evidence is
 *    an opinion, and the report it judges was held to exactly that standard.
 * 2. That evidence must overlap the claim's own citations by at least one file.
 *    A verifier that read somewhere else has answered a different question — and
 *    the failure this catches is real: the MUSAHIT claim was refutable only by
 *    opening the very file it cited. Extra files are welcome (a refutation often
 *    lives one call site over); the rule is an overlap, not an equality.
 * 3. `cannot-tell` is owed no citations, only its reason — which the schema
 *    already requires. A verifier that could not open the file must be able to
 *    say so without inventing a reading to justify itself.
 *
 * What it does NOT check is whether any quote is really on any line. The harness
 * has not read the repository (ADR-0005), and a checker that pretended otherwise
 * would be the confident wrongness this path exists to catch, one level up.
 */
export function checkVerdict(verdict: RootCauseVerdict, claim: RootCause): VerdictCheck {
  const reasons: string[] = []
  if (verdict.verdict === 'cannot-tell') return { ok: true, reasons }

  if (verdict.read.length === 0) {
    reasons.push(
      `a "${verdict.verdict}" verdict must quote what it read; give the file, the line and the text, or answer "cannot-tell"`
    )
    return { ok: false, reasons }
  }

  const claimed = claim.cites.map((cite) => cite.file)
  const overlaps = verdict.read.some((cite) => claimed.some((file) => samePath(file, cite.file)))
  if (!overlaps) {
    reasons.push(
      `the verdict read ${verdict.read.map((cite) => cite.file).join(', ')} but the claim rests on ${claimed.join(', ')}; read what the claim cites before judging it`
    )
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * Contract: citations as one line each, for a prompt's `{{cites}}` slot.
 *
 * A serialization, not prose — the same standing `formatHandover` has in
 * `hermes.ts`. Every word of framing around these lines lives in
 * `prompts/harbor/` (invariant §8); what is here is the agent's own data, laid
 * out one per line because the alternative (pretty-printed JSON) is what made
 * the M7.6 handover nudge unreadable.
 */
export function formatCitations(cites: readonly SourceCitation[]): string {
  if (cites.length === 0) return '(none)'
  return cites.map((cite) => `- ${cite.file}:${String(cite.line)} — ${cite.quote}`).join('\n')
}
