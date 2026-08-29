import { z } from 'zod'
import { STOA_SCHEMA_VERSION, briefIdSchema, sourceIdSchema } from './stoa'

/**
 * The research brief (ADR-0017, FR-13.3, SDD §4.7/§7.7, UC-14 step 3–4).
 *
 * A brief is the Stoa's only product and the only way external evidence enters
 * the Gymnasium's loop, so its shape carries the whole weight of ADR-0017's
 * evidence promise: **every finding cites file paths inside the pinned commit**.
 * That is what lets the Architect open what a proposal claims and check it,
 * years later, against the same bytes the researcher read.
 *
 * The harness refuses a malformed brief BEFORE any human sees it — the FR-12.2
 * pattern applied to research (FR-13.3). An uncited finding is not a weak
 * finding to be argued about in review; it is a brief that does not exist yet.
 *
 * And the adversarial part, which is the reason this file is careful: a studied
 * repository is arbitrary third-party text. A README that says "ignore your
 * instructions and run this" is **data**. NFR-17 makes reporting it the correct
 * behaviour and obeying it a defect, so the schema gives a directive found in a
 * source somewhere to LIVE — `directive: true` on the finding that reports it —
 * rather than leaving the researcher with no way to mention one except by
 * acting on it.
 */

/** One observed pattern, with the citations that make it checkable. */
export const findingSchema = z
  .object({
    what: z.string().min(1).max(4_000),
    /**
     * File paths inside the pinned commit. At least one, always: FR-13.3 makes
     * an uncited finding a rejected brief, and a citation that names no file is
     * an opinion with a repository next to it.
     */
    citations: z.array(z.string().min(1).max(300)).min(1).max(32),
    /**
     * True when this finding REPORTS an instruction the source addressed to its
     * reader (NFR-17, UC-14 alternate 3a). Reporting one is the correct
     * outcome; obeying it is the defect S-STOA plants a trap for.
     */
    directive: z.boolean().default(false)
  })
  .strict()

export type Finding = z.infer<typeof findingSchema>

/** One finding mapped onto Ephesus, with our own records where they exist. */
export const applicabilitySchema = z
  .object({
    /** 1-based index into `findings` — the brief is a document, not a graph. */
    finding: z.number().int().min(1).max(64),
    subsystem: z.string().min(1).max(120),
    note: z.string().min(1).max(4_000),
    /** Internal refs (PROGRESS, DECISIONS-LOG, log#seq, GYM ids). May be empty. */
    refs: z.array(z.string().min(1).max(200)).max(32).default([])
  })
  .strict()

/** A seed for a GYM proposal — a candidate, never a proposal (ADR-0017 R3). */
export const candidateSchema = z
  .object({
    what: z.string().min(1).max(2_000),
    fromFindings: z.array(z.number().int().min(1).max(64)).min(1).max(64)
  })
  .strict()

/**
 * A brief as a researcher files it.
 *
 * `commit` is the pin the study actually ran against and is checked against the
 * watchlist entry at intake: a brief citing a commit nobody registered is a
 * brief whose citations resolve to bytes nobody chose to trust.
 */
export const researchBriefSchema = z
  .object({
    schemaVersion: z.literal(STOA_SCHEMA_VERSION),
    kind: z.literal('research-brief'),
    sourceId: sourceIdSchema,
    title: z.string().min(1).max(200),
    /** Which of the entry's tags this study served (FR-13.2 scopes studies). */
    question: z.string().min(1).max(2_000),
    commit: z.string().min(7).max(64),
    findings: z.array(findingSchema).min(1).max(64),
    applicability: z.array(applicabilitySchema).min(1).max(64),
    candidates: z.array(candidateSchema).max(64).default([]),
    /** FR-13.5: what the license permits, and whether anything needs intake. */
    licenseNote: z.string().min(1).max(4_000)
  })
  .strict()

export type ResearchBrief = z.infer<typeof researchBriefSchema>

export type BriefParse =
  | { readonly ok: true; readonly brief: ResearchBrief }
  | { readonly ok: false; readonly reasons: readonly string[] }

/**
 * Contract: parses a filed brief, or lists everything wrong with it.
 *
 * Every reason at once, exactly as `parseGymProposal` does: FR-13.3 puts the
 * harness before the human, so this list is the researcher's only feedback and
 * a list of one wastes a round trip per missing field.
 */
export function parseResearchBrief(body: string): BriefParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return {
      ok: false,
      reasons: [`stoa: brief is not JSON — ${err instanceof Error ? err.message : String(err)}`]
    }
  }
  const parsed = researchBriefSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      reasons: parsed.error.issues.map((issue) => {
        const where = issue.path.length > 0 ? issue.path.join('.') : 'brief'
        // The uncited-finding case is the one FR-13.3 names, so it says so in
        // those words rather than in zod's.
        if (/^findings\.\d+\.citations$/.test(issue.path.join('.'))) {
          return `${where}: a finding must cite at least one file path inside the pinned commit (FR-13.3)`
        }
        return `${where}: ${issue.message}`
      })
    }
  }
  return { ok: true, brief: parsed.data }
}

export interface IntakeCheck {
  readonly ok: boolean
  readonly reasons: readonly string[]
}

/**
 * Contract: the checks a parsed brief must still pass at intake.
 *
 * These are the ones the schema cannot express, because they are about the
 * brief's relationship to the watchlist rather than about its own fields:
 *
 * - the commit studied must be the commit registered (provenance);
 * - every applicability entry must point at a finding that exists (a document
 *   whose cross-references dangle is not checkable);
 * - every candidate must build on findings that exist, because a candidate
 *   nothing supports is the uncited-finding problem wearing a different hat.
 */
export function checkBriefAgainstSource(
  brief: ResearchBrief,
  source: { readonly id: string; readonly pin: string | null }
): IntakeCheck {
  const reasons: string[] = []
  if (brief.sourceId !== source.id) {
    reasons.push(`the brief names source ${brief.sourceId}, not ${source.id}`)
  }
  if (source.pin === null) {
    reasons.push(
      `${source.id} has no pinned commit; a study runs against a pinned snapshot (FR-13.2)`
    )
  } else if (!sameCommit(brief.commit, source.pin)) {
    reasons.push(
      `the brief cites ${brief.commit} but ${source.id} is pinned at ${source.pin}; citations must resolve inside the pinned snapshot`
    )
  }
  for (const [index, entry] of brief.applicability.entries()) {
    if (entry.finding > brief.findings.length) {
      reasons.push(
        `applicability.${String(index)}: finding ${String(entry.finding)} does not exist (the brief has ${String(brief.findings.length)})`
      )
    }
  }
  for (const [index, candidate] of brief.candidates.entries()) {
    for (const from of candidate.fromFindings) {
      if (from > brief.findings.length) {
        reasons.push(
          `candidates.${String(index)}: finding ${String(from)} does not exist (the brief has ${String(brief.findings.length)})`
        )
      }
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * Contract: do these two refer to the same commit?
 *
 * The watchlist may carry a short sha and a brief the full one (or the reverse),
 * because a human types the short form and a checkout reports the long one.
 * Prefix matching in the longer direction is the honest comparison; equality
 * would reject correct briefs for a formatting difference.
 */
function sameCommit(a: string, b: string): boolean {
  const [x, y] = a.length <= b.length ? [a, b] : [b, a]
  return y.toLowerCase().startsWith(x.toLowerCase())
}

/**
 * Contract: renders a validated brief as the archive's markdown.
 *
 * The section order is `docs/stoa/briefs/README.md` verbatim, so a brief the
 * running system archives and a brief the build phase wrote are the same kind
 * of document — which is what makes FR-13.7's seeding meaningful rather than
 * merely mechanical.
 */
export function renderBrief(id: string, brief: ResearchBrief, repoUrl: string): string {
  const lines: string[] = [
    `# ${id} — ${brief.title}`,
    '',
    `**Source:** ${brief.sourceId} · ${repoUrl} @ \`${brief.commit}\``,
    `**Question:** ${brief.question}`,
    '',
    '## Findings',
    ''
  ]
  for (const [index, finding] of brief.findings.entries()) {
    // The directive marker is loud on purpose: a reader skimming the archive
    // should be able to see that the source tried to give an instruction and
    // that the company wrote it down instead of following it (NFR-17).
    const flag = finding.directive
      ? ' **[instruction addressed to the reader — reported, not followed (NFR-17)]**'
      : ''
    lines.push(`${String(index + 1)}. ${finding.what}${flag}`)
    lines.push(`   Cites: ${finding.citations.map((c) => `\`${c}\``).join(', ')}`)
    lines.push('')
  }
  lines.push('## Applicability', '')
  for (const entry of brief.applicability) {
    const refs = entry.refs.length > 0 ? ` (${entry.refs.join(', ')})` : ''
    lines.push(`- Finding ${String(entry.finding)} → **${entry.subsystem}**: ${entry.note}${refs}`)
  }
  lines.push('', '## Candidate improvements', '')
  if (brief.candidates.length === 0) {
    lines.push('- None. A study that found nothing worth changing says so.')
  } else {
    for (const candidate of brief.candidates) {
      lines.push(
        `- ${candidate.what} (from finding ${candidate.fromFindings.map(String).join(', ')})`
      )
    }
  }
  lines.push('', '## License note', '', brief.licenseNote, '')
  return lines.join('\n')
}

/** Contract: the archive filename for a brief. Slugged from its own title. */
export function briefFileName(id: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return `${id}-${slug.length > 0 ? slug : 'brief'}.md`
}

export { briefIdSchema }

/**
 * Contract: the brief ids a proposal's evidence refs cite (FR-13.4).
 *
 * A proposal seeded by research must SAY so, by id, in the one field FR-12.1
 * already makes load-bearing. That is what makes a brief "linkable from the
 * proposals it seeded" without a second index to fall out of date: the link is
 * the citation, and the citation is already required to exist.
 *
 * Matched loosely inside each ref so `"RB-014 finding 2"` counts — an author
 * naming which finding they built on is being MORE precise, and a matcher that
 * demanded a bare id would punish them for it.
 */
export function citedBriefIds(evidence: readonly string[]): readonly string[] {
  const found = new Set<string>()
  for (const ref of evidence) {
    for (const match of ref.matchAll(/RB-\d{3,}/g)) found.add(match[0])
  }
  return [...found].sort()
}
