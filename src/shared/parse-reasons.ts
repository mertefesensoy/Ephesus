import type { z } from 'zod'

/**
 * How a schema refusal is WORDED (invariant §8 — the words are a prompt
 * surface, because an agent is the one who reads them).
 *
 * Every parser in `src/shared/` turns a Zod error into `<path>: <message>`, and
 * for most issues that reads well: `severity: Invalid input` tells an agent
 * exactly which field to fix. It reads badly for exactly one family — the size
 * bounds — and that family is where a real day of work was thrown away.
 *
 * On the Architect's machine every root-cause verdict the company ever received
 * was refused, all three of them, with:
 *
 * ```text
 * because: Too big: expected string to have <=2000 characters
 * ```
 *
 * Three things are wrong with that sentence and only the first is cosmetic. It
 * is schema-speak rather than an instruction. It does not say how long the
 * answer actually WAS, so a verifier cannot tell whether it overran by fifty
 * characters or by four thousand. And "expected" describes the schema's wish
 * rather than the agent's file, when the useful fact is the comparison between
 * the two.
 *
 * So the size issues — and only the size issues — are re-worded here against
 * the value that was actually sent. Everything else keeps the message Zod
 * wrote, because a checker that paraphrases every refusal is a second place
 * refusals can drift from the schema that produces them.
 */

/** The field's own name, or the whole document when the issue is at the root. */
function pathOf(issue: z.core.$ZodIssue, subject: string): string {
  return issue.path.length > 0 ? issue.path.join('.') : subject
}

/**
 * Walks an issue's path into the value that was actually parsed.
 *
 * The raw value rather than `issue.input`: `input` is present on some issue
 * paths and absent on others depending on how the failure was reached, and a
 * measurement that silently stops being available is the sort of check that
 * quietly cannot fail. The path is the same one the message names, so a reader
 * comparing the two is comparing one thing.
 */
function at(raw: unknown, path: readonly PropertyKey[]): unknown {
  let cursor = raw
  for (const step of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<PropertyKey, unknown>)[step]
  }
  return cursor
}

/** What the agent actually sent, in the unit the bound is expressed in. */
function measure(value: unknown): { readonly size: number; readonly unit: string } | null {
  if (typeof value === 'string') return { size: value.length, unit: 'characters' }
  if (Array.isArray(value)) return { size: value.length, unit: 'items' }
  return null
}

/**
 * Contract: pure. One reason line per issue, sized against `raw`.
 *
 * `subject` names the document for an issue with no path ("triage report",
 * "root-cause verdict"), matching what each parser already said.
 */
export function reasonsFor(error: z.ZodError, subject: string, raw: unknown): readonly string[] {
  return error.issues.map((issue) => {
    const where = pathOf(issue, subject)
    if (issue.code === 'too_big' && typeof issue.maximum === 'number') {
      const sent = measure(at(raw, issue.path))
      const limit = `the limit is ${String(issue.maximum)}`
      return sent === null
        ? `${where}: over the limit — ${limit}`
        : `${where}: ${String(sent.size)} ${sent.unit}, and ${limit}`
    }
    if (issue.code === 'too_small' && typeof issue.minimum === 'number') {
      const sent = measure(at(raw, issue.path))
      const least = `at least ${String(issue.minimum)} is required`
      return sent === null
        ? `${where}: under the minimum — ${least}`
        : `${where}: ${String(sent.size)} ${sent.unit}, and ${least}`
    }
    return `${where}: ${issue.message}`
  })
}
