/**
 * Secret-shaped strings, at RUNTIME (ENGINEERING-STANDARDS §5, FR-10.4 — M7.6).
 *
 * `scripts/check-invariants.cjs` has carried this list since M0 as a BUILD gate:
 * no secret-shaped literal may exist in code or fixtures. M7.6 needs the same
 * judgement at runtime, because a shared bundle is a file somebody else wrote
 * and "this credential was pasted into a hire template" is exactly the mistake
 * export/import makes easy to spread.
 *
 * ## Two lists, and why that is safe here
 *
 * The checker is a standalone `.cjs` build gate that must run before anything is
 * compiled, so it cannot import this module. Duplicating a security-relevant
 * list would normally be a defect — a second source of truth drifts, and the
 * half nobody updated is the half that stops catching things.
 *
 * The mechanism that makes it safe is `test/shared/secret-shapes.test.ts`: it
 * reads `check-invariants.cjs` as TEXT and asserts the two lists are identical,
 * so a pattern added to one and not the other fails the suite by name. The
 * duplication is real; what is removed is the possibility of it going unnoticed.
 *
 * ## What this is NOT
 *
 * Not a secret scanner, and not a guarantee. These patterns catch credentials
 * whose SHAPE is publicly documented — the ones a careless export actually
 * carries. A random 40-character password matches nothing here and never will,
 * which is why the import path treats a clean result as "no known credential
 * shape found" rather than as "safe", and why `envGrants` are names the broker
 * resolves (ADR-0010) rather than values a bundle could carry at all.
 */

/**
 * Publicly documented credential prefixes, in the checker's order.
 *
 * Kept as source strings rather than a single compiled regex so the test can
 * compare them element by element against the checker's array and name the one
 * that differs.
 */
export const SECRET_SHAPE_SOURCES: readonly string[] = [
  'sk-[A-Za-z0-9_-]{16,}',
  'gh[pousr]_[A-Za-z0-9]{16,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'AKIA[0-9A-Z]{12,}',
  'AIza[0-9A-Za-z_-]{30,}',
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
]

/** Human names for what each pattern catches, for a refusal that says which. */
const SECRET_SHAPE_NAMES: readonly string[] = [
  'an OpenAI-style key',
  'a GitHub token',
  'a GitHub fine-grained token',
  'a Slack token',
  'an AWS access key id',
  'a Google API key',
  'a PEM private key'
]

/**
 * Contract: the name of the first credential shape found in `text`, or null.
 * Pure; never throws.
 *
 * Returns the NAME rather than the matched text, and deliberately so: a refusal
 * that quoted the secret would write it into the log, the UI and any bug report
 * the Architect pastes it into — turning a caught leak into a wider one.
 */
export function secretShapeIn(text: string): string | null {
  for (const [index, source] of SECRET_SHAPE_SOURCES.entries()) {
    if (new RegExp(source).test(text)) return SECRET_SHAPE_NAMES[index] ?? 'a credential'
  }
  return null
}
