import { z } from 'zod'

/**
 * Artemis's delegated-authority table (FR-5.5, ADR-0005).
 *
 * ADR-0005's whole shape is *mechanism in the harness, intelligence in the
 * prompt* — so this file is deliberately small. It does not decide anything;
 * it answers one question, "may Artemis settle this herself, or does it go to
 * the Architect?", from a table the Architect writes. What Artemis then decides
 * is Artemis's, and lives in `prompts/artemis/`.
 *
 * Two rules give the table its safety:
 *
 *  - **Absent means none.** A missing or unreadable table delegates nothing,
 *    exactly as a missing `gate-policy.json` denies everything (SDD §9). A
 *    file the harness cannot read must never be the reason authority widened.
 *  - **Everything decided under it is countersigned** (FR-5.5). The permission
 *    and the record are the same call, so there is no path that grants
 *    authority without leaving the Architect something to audit.
 */

export const AUTHORITY_SCHEMA_VERSION = 1

/**
 * The classes of decision that can be delegated. Grounded in what the company
 * actually does rather than invented: routing and task decisions exist now
 * (ADR-0003, SDD §4.2), gates and spend are the Watch's (ADR-0011, ADR-0012),
 * and memos arrive with the Odeon (ADR-0008) — named here so the table an
 * Architect writes today does not have to be rewritten then.
 */
export const AUTHORITY_CLASSES = ['route', 'task', 'gate', 'spend', 'memo'] as const

export const authorityClassSchema = z.enum(AUTHORITY_CLASSES)

export type AuthorityClass = z.infer<typeof authorityClassSchema>

/** Matches every domain. FR-5.5's authority is *per domain*, so this is opt-in breadth. */
export const ANY_DOMAIN = '*'

const domainSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(\*|[a-z0-9][a-z0-9-]*)$/, 'a domain tag, e.g. `test-code`, or `*`')

export const authorityRuleSchema = z
  .object({
    class: authorityClassSchema,
    /**
     * Domains this rule covers — FR-5.5's "per domain" axis, e.g. `test-code`,
     * `docs`, `infra`. Defaults to nothing rather than to everything: a rule
     * that forgot its domains should grant no authority, not universal
     * authority.
     */
    domains: z.array(domainSchema).min(1).max(32),
    /**
     * Token ceiling for a `spend` rule. Required there and refused elsewhere
     * (see the refinements): delegating spend without a number is the one
     * mistake in this file that costs money, and FR-5.5 names spend as the
     * example of what Artemis may *not* have by default.
     */
    maxSpendTokens: z.number().int().positive().max(1_000_000_000).optional()
  })
  .strict()

export type AuthorityRule = z.infer<typeof authorityRuleSchema>

export const authorityTableSchema = z
  .object({
    schemaVersion: z.literal(AUTHORITY_SCHEMA_VERSION),
    /** Every rule GRANTS; there is no deny rule, because the default is deny. */
    grants: z.array(authorityRuleSchema).max(64)
  })
  .strict()
  .refine((table) => table.grants.every((rule) => rule.class !== 'spend' || rule.maxSpendTokens), {
    message: 'a spend grant must carry maxSpendTokens',
    path: ['grants']
  })
  .refine((table) => table.grants.every((rule) => rule.class === 'spend' || !rule.maxSpendTokens), {
    message: 'maxSpendTokens applies to a spend grant only',
    path: ['grants']
  })
  .refine(
    (table) => new Set(table.grants.map(ruleKey)).size === table.grants.length,
    // Two rules for one (class, domain) is an Architect who wrote the second
    // expecting it to replace the first. Refusing says so; silently picking one
    // would not (the same call M3.3 made for gate rules).
    { message: 'two grants cover the same class and domain', path: ['grants'] }
  )

export type AuthorityTable = z.infer<typeof authorityTableSchema>

function ruleKey(rule: AuthorityRule): string {
  return `${rule.class}:${[...rule.domains].sort().join(',')}`
}

/** What Artemis holds when there is no readable table: nothing. */
export const noAuthority: AuthorityTable = {
  schemaVersion: AUTHORITY_SCHEMA_VERSION,
  grants: []
}

/**
 * The delegated authority Artemis ships with (M8.4).
 *
 * `authority.json` has never existed on any install, and an absent table means
 * `noAuthority` — so on every Ephesus that has ever run, the orchestrator held
 * nothing and every routine decision queued for the Architect. FR-5.5 is not a
 * feature that was switched off; it was a feature nobody could reach.
 *
 * The grants below are FR-5.5's own example, read literally:
 *
 * - `route` and `task` on every domain, because that IS the orchestrator's job
 *   (FR-5.1, FR-5.2). She routes work and proposes tasks; the harness never
 *   writes `tasks.json` itself, so withholding these leaves nobody to do it.
 * - `memo` on `test-code` and `docs` — "may approve memos touching test code"
 *   is the requirement's worked example, and docs sit at the same blast radius.
 * - `gate` is NOT granted. A gate is the Watch's question to a human; an
 *   orchestrator who could answer it would be answering on the Architect's
 *   behalf about the classes the Watch holds precisely because they are theirs.
 * - `spend` is NOT granted. FR-5.5 names it as the example of what Artemis may
 *   *not* have by default, and it is the one class here that costs money.
 *
 * Everything she decides under these is countersigned and archived (FR-5.5), so
 * widening the table never costs the Architect the audit trail.
 *
 * A value rather than a JSON file, so it cannot drift from the schema it must
 * satisfy; `home.ts` seeds it and a test parses it.
 */
export const shippedAuthority: AuthorityTable = authorityTableSchema.parse({
  schemaVersion: AUTHORITY_SCHEMA_VERSION,
  grants: [
    { class: 'route', domains: [ANY_DOMAIN] },
    { class: 'task', domains: [ANY_DOMAIN] },
    { class: 'memo', domains: ['test-code', 'docs'] }
  ]
})

export type AuthorityParse =
  | { readonly ok: true; readonly table: AuthorityTable }
  | { readonly ok: false; readonly reason: string }

/** Contract: parses a table, naming the reason on failure so the UI can show it. */
export function parseAuthorityTable(raw: unknown): AuthorityParse {
  const parsed = authorityTableSchema.safeParse(raw)
  if (parsed.success) return { ok: true, table: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'authority'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid authority table'}` }
}

export interface AuthorityRequest {
  readonly class: AuthorityClass
  /** What this decision is about, e.g. `test-code`. Unknown domains are refused. */
  readonly domain: string
  /** Tokens at stake, for a `spend` decision. */
  readonly spendTokens?: number
}

/**
 * FR-5.5's countersignature: what Artemis decided, under which grant, and when.
 *
 * The archive it is filed into is the Odeon's (M5); what M3 owes is that no
 * decision can be taken under delegated authority *without* one, which is why
 * `mayDecide` returns it rather than offering it separately.
 */
export interface Countersignature {
  readonly by: string
  readonly class: AuthorityClass
  readonly domain: string
  readonly at: string
  /** The grant relied on, as written — so an audit can find the rule again. */
  readonly under: string
}

export type AuthorityVerdict =
  | { readonly allowed: true; readonly countersignature: Countersignature }
  | { readonly allowed: false; readonly because: string }

export interface AuthorityContext {
  readonly orchestratorId: string
  readonly at: string
}

/**
 * Contract: whether Artemis may settle this herself.
 *
 * Deny by default, and deny on anything ambiguous: no table, no matching
 * grant, an unknown domain, a spend over the ceiling, or a spend with no
 * amount named. An escalation costs the Architect a notification; a wrongly
 * delegated decision costs them the audit trail they were promised.
 */
export function mayDecide(
  table: AuthorityTable,
  request: AuthorityRequest,
  ctx: AuthorityContext
): AuthorityVerdict {
  const matches = table.grants.filter(
    (rule) =>
      rule.class === request.class &&
      (rule.domains.includes(request.domain) || rule.domains.includes(ANY_DOMAIN))
  )
  if (matches.length === 0) {
    return {
      allowed: false,
      because: `no delegated authority for ${request.class}/${request.domain}`
    }
  }
  // A specific domain grant is what an Architect wrote to be specific; when both
  // a specific and a wildcard grant match, the specific one is the rule relied
  // on, and it is the one the countersignature names.
  const rule = matches.find((candidate) => candidate.domains.includes(request.domain)) ?? matches[0]
  if (!rule) {
    return {
      allowed: false,
      because: `no delegated authority for ${request.class}/${request.domain}`
    }
  }

  if (rule.class === 'spend') {
    const ceiling = rule.maxSpendTokens
    if (ceiling === undefined) {
      return { allowed: false, because: 'spend grant carries no ceiling' }
    }
    if (request.spendTokens === undefined) {
      // "How much?" unanswered is not a small spend; it is an unknown one.
      return { allowed: false, because: 'spend decision names no amount' }
    }
    if (request.spendTokens > ceiling) {
      return {
        allowed: false,
        because: `spend of ${request.spendTokens} exceeds the delegated ceiling of ${ceiling}`
      }
    }
  }

  return {
    allowed: true,
    countersignature: {
      by: ctx.orchestratorId,
      class: request.class,
      domain: request.domain,
      at: ctx.at,
      under: ruleKey(rule)
    }
  }
}
