import { z } from 'zod'
import type { LogEntry } from './log'
import type { Task, TaskLedger } from './tasks'

/**
 * The briefing compiler (ADR-0008 §1, FR-7.1, SDD §7.2, UC-04) — S-BRIEF.
 *
 * The division of labour is the whole design, and it runs one way only:
 *
 * - **The harness assembles FACTS.** Every fact comes from the Agora — the
 *   ledger, `log.jsonl`, the cost ledger, open gates and memos — and every one
 *   carries the refs that let a reader find it again. The compiler has no
 *   opinions and writes no prose.
 * - **Artemis writes the NARRATIVE.** Which fact matters most, how to say it,
 *   what to lead with: judgement, and ADR-0005 keeps judgement out of the
 *   harness.
 *
 * Never the reverse. The harness must not narrate, and Artemis must not invent
 * facts — which is enforceable in exactly one direction: **every sentence she
 * writes must carry a ref that resolves to a fact the compiler issued.** A
 * sentence with no resolvable ref fails the brief (`checkNarrative` below), so
 * "briefings compiled strictly from Agora data, never from free recollection"
 * (FR-7.1) is a mechanism rather than an instruction.
 */

export const BRIEF_SCHEMA_VERSION = 1

/**
 * The fixed running order (VOICE-DESIGN §4). Order is part of the contract: the
 * Architect hears briefs daily and should never have to wait to find out what
 * is blocked.
 */
export const BRIEF_SECTIONS = ['headline', 'done', 'blocked', 'health', 'ahead'] as const

export const briefSectionSchema = z.enum(BRIEF_SECTIONS)

export type BriefSection = z.infer<typeof briefSectionSchema>

/**
 * "Blocked & needs-you is never truncated" (VOICE-DESIGN §4). When the length
 * budget bites, it bites everywhere else first.
 */
export const NEVER_TRUNCATED: BriefSection = 'blocked'

/** Measured pace for a briefing voice (VOICE-DESIGN §3). */
export const BRIEF_WPM = 150

/** SRS §6.2's standup test: under 90 seconds of audio. */
export const BRIEF_MAX_SECONDS = 90

/** One assembled fact, with the refs that make it checkable. */
export interface BriefFact {
  readonly section: BriefSection
  /** Machine-readable summary. Not prose — Artemis writes the prose. */
  readonly what: string
  /** `log#12`, `task:t-…`, `gate:g-…`, `memo:m-…`, `budget:agent.mason`. */
  readonly refs: readonly string[]
}

/** What the compiler reads. Every field is Agora data; there is no other source. */
export interface BriefInput {
  /** Events since the last brief, oldest first. */
  readonly events: readonly LogEntry[]
  readonly ledger: TaskLedger
  readonly openGates: readonly { readonly id: string; readonly agentId: string }[]
  readonly openMemos: readonly { readonly memoId: string }[]
  /** Cumulative tokens per agent, folded from the durable ledger (ADR-0011). */
  readonly spend: readonly { readonly agentId: string; readonly tokens: number }[]
  /**
   * The Gymnasium's budget slice (FR-12.5, ADR-0015 R3). The brief reports it
   * so self-improvement spending is visible every standup rather than only
   * when somebody goes looking — an ambient slice is one nobody notices
   * growing.
   */
  readonly gymSlice?: {
    /**
     * Null when no spend-attribution source is wired (M5 close-out audit,
     * finding 2): the brief must say the figure is missing, never report a
     * constant zero as ledger data (invariant §7 — degradation visible).
     */
    readonly spentTokens: number | null
    /**
     * Where the figure came from, in words (M6.7). The M5 close-out asked for
     * the number back "with its source named": a bare total invites the reader
     * to trust a scope they cannot see, and the brief is read aloud, where
     * there is no card to hover.
     */
    readonly spendSource?: string | null
    readonly tokensPerWeek: number
    readonly open: number
    /**
     * The Stoa's work, reported WITH the slice (FR-13.6) because it is spent
     * out of the same budget (ADR-0017 R4). Optional so a company with no
     * research department reports nothing rather than a row of zeroes that
     * would read as "the Stoa did nothing this week".
     */
    readonly stoa?: {
      readonly sources: number
      readonly briefs: number
    }
    /** The company mode this standup covers (FR-14.1 — stated in every brief). */
    readonly mode?: string
  }
}

/**
 * Contract: the facts a brief may be built from, in section order. Pure and
 * total — the same input always gives the same facts, which is what lets a
 * scenario seed a fixture and assert the whole set.
 *
 * A quiet window yields a headline fact saying so rather than nothing at all: a
 * brief that vanished because nothing happened is indistinguishable from a
 * brief that failed.
 */
export function compileFacts(input: BriefInput): readonly BriefFact[] {
  const facts: BriefFact[] = []

  const done = input.ledger.tasks.filter((task) => task.status === 'done')
  const ahead = input.ledger.tasks.filter(
    (task) => task.status === 'todo' || task.status === 'in_progress'
  )
  const stalled = input.ledger.tasks.filter((task) => task.status === 'stalled')
  const breakerTrips = input.events.filter((event) => event.kind === 'breaker')
  const escalations = input.events.filter(
    (event) => event.kind === 'memo' && event['event'] === 'escalated'
  )

  // 1. Headline — the single most important thing, chosen mechanically by
  //    consequence: something the Architect must act on beats something that
  //    merely happened.
  const headline =
    input.openGates[0] !== undefined
      ? fact('headline', `${String(input.openGates.length)} action(s) waiting on you`, [
          ...input.openGates.map((gate) => `gate:${gate.id}`)
        ])
      : input.openMemos[0] !== undefined
        ? fact('headline', `${String(input.openMemos.length)} memo(s) waiting on your verdict`, [
            ...input.openMemos.map((memo) => `memo:${memo.memoId}`)
          ])
        : stalled[0] !== undefined
          ? fact('headline', `${String(stalled.length)} task(s) stalled`, refsOfTasks(stalled))
          : done[0] !== undefined
            ? fact('headline', `${String(done.length)} task(s) completed`, refsOfTasks(done))
            : fact('headline', 'nothing happened in this window', [])

  facts.push(headline)

  // 2. Done — grouped, never enumerated past three (VOICE-DESIGN §4).
  for (const task of done.slice(0, 3)) {
    facts.push(fact('done', `${task.id} completed: ${task.title}`, [`task:${task.id}`]))
  }
  if (done.length > 3) {
    facts.push(
      fact('done', `and ${String(done.length - 3)} more completed`, refsOfTasks(done.slice(3)))
    )
  }

  // 3. Blocked & needs-you — each with something the Architect can act on.
  for (const gate of input.openGates) {
    facts.push(fact('blocked', `${gate.agentId} is held at a gate`, [`gate:${gate.id}`]))
  }
  for (const memo of input.openMemos) {
    facts.push(fact('blocked', `memo ${memo.memoId} awaits a verdict`, [`memo:${memo.memoId}`]))
  }
  for (const task of stalled) {
    facts.push(fact('blocked', `${task.id} is stalled: ${task.title}`, [`task:${task.id}`]))
  }

  // 4. Health — budgets, breaker trips, escalations.
  for (const row of input.spend) {
    facts.push(
      fact('health', `${row.agentId} has spent ${String(row.tokens)} tokens`, [
        `budget:${row.agentId}`
      ])
    )
  }
  for (const trip of breakerTrips) {
    facts.push(
      fact(
        'health',
        `breaker at rung ${String(trip['rung'] ?? '?')} for ${String(trip['agentId'] ?? '?')}`,
        [`log#${String(trip.seq)}`]
      )
    )
  }
  for (const escalation of escalations) {
    facts.push(
      fact('health', `memo ${String(escalation['memoId'] ?? '?')} escalated to you`, [
        `log#${String(escalation.seq)}`
      ])
    )
  }

  // 4a. Incidents (VOICE-DESIGN §4: health covers "breaker trips, INCIDENTS,
  //     Harbor queue depth"), and SRS §6.1's last clause: "the next briefing
  //     narrates the incident accurately from the log".
  //
  //     Until M7.7 this section had no incident branch at all, so an incident
  //     reached the standup only sideways — as an open gate, or as whatever
  //     task Artemis happened to create. The Architect was never told that
  //     something broke, in which repository, or what the on-call agent
  //     concluded. Two halves that had never met: the incident endpoint wrote
  //     these entries from the day it shipped and the compiler had never heard
  //     of them.
  for (const raised of incidents(input.events, 'incident-raised')) {
    facts.push(
      fact(
        'health',
        `incident ${String(raised['incident'] ?? '?')}: ${String(raised['conclusion'] ?? 'failed')} on ${String(raised['repo'] ?? '?')}, ${String(raised['oncall'] ?? 'nobody')} on call`,
        [`log#${String(raised.seq)}`]
      )
    )
  }
  for (const triaged of incidents(input.events, 'incident-triaged')) {
    // The agent's own sentence, carried VERBATIM. The brief is read aloud and
    // is the E-BRIEF-FAITH surface: a summary the harness rewrote would be a
    // claim nobody made, attributed to the company.
    facts.push(
      fact(
        'health',
        `incident ${String(triaged['incident'] ?? '?')} triaged severity-${String(triaged['severity'] ?? '?')}` +
          `${triaged['resolved'] === true ? ' and resolved' : ', unresolved'}: ${String(triaged['summary'] ?? 'no summary given')}`,
        [`log#${String(triaged.seq)}`]
      )
    )
  }
  // A root cause one agent asserted and another REFUTED is news, and it is the
  // only kind of verdict narrated here. An `agree` is a confirmation and a
  // `cannot-tell` is an absence of one; both are in `log.jsonl` for anyone who
  // looks, and neither is worth a sentence out of a 90-second budget where
  // "blocked is never truncated" (VOICE-DESIGN §4). A contradiction inside the
  // company's own record is different: on 2026-09-01 a false root cause stood
  // unchallenged and the fix it implied was work already done, and the standup
  // is where the Architect finds that out without going looking.
  //
  // Filtered on the recorded `verdict` field rather than on the text of
  // `because`, for the same reason the loops above match on `event`: a reworded
  // sentence must not be able to drop the standup's only account of a dispute.
  for (const verdict of incidents(input.events, 'incident-root-cause-verdict')) {
    if (verdict['verdict'] !== 'refute') continue
    // Both sides verbatim. The brief is the E-BRIEF-FAITH surface and is read
    // aloud: a claim or a refutation the harness rewrote would be words nobody
    // said, attributed to two named agents at once.
    facts.push(
      fact(
        'health',
        `incident ${String(verdict['incident'] ?? '?')}: ${String(verdict['verifier'] ?? 'a verifier')} refutes the root cause "${String(verdict['claim'] ?? '?')}" — ${String(verdict['because'] ?? 'no reason given')}`,
        [`log#${String(verdict.seq)}`]
      )
    )
  }

  // An obligation the company owes and cannot meet is a health fact, not a
  // silence. Today this is only the severity-1 announcement the deferred
  // Herald cannot make (M6.9) — the standup is where the Architect finds out
  // that the spoken alarm they were promised did not happen.
  for (const owed of incidents(input.events, 'incident-announce-owed')) {
    facts.push(
      fact(
        'health',
        `incident ${String(owed['incident'] ?? '?')} owed an immediate spoken announcement that could not be made`,
        [`log#${String(owed.seq)}`]
      )
    )
  }

  // 4b. The Gymnasium slice (FR-12.5): improvement is budgeted, not ambient,
  //     and the standup is where the budget is seen.
  if (input.gymSlice !== undefined) {
    facts.push(
      fact(
        'health',
        input.gymSlice.spentTokens === null
          ? `the gymnasium's spend is not yet attributed (slice: ` +
              `${String(input.gymSlice.tokensPerWeek)} tokens/week), with ` +
              `${String(input.gymSlice.open)} proposal(s) open`
          : `the gymnasium has spent ${String(input.gymSlice.spentTokens)} of ` +
              `${String(input.gymSlice.tokensPerWeek)} tokens this week, with ` +
              `${String(input.gymSlice.open)} proposal(s) open` +
              (input.gymSlice.spendSource ? ` (${input.gymSlice.spendSource})` : ''),
        ['gym:slice']
      )
    )
    // FR-13.6: Stoa work is reported with the slice it is spent from.
    if (input.gymSlice.stoa !== undefined) {
      facts.push(
        fact(
          'health',
          `the stoa is watching ${String(input.gymSlice.stoa.sources)} source(s) ` +
            `and has archived ${String(input.gymSlice.stoa.briefs)} brief(s)`,
          ['stoa:watchlist']
        )
      )
    }
    // FR-14.1: every standup states the mode the company is running under, so
    // "did we do this because we were asked?" is answerable from the brief.
    if (input.gymSlice.mode !== undefined) {
      facts.push(fact('health', `the company is in ${input.gymSlice.mode} mode`, ['gym:mode']))
    }
  }

  // 5. Ahead — what the company will do next, per the ledger.
  for (const task of ahead.slice(0, 3)) {
    facts.push(fact('ahead', `${task.id} (${task.status}): ${task.title}`, [`task:${task.id}`]))
  }
  if (ahead.length > 3) {
    facts.push(
      fact('ahead', `and ${String(ahead.length - 3)} more queued`, refsOfTasks(ahead.slice(3)))
    )
  }

  return facts
}

function fact(section: BriefSection, what: string, refs: readonly string[]): BriefFact {
  return { section, what, refs }
}

function refsOfTasks(tasks: readonly Task[]): readonly string[] {
  return tasks.map((task) => `task:${task.id}`)
}

/**
 * Incident entries of one event kind, oldest first (SDD §4.3's `profile` kind).
 *
 * Matched on the recorded `event` tag rather than on the message text, so a
 * reworded log line cannot silently drop the standup's only account of an
 * incident.
 */
function incidents(
  events: readonly LogEntry[],
  event:
    | 'incident-raised'
    | 'incident-triaged'
    | 'incident-announce-owed'
    | 'incident-root-cause-verdict'
): readonly LogEntry[] {
  return events.filter((entry) => entry.kind === 'profile' && entry['event'] === event)
}

/** One narrated sentence and the facts it rests on. */
export const briefSentenceSchema = z
  .object({
    section: briefSectionSchema,
    text: z.string().min(1).max(1_000),
    /** At least one: a sentence with no ref is exactly what S-BRIEF forbids. */
    refs: z.array(z.string().min(1).max(128)).min(1).max(32)
  })
  .strict()

export const briefFilingSchema = z
  .object({
    schemaVersion: z.literal(BRIEF_SCHEMA_VERSION),
    kind: z.literal('brief'),
    /** The window this narrates — the compiler minted it with the facts. */
    briefId: z.string().min(1).max(64),
    sentences: z.array(briefSentenceSchema).min(1).max(200)
  })
  .strict()

export type BriefFiling = z.infer<typeof briefFilingSchema>

export type BriefParse =
  | { readonly ok: true; readonly filing: BriefFiling }
  | { readonly ok: false; readonly reason: string }

/** Contract: parses a narration, or explains why it could not. Never throws. */
export function parseBriefFiling(body: string): BriefParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return { ok: false, reason: `brief: body is not JSON — ${reason(err)}` }
  }
  const parsed = briefFilingSchema.safeParse(raw)
  if (parsed.success) return { ok: true, filing: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'brief'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid brief'}` }
}

export interface NarrativeCheck {
  readonly ok: boolean
  readonly reasons: readonly string[]
  readonly spokenSeconds: number
}

/**
 * Contract: does this narration rest entirely on facts the compiler issued?
 *
 * **S-BRIEF's core.** Three ways to fail, and each is the same failure wearing
 * different clothes — a claim the Architect cannot check:
 *
 * 1. a sentence carrying no ref at all (the schema already refuses this, so it
 *    is belt-and-braces for a filing built some other way);
 * 2. a sentence carrying a ref that no fact issued — an invented citation is
 *    worse than none, because it looks checked;
 * 3. a narration over the spoken-length budget, which is not a truth failure
 *    but is the one SRS §6.2 measures.
 *
 * What it deliberately does NOT check is whether the prose is any good. That is
 * Artemis's job and nobody else's.
 */
export function checkNarrative(
  filing: BriefFiling,
  facts: readonly BriefFact[],
  options: { readonly wpm?: number; readonly maxSeconds?: number } = {}
): NarrativeCheck {
  const issued = new Set(facts.flatMap((entry) => entry.refs))
  const reasons: string[] = []

  for (const sentence of filing.sentences) {
    if (sentence.refs.length === 0) {
      reasons.push(`a ${sentence.section} sentence carries no source ref`)
      continue
    }
    const unknown = sentence.refs.filter((ref) => !issued.has(ref))
    if (unknown.length > 0) {
      reasons.push(
        `"${sentence.text.slice(0, 60)}" cites ${unknown.join(', ')}, which no fact supports`
      )
    }
  }

  const seconds = spokenSeconds(
    filing.sentences.map((sentence) => sentence.text).join(' '),
    options.wpm ?? BRIEF_WPM
  )
  const max = options.maxSeconds ?? BRIEF_MAX_SECONDS
  if (seconds > max) {
    reasons.push(
      `the brief runs ${String(Math.round(seconds))}s spoken; the budget is ${String(max)}s`
    )
  }

  return { ok: reasons.length === 0, reasons, spokenSeconds: seconds }
}

/**
 * Contract: how long this text takes to say, in seconds, at `wpm`.
 *
 * Word-count math rather than a synthesis round-trip: the budget has to be
 * checkable before the Herald exists (M6) and without spending a TTS call to
 * find out a brief is too long.
 */
export function spokenSeconds(text: string, wpm: number = BRIEF_WPM): number {
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
  return (words / wpm) * 60
}

/**
 * Contract: the archived artifact — the narration followed by the refs that
 * back it (SDD §2's `briefs/<ts>.md (+ source refs)`).
 *
 * The refs appendix is not decoration: it is what makes the archive auditable
 * a month later, when the log has grown past the window this brief described.
 */
export function renderBriefMarkdown(
  briefId: string,
  filing: BriefFiling,
  facts: readonly BriefFact[],
  at: string
): string {
  const lines: string[] = [
    `# Standup brief ${briefId}`,
    '',
    `- brief: ${briefId}`,
    `- at: ${at}`,
    ''
  ]
  for (const section of BRIEF_SECTIONS) {
    const said = filing.sentences.filter((sentence) => sentence.section === section)
    if (said.length === 0) continue
    lines.push(`## ${section}`, '')
    for (const sentence of said) {
      lines.push(`${sentence.text} [${sentence.refs.join(', ')}]`)
    }
    lines.push('')
  }
  lines.push('## Source refs', '')
  for (const entry of facts) {
    lines.push(`- ${entry.section}: ${entry.what} [${entry.refs.join(', ')}]`)
  }
  lines.push('')
  return lines.join('\n')
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
