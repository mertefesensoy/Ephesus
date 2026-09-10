import { z } from 'zod'
import { activationRequestSchema, instanceIdSchema } from './profile-activation'
import { maxDailyTokensSchema, SUGGESTED_DAILY_TOKENS } from './gates'

/**
 * The control surface's contract (M8.14) — the one place that says what a
 * script may do to this company, and what it may not.
 *
 * ## Why this exists at all
 *
 * The M8 exit run stalled at the last step of setup. Not on a bug: on the fact
 * that consent and profile activation existed ONLY in the renderer, so a runner
 * who was not a person at a keyboard could not reach them and the whole hour's
 * test died at minute two. Two workarounds were offered — the Architect clicks,
 * or the agent is given desktop control — and both were refused in favour of
 * naming the real defect. SRS §6.1's *"The Architect activates Skeleton Crew"*
 * is about AUTHORITY, not about a mouse; reading it as *a person clicking* is
 * what left the criterion unrunnable by anybody but a person at the machine.
 *
 * ## The line this module draws
 *
 * **A script may run the company; only a human may authorise what the company
 * is not otherwise allowed to do.**
 *
 * So {@link CONTROL_VERBS} is what a script may do — consent, activation,
 * briefings, reads — and {@link REFUSED_VERBS} is the four things it may not:
 * gate approvals, memo verdicts, secrets and mode changes. Those four are the
 * decisions the Watch exists to put in front of a human. A CLI that could
 * approve a destructive gate would delete the meaning of §6.1's own last clause
 * — *"with zero un-gated destructive actions"* — by making the gate scriptable
 * by the very automation the gate exists to bound. ADR-0010 (secrets are
 * write-only) and FR-14.2 (the mode is the Architect's) already draw the same
 * line in their own areas.
 *
 * The four are refused **by name, with a reason that teaches the rule**, and
 * not merely absent. "There is no such verb" is a worse answer than "gate
 * approval is deliberately not scriptable; approve it in WATCH, and here is
 * why": a refusal a caller cannot learn from bills you every time.
 *
 * ## Why the table is pure, and lives here
 *
 * Because it is the whole package. A mutation that quietly moves
 * `watch:approve` from the refused set into the allowed one is this design
 * undone, and the only way to fail loudly on that is for the sets to be data in
 * one module that a unit test can assert over exhaustively — rather than a
 * series of `if` statements spread through a request handler.
 */

/** Wire-format version, carried on every request and every answer. */
export const CONTROL_SCHEMA_VERSION = 1

/** The HTTP path the control endpoint listens on. */
export const CONTROL_ENDPOINT_PATH = '/control'

/**
 * The file a running harness leaves in its home saying where its control
 * endpoint is (invariant §9 — schema'd, with its validator here).
 *
 * It exists so `scripts/ephctl.cjs` does not have to re-derive the address.
 * A CLI that recomputed the sha256 above in plain JavaScript would be a second
 * implementation of a rule that must agree with the first — this repository's
 * most-repeated defect — and the file also answers, without a connection
 * attempt, the most common failure of all: no harness is running.
 */
export const CONTROL_ADDRESS_FILE = 'control-endpoint.json'

export const controlAddressSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    /** Socket path or named pipe, as `controlEndpointFor` produced it. */
    endpoint: z.string().min(1),
    /** The HTTP path to POST to, so the client needs no constant of its own. */
    path: z.string().min(1),
    /** The harness process that owns it — enough to tell a stale file apart. */
    pid: z.number().int().nonnegative(),
    startedAt: z.string().min(1)
  })
  .strict()

export type ControlAddress = z.infer<typeof controlAddressSchema>

/** No arguments. Strict, so a typo'd flag is refused rather than ignored. */
const noArgs = z.object({}).strict()

const tailArgs = z.object({ limit: z.coerce.number().int().min(1).max(2000).default(40) }).strict()

const deactivateArgs = z.object({ instance: instanceIdSchema }).strict()

/**
 * `budget:set`'s one argument, coerced from the string a command line gives.
 *
 * Bounded by `maxDailyTokensSchema`, which is the SAME schema the policy file
 * and the settings surface use. A second set of bounds here would agree by
 * coincidence and drift by edit, which is the defect that schema's own comment
 * records.
 */
const budgetArgs = z.object({ daily: z.coerce.number().pipe(maxDailyTokensSchema) }).strict()

/**
 * `consent:grant`'s one optional flag (M8c.3).
 *
 * It takes a VALUE — `--unbudgeted true` — rather than being a bare flag,
 * because `ephctl` refuses a flag with no value and that refusal is worth more
 * than the keystroke: `--profile --target repo:x` is a missing value, not two
 * bare flags, and a client that guessed would answer it with a puzzle. Typing
 * `true` is also an affirmative act, which is the whole point of this one.
 *
 * `"true"` from a command line and a real boolean from a caller that already
 * has one are both accepted, and nothing else is — a typo that read as truthy
 * would be a permission granted by accident. Absent is `false`: the answer must
 * be given, never assumed.
 */
const consentGrantArgs = z
  .object({ unbudgeted: z.union([z.boolean(), z.enum(['true', 'false'])]).optional() })
  .strict()
  .transform((args) => ({ unbudgeted: args.unbudgeted === true || args.unbudgeted === 'true' }))

/**
 * Contract: pure. Whether a script may move the company's daily ceiling from
 * `current` to `requested`, and why not when it may not.
 *
 * **A script may make the company safer and never more permissive** — ADR-0033's
 * rule, applied to the one control it now offers. From `unbudgeted` (`null`)
 * any figure is a tightening, because ADR-0029's shipped default is no ceiling
 * at all. From a ceiling somebody set, a HIGHER figure is a raise: the same
 * decision as widening the autonomy ceiling, and one the WATCH tab exists for.
 *
 * Equal is allowed and says so. A run that re-asserts the ceiling it already
 * has has authorised nothing, and refusing it would make the verb unusable
 * from a script that cannot read the current value first.
 */
export function budgetSetVerdict(
  current: number | null,
  requested: number
):
  | { readonly ok: true; readonly because: string }
  | { readonly ok: false; readonly because: string } {
  if (current === null) {
    return {
      ok: true,
      because: `the company was unbudgeted (ADR-0029's shipped default); it now stops at ${requested.toLocaleString('en-US')} tokens a day`
    }
  }
  if (requested > current) {
    return {
      ok: false,
      because:
        `raising a ceiling is not something a script may do. ` +
        `The company stops at ${current.toLocaleString('en-US')} tokens a day and you asked for ` +
        `${requested.toLocaleString('en-US')} — a ceiling only ever caps what the company may spend, so ` +
        `lowering it is a tightening any script may make and raising it is a decision only a person may. ` +
        `Do it instead: open the WATCH tab, set the Daily budget there. ` +
        `The rule this surface keeps: a script may run the company; only a human may authorise ` +
        `what the company is not otherwise allowed to do.`
    }
  }
  return {
    ok: true,
    because:
      requested === current
        ? `unchanged: the company already stops at ${current.toLocaleString('en-US')} tokens a day`
        : `tightened from ${current.toLocaleString('en-US')} to ${requested.toLocaleString('en-US')} tokens a day`
  }
}

const conveneArgs = z
  .object({
    /** Repeated `--attendee` flags, or one comma-free name. */
    attendee: z
      .union([z.string(), z.array(z.string())])
      .transform((v) => (Array.isArray(v) ? v : [v]))
      .pipe(z.array(z.string().min(1).max(120)).min(1).max(16)),
    agenda: z.string().min(1).max(2000)
  })
  .strict()

/**
 * `profile:activate`'s arguments, in the shape a command line produces them.
 *
 * The wire from a CLI is strings, so the coercion belongs here — in the schema,
 * where it is tested — rather than in the client, where it would be a second
 * place that knows what an activation request looks like. `activationRequestSchema`
 * is the one that decides: this only reshapes `--target repo:myapp --path C:\x`
 * into the object it already validates.
 */
const activateArgs = z
  .object({
    profile: z.string().min(1).max(64),
    /** `repo:myapp` or `app:website` — the same ref the registry and log use. */
    target: z.string().min(1).max(120),
    /** The checkout on disk. */
    path: z.string().min(1).max(4096),
    /** Repeated `--repo owner/name`, overriding the bundle and the checkout. */
    repo: z
      .union([z.string(), z.array(z.string())])
      .transform((v) => (Array.isArray(v) ? v : [v]))
      .optional(),
    isolation: z.string().min(1).max(32).optional()
  })
  .strict()

/**
 * Contract: turns validated CLI arguments into the `ActivationRequest` the IPC
 * handler already validates, or returns why it could not.
 *
 * Pure. The split `repo:myapp` → `{kind:'repo', id:'myapp'}` happens here so
 * `activationRequestSchema` stays the single authority on what an activation
 * request may contain — this function only ever hands it a candidate.
 */
export function activationRequestFromArgs(
  args: z.infer<typeof activateArgs>
):
  | { readonly ok: true; readonly request: unknown }
  | { readonly ok: false; readonly reason: string } {
  const split = args.target.indexOf(':')
  if (split <= 0)
    return {
      ok: false,
      reason: `--target must look like "repo:myapp" or "app:website"; got "${args.target}"`
    }
  const candidate = {
    profile: args.profile,
    target: {
      kind: args.target.slice(0, split),
      id: args.target.slice(split + 1),
      path: args.path
    },
    ...(args.repo === undefined ? {} : { repos: args.repo }),
    ...(args.isolation === undefined ? {} : { isolation: args.isolation })
  }
  const parsed = activationRequestSchema.safeParse(candidate)
  if (!parsed.success)
    return {
      ok: false,
      reason: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
        .join('; ')
    }
  return { ok: true, request: parsed.data }
}

/**
 * Contract: pure. The two trigger lines an activation prints, in the reader's
 * vocabulary rather than the scheduler's (M8c.6).
 *
 * **`armed` means "has a clock running".** It is accurate to the
 * implementation, and it is a lie to a stranger: an event trigger has no clock
 * to arm, so it is *structurally invisible* on that line however correctly it is
 * bound. On 2026-09-09 `profile:activate` reported
 * `armed dependency-sweep, health-sweep` with no `ci` trigger — and
 * `EXIT-M8.md` §5.1 tells the runner, unambiguously, that a missing `ci`
 * trigger *"is a setup defect, and the run cannot proceed past it."*
 *
 * **The documented reading of that output is therefore: stop, the run is
 * invalid.** It was bound the whole time; it was proved bound minutes later
 * when the ingest raised eight incidents through it. The runner nearly aborted a
 * valid run on it, and the M8b rehearsal met the same trap again.
 *
 * So the two kinds are printed separately and both are named. This is the same
 * class as M8c.5 and the one the decisions log already records twice: **a
 * consumer-facing label that is true in the producer's vocabulary and false in
 * the reader's.**
 *
 * @param armed the scheduler's own list — clocks that are actually running.
 */
export function triggerLines(
  triggers: readonly {
    readonly id: string
    readonly everyMs: number | null
    readonly event: string | null
    readonly agentId: string
  }[],
  armed: readonly string[]
): readonly string[] {
  // The scheduler's ids are instance-qualified (`<instance>/<trigger>`); the
  // plan's are bare. Matched on the suffix so the two vocabularies meet here
  // rather than in a caller that would have to know both.
  const isArmed = (id: string): boolean => armed.some((row) => row === id || row.endsWith(`/${id}`))
  const schedules = triggers.filter((trigger) => trigger.everyMs !== null)
  const events = triggers.filter((trigger) => trigger.everyMs === null && trigger.event !== null)
  return [
    `armed (schedules)  ${
      schedules.length === 0
        ? '(none)'
        : schedules
            .map((trigger) => `${trigger.id}${isArmed(trigger.id) ? '' : ' — NOT ARMED'}`)
            .join(', ')
    }`,
    // Always printed, even when empty: the absence of this line is what a
    // reader took for the absence of the trigger.
    `event triggers     ${
      events.length === 0
        ? '(none)'
        : events
            .map((trigger) => `${String(trigger.event)} → ${trigger.agentId} (${trigger.id})`)
            .join(', ')
    }`
  ]
}

/**
 * One verb a script may invoke.
 *
 * `writes` is not decoration and not an optimisation: it decides whether the
 * act lands in the book of record. Every verb that CHANGES something is logged
 * with the `remote` tag, so the log can always answer "did the window do that,
 * or did a script?". Pure reads are not, because a read changes nothing and
 * `log.jsonl` is append-only — a polled `status` would push real events out of
 * a reader's view permanently. Keeping the decision in this table, beside the
 * refusal list, is what makes a mutation that flips it killable.
 */
export interface ControlVerb {
  readonly name: string
  /** One line, printed by `help`. */
  readonly summary: string
  /** Validates the arguments a caller sent. Strict: an unknown flag is refused. */
  readonly args: z.ZodType
  /** True when invoking it changes something, and so must be logged `remote`. */
  readonly writes: boolean
  /** Example invocation, printed by `help` and by an argument refusal. */
  readonly usage: string
}

/**
 * Everything a script may do. Consent, activation, briefings and reads — the
 * scope settled on 2026-09-08 and recorded in `docs/DECISIONS-LOG.md`.
 */
export const CONTROL_VERBS: readonly ControlVerb[] = [
  {
    name: 'help',
    summary: 'list every verb, and every verb that is deliberately refused',
    args: noArgs,
    writes: false,
    usage: 'ephctl help'
  },
  {
    name: 'status',
    summary: "the harness's own diagnosis: what is working, what is not, and why",
    args: noArgs,
    writes: false,
    usage: 'ephctl status'
  },
  {
    name: 'diagnosis',
    summary: 'the same fold, rendered as the DIAGNOSIS.md report',
    args: noArgs,
    writes: false,
    usage: 'ephctl diagnosis'
  },
  {
    name: 'consent:status',
    summary: 'whether the company has been consented to, and what starting it would do',
    args: noArgs,
    writes: false,
    usage: 'ephctl consent:status'
  },
  {
    name: 'consent:grant',
    summary: 'grant consent and start the company (idempotent)',
    args: consentGrantArgs,
    writes: true,
    usage: 'ephctl consent:grant [--unbudgeted true]'
  },
  {
    name: 'budget:set',
    summary: 'lower the company-wide daily token ceiling (a script may tighten, never raise)',
    args: budgetArgs,
    writes: true,
    usage: `ephctl budget:set --daily ${SUGGESTED_DAILY_TOKENS}`
  },
  {
    name: 'profile:list',
    summary: 'every mission profile bundle, valid or not',
    args: noArgs,
    writes: false,
    usage: 'ephctl profile:list'
  },
  {
    name: 'profile:instances',
    summary: 'every live activation, with its target and its agents',
    args: noArgs,
    writes: false,
    usage: 'ephctl profile:instances'
  },
  {
    name: 'profile:activate',
    summary: 'activate a profile against a checkout',
    args: activateArgs,
    writes: true,
    usage:
      'ephctl profile:activate --profile skeleton-crew --target repo:myapp ' +
      '--path C:\\src\\myapp [--repo owner/name] [--isolation as-declared|isolate-all|none]'
  },
  {
    name: 'profile:deactivate',
    summary: 'stop one live activation',
    args: deactivateArgs,
    writes: true,
    usage: 'ephctl profile:deactivate --instance skeleton-crew@repo:myapp'
  },
  {
    name: 'odeon:convene',
    summary: 'convene a briefing now, rather than waiting for the cadence',
    args: conveneArgs,
    writes: true,
    usage: 'ephctl odeon:convene --attendee agent.artemis --agenda "the incident"'
  },
  {
    name: 'odeon:adjourn',
    summary: 'close the open meeting and archive its minutes',
    args: noArgs,
    writes: true,
    usage: 'ephctl odeon:adjourn'
  },
  {
    name: 'agents:list',
    summary: 'the roster and each agent\u2019s lifecycle',
    args: noArgs,
    writes: false,
    usage: 'ephctl agents:list'
  },
  {
    name: 'log:tail',
    summary: 'the newest rows of the book of record',
    args: tailArgs,
    writes: false,
    usage: 'ephctl log:tail [--limit 40]'
  }
]

/**
 * One verb the surface will never perform, and the rule it is teaching.
 *
 * Named after the IPC channel the window uses, so a caller who knows the app's
 * vocabulary lands on the refusal rather than on "no such verb" — which would
 * teach them nothing and invite them to go looking for the right spelling.
 */
export interface RefusedVerb {
  readonly name: string
  /** Why it is refused, in a sentence a caller can act on. */
  readonly because: string
  /** Where a human does it instead. */
  readonly instead: string
}

/**
 * The four exclusions. **Exactly four**, asserted as a set by
 * `test/shared/control.test.ts` in both directions: a refused verb that becomes
 * allowed and an allowed verb that becomes refused both fail the suite, because
 * either mutation is the whole package undone.
 */
export const REFUSED_VERBS: readonly RefusedVerb[] = [
  {
    name: 'watch:approve',
    because:
      'approving a gate is the one decision the gate exists to put in front of a person. ' +
      "SRS §6.1 asks for an hour 'with zero un-gated destructive actions', and a script " +
      'that could approve gates would make the gate scriptable by exactly the automation ' +
      'it is there to bound — so the criterion would prove nothing.',
    instead: 'open the WATCH tab and approve it there'
  },
  {
    name: 'odeon:verdict',
    because:
      'a memo is the record of a human deciding that an agent may cross a policy line ' +
      '(ADR-0008). A verdict a script could file would be an agent approving its own memo ' +
      'one indirection later.',
    instead: 'open the ODEON tab and decide the memo there'
  },
  {
    name: 'secrets:set',
    because:
      'secrets are write-only and reach agents only as env vars declared in a hire ' +
      'template (ADR-0010). This surface has no token and trusts every process running ' +
      'as you, so a verb that carried a credential would hand one to anything on this ' +
      'machine that can open a socket.',
    instead: 'open the WATCH settings and set it there'
  },
  {
    name: 'gym:set-mode',
    because:
      "the company mode is the Architect's alone (FR-14.2), and `improving` is what lets " +
      'the company change itself. A mode a script could set is a proof gate the company ' +
      'could walk through on its own initiative.',
    instead: 'open the GYMNASIUM tab and set the mode there'
  }
]

/** What `resolveControlVerb` decided about a name a caller sent. */
export type VerbResolution =
  | { readonly kind: 'allowed'; readonly verb: ControlVerb }
  | { readonly kind: 'refused'; readonly refusal: RefusedVerb }
  | { readonly kind: 'unknown'; readonly name: string }

/**
 * Contract: pure. Decides what a name means against the two tables given,
 * refused entries FIRST.
 *
 * The order is the point, and it takes its tables as arguments so that the
 * order is a RULE a test can drive rather than an incidental property of two
 * lists that happen not to overlap. A mutation pass found exactly that: with
 * the shipped tables, consulting the allowed list first is indistinguishable —
 * and it stops being indistinguishable the moment somebody "just adds the
 * verb" that is already refused, which is the one mistake this order exists to
 * survive.
 */
export function resolveVerbIn(
  refused: readonly RefusedVerb[],
  allowed: readonly ControlVerb[],
  name: string
): VerbResolution {
  const refusal = refused.find((entry) => entry.name === name)
  if (refusal) return { kind: 'refused', refusal }
  const verb = allowed.find((entry) => entry.name === name)
  if (verb) return { kind: 'allowed', verb }
  return { kind: 'unknown', name }
}

/** Contract: pure. What this surface's own tables say about a name. */
export function resolveControlVerb(name: string): VerbResolution {
  return resolveVerbIn(REFUSED_VERBS, CONTROL_VERBS, name)
}

/**
 * The request envelope. `args` is whatever the command line produced — strings
 * and repeated strings — and each verb's own schema decides what that means.
 */
export const controlRequestSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    verb: z.string().min(1).max(64),
    args: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({})
  })
  .strict()

export type ControlRequest = z.infer<typeof controlRequestSchema>

/**
 * The answer. `text` is what the CLI prints; `data` is the same answer for a
 * script that passed `--json`.
 *
 * The rendering lives on the harness side deliberately: the client holds no
 * verb table, no validators and no prose, so there is nothing in it that can
 * disagree with the policy. It prints what it is told and exits non-zero when
 * `ok` is false.
 */
export interface ControlAnswer {
  readonly schemaVersion: number
  readonly ok: boolean
  readonly verb: string
  readonly text: string
  readonly data: unknown
}

/** Contract: the refusal a caller sees for one of the four. Pure. */
export function renderRefusal(refusal: RefusedVerb): string {
  return [
    `refused: "${refusal.name}" is deliberately not scriptable.`,
    '',
    refusal.because,
    '',
    `Do it instead: ${refusal.instead}.`,
    '',
    'The rule this surface keeps: a script may run the company; only a human may',
    'authorise what the company is not otherwise allowed to do.'
  ].join('\n')
}

/**
 * Contract: what a caller sees for a name that is in neither set. Pure.
 *
 * It lists BOTH sets, because the most useful thing a mistyped verb can do is
 * teach the shape of the surface — including that four things are missing on
 * purpose. A bare "no such verb" would send a caller hunting for a spelling
 * that does not exist.
 */
export function renderUnknownVerb(name: string): string {
  const allowed = CONTROL_VERBS.map((verb) => `  ${verb.name.padEnd(20)} ${verb.summary}`)
  const refused = REFUSED_VERBS.map((entry) => `  ${entry.name.padEnd(20)} ${entry.instead}`)
  return [
    `no such verb: "${name}".`,
    '',
    'This surface performs:',
    ...allowed,
    '',
    'And deliberately refuses these — they are decisions only a human may make:',
    ...refused,
    '',
    'A script may run the company; only a human may authorise what the company is',
    'not otherwise allowed to do. Run `ephctl help <verb>` for one verb in detail.'
  ].join('\n')
}

/** Contract: `help`'s body. Pure, and the only place the surface describes itself. */
export function renderHelp(): string {
  const allowed = CONTROL_VERBS.map((verb) => `  ${verb.name.padEnd(20)} ${verb.summary}`)
  const refused = REFUSED_VERBS.flatMap((entry) => [`  ${entry.name}`, `      ${entry.instead}`])
  return [
    'ephctl — the Ephesus control surface.',
    '',
    'It operates the company. It does not authorise anything the company is not',
    'otherwise allowed to do: that stays with a person at the window.',
    '',
    'Verbs:',
    ...allowed,
    '',
    'Deliberately refused:',
    ...refused,
    '',
    'Usage:',
    ...CONTROL_VERBS.filter((verb) => verb.usage !== `ephctl ${verb.name}`).map(
      (verb) => `  ${verb.usage}`
    )
  ].join('\n')
}
