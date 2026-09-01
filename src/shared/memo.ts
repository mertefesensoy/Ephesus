import { z } from 'zod'
import { agentIdSchema } from './agents'
import { taskIdSchema } from './tasks'

/**
 * Decision memos (ADR-0008 §3, FR-7.3, SDD §4.5, §7.3, UC-06).
 *
 * The mechanism, stated plainly because it is the whole point: **a choice that
 * matches memo policy is HELD until a memo exists and has a verdict.** ADR-0008
 * rejects prompt-only convention outright — "please write a memo when…" fails
 * silently under exactly the pressure that makes memos matter. So the trigger
 * is matched by the harness, the hold is a gate, and the release is a verdict.
 *
 * The four triggers are the four the documents name and no others. ADR-0008
 * calls memo-policy granularity the tuning knob (too broad and agents drown in
 * paperwork), so inventing a fifth here would be turning a knob the Architect
 * owns.
 */

export const MEMO_SCHEMA_VERSION = 1

export const MEMO_TRIGGERS = [
  'new-dependency',
  'api-or-schema-change',
  'security-posture',
  'spend'
] as const

export const memoTriggerSchema = z.enum(MEMO_TRIGGERS)

export type MemoTrigger = z.infer<typeof memoTriggerSchema>

/**
 * The five sections SDD §4.5 names, in order. `options` is a list because
 * ADR-0008 requires **at least two** — a memo with one option is a decision
 * already taken wearing a memo's clothes.
 */
export const MEMO_SECTIONS = [
  'context',
  'options',
  'recommendation',
  'blastRadius',
  'rollback'
] as const

export const memoIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^m-[a-z0-9-]+$/, 'memo id: "m-" followed by lowercase alphanumerics and dashes')

export const memoFilingSchema = z
  .object({
    schemaVersion: z.literal(MEMO_SCHEMA_VERSION),
    kind: z.literal('memo'),
    /** The gate this memo answers — what was held pending it. */
    gateId: z.string().min(1).max(64),
    trigger: memoTriggerSchema,
    /**
     * One line, and the constraint is load-bearing rather than cosmetic.
     *
     * The title is agent-authored and `renderMemoMarkdown` puts it ABOVE the
     * machine header, while `parseMemoHeader` took the first line that matched.
     * A title carrying newlines therefore wrote the header: an agent could name
     * another agent's gate and have its own countersigned verdict release a hold
     * nobody had been shown, or name a different trigger and have FR-5.5's audit
     * trail record an authority domain the decision never touched.
     */
    title: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/, 'a memo title is one line'),
    context: z.string().min(1).max(20_000),
    /** ADR-0008: at least two. One option is not a choice. */
    options: z.array(z.string().min(1).max(10_000)).min(2).max(10),
    recommendation: z.string().min(1).max(10_000),
    blastRadius: z.string().min(1).max(10_000),
    rollback: z.string().min(1).max(10_000),
    /** The ledger task this choice arose in, when there is one. */
    taskId: taskIdSchema.nullable()
  })
  .strict()

export type MemoFiling = z.infer<typeof memoFilingSchema>

export const MEMO_VERDICTS = ['approved', 'rejected', 'amended'] as const

export const memoVerdictNameSchema = z.enum(MEMO_VERDICTS)

export type MemoVerdictName = z.infer<typeof memoVerdictNameSchema>

/**
 * SDD §4.5's `verdict.json`, verbatim in its fields.
 *
 * `countersigned` is not decoration: FR-5.5 requires that no decision taken
 * under delegated authority exists without one, so a verdict decided by the
 * orchestrator with `countersigned: false` is refused by the validator below
 * rather than merely frowned upon.
 */
export const memoVerdictSchema = z
  .object({
    schemaVersion: z.literal(MEMO_SCHEMA_VERSION),
    memoId: memoIdSchema,
    trigger: memoTriggerSchema,
    verdict: memoVerdictNameSchema,
    /** An agent id (the orchestrator) or the Architect. */
    decidedBy: z.union([agentIdSchema, z.literal('architect')]),
    countersigned: z.boolean(),
    /** The grant relied on, e.g. `delegated:test-code`; null for the Architect. */
    authority: z.string().min(1).max(128).nullable(),
    notes: z.string().max(10_000),
    decidedAt: z.string().min(1).max(64),
    taskId: taskIdSchema.nullable()
  })
  .strict()
  .refine((verdict) => verdict.decidedBy === 'architect' || verdict.countersigned, {
    message: 'a delegated verdict must be countersigned (FR-5.5)'
  })
  .refine((verdict) => verdict.decidedBy === 'architect' || verdict.authority !== null, {
    message: 'a delegated verdict must name the grant it was taken under (FR-5.5)'
  })

export type MemoVerdict = z.infer<typeof memoVerdictSchema>

export type MemoParse =
  | { readonly ok: true; readonly filing: MemoFiling }
  | { readonly ok: false; readonly reason: string }

/** Contract: parses a memo filing, or explains why it could not. Never throws. */
export function parseMemoFiling(body: string): MemoParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return { ok: false, reason: `memo: body is not JSON — ${reason(err)}` }
  }
  const parsed = memoFilingSchema.safeParse(raw)
  if (parsed.success) return { ok: true, filing: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'memo'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid memo filing'}` }
}

/**
 * What an agent is about to do, in the terms the policy matches on.
 *
 * Deliberately small: the trigger table reads a tool name and the path or text
 * it touches, which is exactly what the event plane already carries (ADR-0002).
 * Anything richer would need the harness to understand the agent's work.
 */
export interface MemoAction {
  readonly tool: string
  /** File the action touches, if any — POSIX or Windows separators. */
  readonly path?: string
  /** The command or payload text, for the matchers that read it. */
  readonly text?: string
  /** Tokens at stake, for the spend trigger. */
  readonly spendTokens?: number
}

export interface MemoPolicy {
  /** Spend at or above this many tokens needs a memo. */
  readonly spendTokens: number
}

export const DEFAULT_MEMO_POLICY: MemoPolicy = { spendTokens: 100_000 }

/** Files whose edit means "the dependency set changed". */
const MANIFESTS = [
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'gemfile',
  'pom.xml',
  'build.gradle'
]

/** Install verbs, matched against a command's text. */
const INSTALLERS = [
  'npm install',
  'npm i ',
  'yarn add',
  'pnpm add',
  'pip install',
  'cargo add',
  'go get',
  'gem install'
]

/** Files whose edit changes a published contract. */
const CONTRACTS = ['openapi', 'schema.prisma', '.proto', 'migrations/', 'schema.sql']

/** Files and text that move the security posture. */
const SECURITY = [
  'settings.local.json',
  '.env',
  'dockerfile',
  'nginx.conf',
  'authn',
  'authz',
  'permissions'
]

/**
 * Contract: the memo trigger this action matches, or null.
 *
 * Pure and table-driven, so S-MEMO asserts it at the module boundary. Matching
 * is deliberately conservative on the *text* side and generous on the *path*
 * side: a false positive costs one memo, and a false negative is a dependency
 * that landed with nobody's signature on it.
 *
 * Order matters where an action could match twice — `security-posture` is
 * checked before the contract triggers, because "this also changes auth" is the
 * more consequential framing to put in front of a reviewer.
 */
export function matchMemoTrigger(
  action: MemoAction,
  policy: MemoPolicy = DEFAULT_MEMO_POLICY
): MemoTrigger | null {
  if (action.spendTokens !== undefined && action.spendTokens >= policy.spendTokens) {
    return 'spend'
  }

  const file = (action.path ?? '').replace(/\\/g, '/').toLowerCase()
  const base = file.slice(file.lastIndexOf('/') + 1)
  const text = (action.text ?? '').toLowerCase()

  if (
    SECURITY.some((needle) => base === needle || file.includes(needle) || text.includes(needle))
  ) {
    return 'security-posture'
  }
  if (MANIFESTS.includes(base) || INSTALLERS.some((verb) => text.includes(verb))) {
    return 'new-dependency'
  }
  if (CONTRACTS.some((needle) => file.includes(needle))) {
    return 'api-or-schema-change'
  }
  return null
}

/**
 * Contract: renders a filing as the markdown SDD §4.5 stores at
 * `odeon/memos/<memoId>/memo.md`.
 *
 * The headings are structure, not prose — they are the section names the schema
 * already enforces, so this is serialization rather than a prompt surface. The
 * words an *agent* reads live in `prompts/odeon/`.
 */
export function renderMemoMarkdown(memoId: string, filing: MemoFiling, at: string): string {
  const options = filing.options.map((option, index) => `${index + 1}. ${option}`).join('\n')
  return [
    `# ${filing.title}`,
    '',
    `- memo: ${memoId}`,
    `- trigger: ${filing.trigger}`,
    `- gate: ${filing.gateId}`,
    `- task: ${filing.taskId ?? 'none'}`,
    `- filed: ${at}`,
    '',
    '## Context',
    '',
    filing.context,
    '',
    '## Options',
    '',
    options,
    '',
    '## Recommendation',
    '',
    filing.recommendation,
    '',
    '## Blast radius',
    '',
    filing.blastRadius,
    '',
    '## Rollback',
    '',
    filing.rollback,
    ''
  ].join('\n')
}

/**
 * What the ORCHESTRATOR proposes when she settles a memo under delegated
 * authority.
 *
 * Note what it does not carry: `decidedBy`, `countersigned` and `authority`.
 * Those are the harness’s to fill from `mayDecide` — an agent that could
 * write its own countersignature could grant itself authority it was never
 * given, which is exactly the widening FR-5.5 exists to prevent.
 */
export const verdictFilingSchema = z
  .object({
    schemaVersion: z.literal(MEMO_SCHEMA_VERSION),
    kind: z.literal('verdict'),
    memoId: memoIdSchema,
    verdict: memoVerdictNameSchema,
    notes: z.string().max(10_000)
  })
  .strict()

export type VerdictFiling = z.infer<typeof verdictFilingSchema>

export type VerdictParse =
  | { readonly ok: true; readonly filing: VerdictFiling }
  | { readonly ok: false; readonly reason: string }

/** Contract: parses a verdict proposal, or explains why it could not. */
export function parseVerdictFiling(body: string): VerdictParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return { ok: false, reason: `verdict: body is not JSON — ${reason(err)}` }
  }
  const parsed = verdictFilingSchema.safeParse(raw)
  if (parsed.success) return { ok: true, filing: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'verdict'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid verdict proposal'}` }
}

/**
 * Contract: which act a settled memo implies for the gate it answers.
 *
 * `approved` releases the held action. `rejected` DENIES it — ADR-0008’s "a
 * rejected memo reverses the change" — and `amended` also denies, because an
 * amendment is a different action from the one that was held: the agent must
 * come back with the amended plan rather than have the original released
 * under a verdict that was not about it.
 */
export function gateVerdictFor(verdict: MemoVerdictName): 'approved' | 'denied' {
  return verdict === 'approved' ? 'approved' : 'denied'
}

/**
 * Contract: the machine-readable header `renderMemoMarkdown` wrote, read back.
 *
 * SDD §4.5 gives a memo directory exactly two files — `memo.md` and
 * `verdict.json` — so the facts a verdict needs (which gate, which trigger,
 * which task) are read back out of the memo rather than kept in a third file
 * the documented layout does not have. The format is one this module also
 * writes, so it is a round-trip, not a parser for somebody else’s prose.
 */
export function parseMemoHeader(markdown: string): MemoHeader | null {
  // Anchored on the `- memo:` line and read only from the contiguous block that
  // contains it, rather than from the whole document. Defence in depth behind
  // the single-line title rule: a first-match scan over the entire markdown lets
  // ANY agent-authored text that reaches the page above the header write the
  // header, and the title is not the only such text a later change might admit.
  const lines = markdown.split('\n')
  const anchor = lines.findIndex((line) => /^- memo: /.test(line))
  if (anchor === -1) return null
  let start = anchor
  while (start > 0 && /^- [a-z]+: /.test(lines[start - 1] ?? '')) start -= 1
  let end = anchor
  while (end + 1 < lines.length && /^- [a-z]+: /.test(lines[end + 1] ?? '')) end += 1
  const block = lines.slice(start, end + 1).join('\n')
  const field = (name: string): string | null => {
    const match = new RegExp(`^- ${name}: (.+)$`, 'm').exec(block)
    return match?.[1]?.trim() ?? null
  }
  const memoId = field('memo')
  const trigger = field('trigger')
  const gateId = field('gate')
  const taskId = field('task')
  if (memoId === null || trigger === null || gateId === null) return null
  const parsedTrigger = memoTriggerSchema.safeParse(trigger)
  if (!parsedTrigger.success) return null
  return {
    memoId,
    trigger: parsedTrigger.data,
    gateId,
    taskId: taskId === null || taskId === 'none' ? null : taskId
  }
}

export interface MemoHeader {
  readonly memoId: string
  readonly trigger: MemoTrigger
  readonly gateId: string
  readonly taskId: string | null
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
