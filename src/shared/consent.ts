import { z } from 'zod'
import { SUGGESTED_DAILY_TOKENS } from './gates'

/**
 * First-launch consent (DD-6, M8.12) — whether the company may start working.
 *
 * ## Why this exists
 *
 * Until M8.12 boot hired the orchestrator unconditionally and started the
 * trigger clock sixty seconds behind it. A stranger who cloned the repository
 * and ran `npm run dev` had an agent hired on their own subscription before
 * they had read a single sentence of the app, and `triggers.json` on the
 * Architect's own machine showed `standup`, `retro` and `gym-metric-check`
 * sharing one timestamp — the first tick fires all three together.
 *
 * That is what M8's exit measures: a developer who is not the author, from a
 * clean clone, following only the README. Their first thirty seconds cannot be
 * "something already started spending money".
 *
 * ## The decision is pure, and it lives here
 *
 * `index.ts` boot wiring has produced three dead-code findings in this
 * repository's history (the Herald, M7.2's inert trigger, M7.7's silent
 * standup), every one of them behind a green suite. So the *decision* is a pure
 * function a unit test can drive in all four directions, and `index.ts` keeps
 * only the call.
 *
 * ## Absent means ASK
 *
 * `ensureHarnessHome` seeds a file only when it is ABSENT, deliberately —
 * `~/.ephesus/` is the Architect's copy and the harness must never overwrite a
 * decision they made. The consequence bit for real on 2026-09-07: the
 * Architect's `gate-policy.json` predated DD-1 by three days and was silently
 * looser in three places for that whole time, because a decision never reaches
 * a machine that was set up before it.
 *
 * A consent record has exactly that shape. EVERY existing install has none, so
 * `undefined` must read as "ask" — never as "assume yes" (which would make the
 * gate a no-op on every machine that matters) and never as "assume no forever"
 * (which would be a refusal nobody could lift). A record is written only when
 * the Architect grants; a decline is simply the absence of one, because the
 * withheld state IS the question and it stays on screen until it is answered.
 */

/**
 * Which disclosure the Architect agreed to.
 *
 * Recorded rather than assumed, for the reason above one more time: if what
 * consent COVERS ever widens, a grant made against the narrower text must not
 * silently authorise the wider one. Bumping this asks again; leaving it alone
 * never does.
 */
export const CONSENT_TERMS_VERSION = 2

export const consentRecordSchema = z
  .object({
    /** ISO-8601 instant the Architect granted it. Recorded, never inferred. */
    grantedAt: z.string().min(1).max(64),
    /** The `CONSENT_TERMS_VERSION` the grant was made against. */
    terms: z.number().int().min(1).max(1_000_000)
  })
  .strict()

export type ConsentRecord = z.infer<typeof consentRecordSchema>

/**
 * What the window sends when the Architect says go (M8c.3).
 *
 * `unbudgeted` defaults to `false` rather than being optional-and-ignored: a
 * renderer that sent nothing is a renderer that has not answered the ceiling
 * question, and the safe reading of an unanswered question is that it is
 * unanswered.
 */
export const consentGrantPayloadSchema = z
  .object({ unbudgeted: z.boolean().default(false) })
  .strict()

/**
 * Why the company is or is not working.
 *
 * Three states rather than a boolean, because the Architect acts differently on
 * each: nobody has been asked yet, the terms moved under a grant that already
 * exists, or it is granted and work may begin.
 */
export type ConsentState = 'never-asked' | 'stale-terms' | 'granted'

export interface ConsentVerdict {
  readonly state: ConsentState
  /** The single question boot asks. */
  readonly mayStartWork: boolean
  /** Said in the Architect's words, because a refusal must teach the rule. */
  readonly because: string
}

/**
 * Contract: pure. Given the record from `config.json` (or `undefined` when
 * there is none) and the terms this build ships, says whether the company may
 * start working and why.
 *
 * Never throws: an absent record is the ordinary first-launch case, not an
 * error, and a malformed one never reaches here — `configSchema` is strict, so
 * a `config.json` the validator rejects falls back to `defaultConfig`, which
 * carries no consent. Corrupt therefore reads as `never-asked`, which is the
 * only safe direction for a gate: a damaged file must never grant anything.
 */
export function decideConsent(
  record: ConsentRecord | undefined,
  termsVersion: number = CONSENT_TERMS_VERSION
): ConsentVerdict {
  if (record === undefined) {
    return {
      state: 'never-asked',
      mayStartWork: false,
      because:
        'nobody has said go on this machine yet — the company hires nobody and ' +
        'arms no schedule until you do'
    }
  }
  if (record.terms < termsVersion) {
    return {
      state: 'stale-terms',
      mayStartWork: false,
      because:
        `the consent on file covers an older disclosure (v${String(record.terms)}, granted ` +
        `${record.grantedAt}); what the company would do has changed since, so it waits ` +
        `for v${String(termsVersion)}`
    }
  }
  return {
    state: 'granted',
    mayStartWork: true,
    because: `granted ${record.grantedAt}`
  }
}

/** One cadence that arms when consent is granted. */
export interface ConsentTrigger {
  readonly id: string
  readonly everyMs: number
}

/**
 * What actually happens if consent is granted, read off the running
 * configuration rather than written down.
 *
 * Every field here is a FACT the main process already holds. A consent screen
 * whose promises were prose in a component would be a promise that drifts the
 * first time a trigger is added — and a consent obtained against a stale
 * description is not consent.
 */
export interface ConsentDisclosure {
  /** The orchestrator that gets hired, or null when no engine is registered. */
  readonly hire: { readonly agentId: string; readonly engine: string } | null
  /** The cadences whose clock starts. */
  readonly triggers: readonly ConsentTrigger[]
  /** The company-wide daily token ceiling (ADR-0029), or null for unbudgeted. */
  readonly dailyCeiling: number | null
}

/** What the renderer shows, and the only consent state that crosses IPC. */
export interface ConsentView {
  readonly state: ConsentState
  readonly mayStartWork: boolean
  readonly because: string
  /** The terms this build asks about. */
  readonly terms: number
  /** When the standing grant was made, or null when there is none. */
  readonly grantedAt: string | null
  readonly disclosure: ConsentDisclosure
}

/**
 * What a grant did. `{ ok, reason }` is this repository's outcome shape, and
 * the view rides along so the window that asked does not have to re-read it and
 * risk rendering a state main has already moved past.
 */
export interface ConsentGrantOutcome {
  readonly ok: boolean
  /** Why it was refused, or null when it succeeded. */
  readonly reason: string | null
  readonly view: ConsentView
}

/**
 * Contract: pure. Why a grant cannot be made yet, or null when it can (M8c.3).
 *
 * **Silence is not an answer about spend.** `unbudgeted` is the shipped default
 * (ADR-0029) and stays it — what changes here is that a company may not START
 * on it by omission. `EXIT-M8.md` §2 calls setting a ceiling *"the step that is
 * skipped and then regretted"*, and it was skipped on both real runs precisely
 * because it was optional: 2026-09-09 spent $11.22 and the M8b rehearsal $17.77,
 * neither bounded by anything.
 *
 * The Architect may still run unbudgeted, and often should — it is the right
 * answer for a company doing one small thing. It just has to be an ANSWER.
 * `acceptUnbudgeted` is that answer, and it is deliberately not a default
 * parameter: a caller that forgets it gets the refusal, not the permission.
 *
 * This is `decideConsent`'s sibling and not part of it, for the reason
 * ADR-0034's occupancy guard is also separate: consent is a standing answer
 * about what the company may do, and this is a condition of the configuration
 * right now. Collapsing them would make an unbudgeted company read as one
 * nobody has said go to.
 */
export function budgetAnswerMissing(
  disclosure: ConsentDisclosure,
  acceptUnbudgeted: boolean
): string | null {
  if (disclosure.dailyCeiling !== null || acceptUnbudgeted) return null
  return (
    'there is no daily token ceiling, and starting without answering that is the step ' +
    'that gets skipped and then regretted — two real runs went out unbudgeted and cost ' +
    `$11.22 and $17.77. Set one: \`ephctl budget:set --daily ${SUGGESTED_DAILY_TOKENS}\`, ` +
    'or WATCH → settings → Daily budget — the figure is PER HIRE, and the agents on those ' +
    'runs spent 4.9M to 16M tokens each. To run without a ceiling on purpose, say so: ' +
    '`ephctl consent:grant --unbudgeted true`.'
  )
}

/** "every 30 minutes" — coarse on purpose; this is a disclosure, not a clock. */
export function everyPhrase(everyMs: number): string {
  const minutes = Math.round(everyMs / 60_000)
  if (minutes < 1) return 'more than once a minute'
  if (minutes < 60) return `every ${String(minutes)} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `every ${String(hours)} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `every ${String(days)} day${days === 1 ? '' : 's'}`
}

/**
 * Contract: pure. The specific sentences a consent screen must show, built from
 * the disclosure so they cannot promise something the build does not do.
 *
 * Specific is the requirement, not thorough: "an agent is hired", "it spends
 * tokens on YOUR subscription", "these clocks start". A consent screen that
 * said "Ephesus will begin operating" would be technically true and would tell
 * the Architect nothing they could refuse on.
 *
 * The absence of a ceiling is stated OUT LOUD rather than omitted. `unbudgeted`
 * is the shipped default (ADR-0029) and it is exactly the fact a person
 * granting spend authority needs; leaving the line out when there is no limit
 * would make the most permissive configuration the quietest one.
 */
export function consentSentences(disclosure: ConsentDisclosure): readonly string[] {
  const lines: string[] = []
  lines.push(
    disclosure.hire === null
      ? 'No orchestrator would be hired — no engine this build ships is registered, ' +
          'so the company would come up with nobody in it.'
      : `${disclosure.hire.agentId} is hired on the ${disclosure.hire.engine} CLI, as a real ` +
          'process on this machine, under your own logged-in account.'
  )
  lines.push(
    'Her turns spend tokens against YOUR subscription. Ephesus never buys anything ' +
      'and holds no billing relationship of its own.'
  )
  lines.push(
    disclosure.dailyCeiling === null
      ? 'There is NO daily token ceiling. Set one before you say go — ' +
          `\`ephctl budget:set --daily ${SUGGESTED_DAILY_TOKENS}\`, or WATCH → settings → ` +
          'Daily budget — or choose to run unbudgeted on purpose. The figure is PER HIRE. ' +
          'Starting is refused until you answer one way or the other.'
      : `Spending stops at ${disclosure.dailyCeiling.toLocaleString('en-US')} tokens a day ` +
          'per hire.'
  )
  lines.push(
    disclosure.triggers.length === 0
      ? 'No scheduled work is armed.'
      : `These clocks start: ${disclosure.triggers
          .map((trigger) => `${trigger.id} (${everyPhrase(trigger.everyMs)})`)
          .join(', ')}. The first tick is one minute after you grant this.`
  )
  lines.push('You can stop the company at any time; this is asked once and remembered.')
  return lines
}
