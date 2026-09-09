import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **M8c.10 — the exit script must not tell the crew the break is deliberate.**
 *
 * `docs/EXIT-M8.md` §3 asks the runner to break a test and push it, so that
 * SRS §6.1 clause 2 — *"fixed it or opened a fix PR"* — has something to
 * measure. Until 2026-09-09 it also dictated the commit message:
 *
 * ```text
 * git commit -am "test: break one assertion for the M8 exit run"
 * ```
 *
 * The M8b rehearsal proved what that costs. The on-call agent read the message,
 * concluded — correctly — that the break was a fixture and `main` was
 * unaffected, and opened no pull request. Its own words are in
 * `docs/demo/m8b-rehearsal-m8b-rehearsal.md`, Finding B. That is good judgement
 * and an unmeasurable clause: **the script was telling the crew not to do the
 * thing the clause exists to observe.** Pushed again with an ordinary message,
 * the same crew triaged the same break as a real defect and opened the fix.
 *
 * So the guard is on the DOCUMENT, because the document is where the defect
 * was. A run's outcome depends on prose no compiler reads, and this is the
 * second time a fix to one section of the docs failed to reach the section a
 * reader was actually sent to (the exit run's Finding 1 is the first). The
 * fourth case below is the control: it runs the same predicate over the exact
 * string the 2026-09-09 run used and asserts it is REJECTED, so a matcher that
 * silently stopped matching anything would fail here rather than pass
 * everywhere.
 */

const EXIT_M8 = path.join(__dirname, '..', '..', 'docs', 'EXIT-M8.md')

/**
 * Words that announce a break as deliberate to whoever reads the commit.
 *
 * The audience is an on-call agent reading a CI payload — branch, subject line,
 * sha. It has no other way to know the failure was planted, which is exactly
 * the state a real incident arrives in.
 */
const ANNOUNCES =
  /\b(break|breaks|broke|broken|breaking|deliberate|deliberately|fixture|intentional|intentionally|on purpose|do not fix|don't fix|exit run|exit-m8|m8 exit|rehearsal)\b/i

/** Every first capture group `pattern` finds in `text`. */
function captures(text: string, pattern: RegExp): readonly string[] {
  const found: string[] = []
  for (const match of text.matchAll(pattern)) if (match[1] !== undefined) found.push(match[1])
  return found
}

/** The body of one `## n. …` section, up to the next `## ` heading. */
function section(markdown: string, number: number): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`## ${number}. `))
  expect(start, `EXIT-M8.md has no "## ${number}." heading`).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

describe('EXIT-M8 §3 — the planted break reads like an ordinary change', () => {
  const three = section(fs.readFileSync(EXIT_M8, 'utf8'), 3)

  it('instructs a commit message that does not announce the break', () => {
    // The first quoted string on any `git commit` line, whatever flags it carries.
    const messages = [...three.matchAll(/^git commit\b[^"\n]*"([^"\n]+)"/gm)].map((m) => m[1])

    expect(messages.length, '§3 no longer shows a commit command').toBeGreaterThan(0)
    for (const message of messages) expect(message).not.toMatch(ANNOUNCES)
  })

  it('names the branch without announcing the break either', () => {
    const branches = [
      ...captures(three, /^git switch -c\s+(\S+)/gm),
      ...captures(three, /^git push -u origin\s+(\S+)/gm)
    ]

    expect(branches.length, '§3 no longer shows a branch name').toBeGreaterThan(0)
    // A branch reaches the agent in the same CI payload the subject line does.
    for (const branch of branches) expect(branch.replace(/[-_/]/g, ' ')).not.toMatch(ANNOUNCES)
  })

  it('says why the wording is part of the test, and cites the run that proved it', () => {
    expect(three).toMatch(/clause 2/i)
    expect(three).toContain('demo/m8b-rehearsal-m8b-rehearsal.md')
  })

  it('CONTROL — the message the 2026-09-09 run used is rejected by this check', () => {
    expect('test: break one assertion for the M8 exit run').toMatch(ANNOUNCES)
    expect('exit-m8-broken-test'.replace(/[-_/]/g, ' ')).toMatch(ANNOUNCES)
    // …and the message the rehearsal proved works is not.
    expect('refactor(geo): simplify the interpolation arithmetic').not.toMatch(ANNOUNCES)
  })
})
