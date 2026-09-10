import { z } from 'zod'

/**
 * What a hire may do without stopping to ask its ENGINE (M8c.8, ADR-0035).
 *
 * This is not an Ephesus gate and must not be confused with one. An Ephesus
 * gate is a deliberate hold with a `gateId` an Architect can settle in the
 * WATCH tab; the engine's own permission prompt has neither, and `evaluateGate`
 * refuses `tool-permission` by construction because the harness has no action
 * to permit there — the engine does.
 *
 * **What that costs, measured.** The M8b rehearsal recorded twelve
 * `gate/ungated · tool-permission · waiting · "Claude is waiting for your
 * input"` rows in one hour, and **four of the five agents' last recorded action
 * is a parked prompt**. The Architect saw it from outside before the log did
 * ("they opened 3 PRs then stopped"). So the hour does not last an hour: it
 * lasts until the first agent reaches a prompt, and every number a run reports
 * is bounded by that rather than by the company's capacity.
 *
 * The Architect's decision is to **pre-authorise, per hire, by name** — the
 * same shape ADR-0012 uses for everything else a profile may do, and the same
 * shape ADR-0026 uses for tool directories. A hire declares the commands it may
 * run unprompted; the adapter renders them into the settings file the harness
 * already writes; the activation screen shows them before anything is hired.
 * **Anything undeclared still parks**, which is what keeps this least
 * privilege rather than a blanket bypass.
 *
 * ## Why commands, and only commands
 *
 * One mechanism, not two — the argument `engine-tools.ts` makes for directories.
 * The prompts an unattended crew actually meets are shell-shaped: its runbook
 * tells it to reproduce a failure, cut a branch, push it and open a pull
 * request. File reads and edits inside its own worktree are already decided by
 * the composed autonomy level (ADR-0031), and its mailbox and runbooks are
 * already granted by name. What was left was the shell, so that is what this
 * declares. Adding a second vocabulary later is a schema change with an ADR,
 * not a field somebody slips in.
 *
 * ## Why the harness cannot simply answer the prompt instead
 *
 * It could: it owns the PTY. That was the other option on the table and it was
 * refused — see ADR-0035 §Options. A harness that types into an engine's
 * permission dialog is a harness that can approve anything the engine would
 * have asked about, which is the same authority `watch:approve` is refused for
 * (ADR-0033). Declaring in advance what may happen is a smaller power than
 * being able to say yes to whatever comes up.
 */

/** The characters that turn one command into two. */
const CHAINING = /[;&|`\n\r<>]|\$\(/

/**
 * A shell command a hire may run without being asked.
 *
 * `prefix` is the whole safety story of this schema, so read it before writing
 * a grant. Without it the grant matches that command and nothing else, which is
 * how `ghTokenPermissions` has always granted the one call it needs. With it
 * the grant matches anything STARTING with the declared text — which is what
 * makes `git push origin HEAD` usable and `git push --force` still promptable,
 * and equally what would make a grant of `git` a grant of everything git can
 * do. So a prefix grant must name at least two words.
 */
export const unattendedGrantSchema = z
  .object({
    /**
     * The command line, exactly as it would be typed. No pipes, no `&&`, no
     * redirection, no command substitution: a grant that could carry a second
     * command is a grant of that second command, and the point of declaring by
     * name is that the Architect can read the list and know what it reaches.
     */
    run: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value && value.length > 0, 'no leading or trailing space')
      .refine((value) => !value.includes('\0'), 'a command, with no NUL')
      .refine((value) => !CHAINING.test(value), 'one command: no ; & | ` $( ) < > or newline')
      .refine((value) => !value.includes('..'), 'no parent-directory traversal'),
    /**
     * Also allow anything that starts with `run`. Off by default, and refused
     * for a single word — see the note above.
     */
    prefix: z.boolean().optional()
  })
  .strict()
  .refine(
    (grant) => grant.prefix !== true || grant.run.split(/\s+/).length >= 2,
    'a prefix grant must name at least two words: "git" would grant everything git can do'
  )

export type UnattendedGrant = z.infer<typeof unattendedGrantSchema>

/**
 * At most twelve per hire.
 *
 * A cap rather than none, for the reason `toolGrantsSchema` gives: every entry
 * is something that will happen with nobody watching, and a list too long to
 * read is a list nobody read. Twelve is enough for the shipped runbooks' git
 * and `gh` vocabulary with room to spare.
 */
export const unattendedGrantsSchema = z.array(unattendedGrantSchema).max(12)

/** No grants — what a hire that declares nothing gets. */
export const NO_UNATTENDED: readonly UnattendedGrant[] = []

/**
 * Contract: pure. One line per grant, for the activation screen and the log.
 *
 * The Architect reads this BEFORE the crew is hired, which is the whole reason
 * the declaration is in the bundle rather than in code: an unattended hour
 * should contain no act the plan did not name.
 *
 * Takes `undefined` as well as an empty list, and that is deliberate rather
 * than lax. The field is optional on a spawn request — a plan persisted before
 * ADR-0035 restores without it — so every caller would otherwise write
 * `?? []` at its own call site, which is a branch per caller that only one of
 * them can ever reach. One function, one branch, one test.
 */
export function describeUnattendedGrants(
  grants: readonly UnattendedGrant[] | undefined
): readonly string[] {
  return (grants ?? []).map((grant) => (grant.prefix === true ? `${grant.run} …` : grant.run))
}
