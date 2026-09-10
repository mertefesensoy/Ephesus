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
  /\b(break|breaks|broke|broken|breaking|deliberate|deliberately|fixture|intentional|intentionally|on purpose|do ?n[o']t fix|exit run|exit-m8|m8 exit|rehearsal|plant|planted|seed|seeded|failing test|acceptance run|self-described|dummy|not a real)\b/i

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

  it('asks for a defect in the code under test, not only an edited assertion', () => {
    // The crew reads the DIFF as well as the subject line, and an assertion
    // changed to an obviously wrong expected value announces itself. The
    // rehearsal's PR only ever came back for a one-line defect in the code.
    expect(three).toMatch(/code under test/i)
  })

  it('CONTROL — the messages that announce a break are rejected by this check', () => {
    // The exact string the 2026-09-09 run used, and its branch.
    expect('test: break one assertion for the M8 exit run').toMatch(ANNOUNCES)
    expect('exit-m8-broken-test'.replace(/[-_/]/g, ' ')).toMatch(ANNOUNCES)
    // Subtler ways of saying the same thing, which a bare "break" list misses.
    expect('chore: seed a failing test for the acceptance run').toMatch(ANNOUNCES)
    expect('chore: plant a CI failure').toMatch(ANNOUNCES)
    expect("test: don't fix this, it is a fixture").toMatch(ANNOUNCES)
    // …and the message the rehearsal proved works is not.
    expect('refactor(geo): simplify the interpolation arithmetic').not.toMatch(ANNOUNCES)
    expect('fix(auth): tighten the session timeout').not.toMatch(ANNOUNCES)
  })
})

/**
 * **M8c.1 — §2 must be performable by the runner the script is written for.**
 *
 * §2 marks setting a daily ceiling mandatory, and until M8c.1 it named only
 * **WATCH → settings** — a window-only act, in a script whose whole premise
 * (ADR-0033, and the 2026-09-08 decision) is that the run needs no mouse. Both
 * runs so far went out `unbudgeted` because of it.
 *
 * This is here because the mutation round found nothing guarding it: the CLI
 * line could be dropped from §2 and every test stayed green. That is the exact
 * shape of M8c.10's own defect — a sentence nobody re-reads deciding the
 * outcome of an hour — one section along.
 */
describe('EXIT-M8 §2 — a ceiling the runner can actually set', () => {
  const two = section(fs.readFileSync(EXIT_M8, 'utf8'), 2)

  it('names a control-surface verb, not only the window', () => {
    expect(two).toMatch(/ephctl(\.cjs)? budget:set/)
    expect(two).toMatch(/--daily \d/)
  })

  it('still says where to do it from the window, for a runner who has one', () => {
    expect(two).toMatch(/WATCH/)
  })

  it('says the verb may only lower the ceiling', () => {
    // The property that makes it safe for a script to hold at all: a ceiling
    // caps, so tightening is a script's to do and loosening is a person's.
    expect(two).toMatch(/lower|tighten/i)
  })

  it('CONTROL — the check fails on the section as it stood before M8c.1', () => {
    const before = 'This is the step that is skipped and then regretted. **WATCH → settings**:'
    expect(before).not.toMatch(/ephctl(\.cjs)? budget:set/)
  })
})

/**
 * **M8c.6 — the two documentation halves, guarded.**
 *
 * Finding 4: §5.1 trains the runner to abort on a missing `ci` trigger, and the
 * activation output could not show one. Finding 1: the Node floor is in *Quick
 * start*, and §1 sends the runner to *Setting it up*, which said only
 * `Node 20 (.nvmrc)` — **the 2026-09-08 decision log records that as "Also
 * fixed", and the fix reached Quick start only.** A documentation fix that
 * misses the section a reader is actually sent to is the same defect twice, so
 * both are pinned here rather than trusted.
 */
describe('EXIT-M8 §5.1 does not send a runner to abort on a bound trigger (M8c.6)', () => {
  const five = fs.readFileSync(EXIT_M8, 'utf8')

  it('says the activation prints event triggers separately', () => {
    expect(five).toContain('event triggers')
    expect(five).toContain('armed (schedules)')
  })

  it('names which line is the setup defect, so the reading is unambiguous', () => {
    expect(five).toMatch(/empty `event triggers` line is the setup defect/i)
  })

  it('records that the trigger was bound both times a runner nearly aborted', () => {
    expect(five).toMatch(/bound both times|it was bound/i)
  })
})

describe('the README states the Node floor where the exit script sends you (M8c.6)', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8')

  /** The body of a `## ` section, up to the next one. */
  function named(heading: string): string {
    const lines = readme.split('\n')
    const start = lines.findIndex((line) => line.trim() === heading)
    expect(start, `README has no "${heading}" heading`).toBeGreaterThanOrEqual(0)
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((line) => line.startsWith('## '))
    return (end === -1 ? rest : rest.slice(0, end)).join('\n')
  }

  it('states 20.19+/22.12+ in Setting it up — the section EXIT-M8 §1 names', () => {
    const setup = named('## Setting it up')

    // The FLOOR, in the toolchain step itself — not merely the digits somewhere
    // in the section. The first version of this test asserted `'20.19'` and
    // passed on a paragraph that happened to quote the lockfile's range while
    // the toolchain line had reverted to "Node 20 (`.nvmrc`)". Found by a
    // mutation planted to do exactly that.
    expect(setup).toMatch(/\*\*1\. The toolchain\.\*\* \*\*Node 20\.19\+ or 22\.12\+\*\*/)
  })

  it('still states it in Quick start, where it was already correct', () => {
    const quick = named('## Quick start')

    expect(quick).toContain('20.19')
    expect(quick).toContain('22.12')
  })

  it('CONTROL — the sentence that shipped until M8c.6 states neither', () => {
    // The predicate is only worth anything if the old text fails it.
    const before = '**1. The toolchain.** Node 20 (`.nvmrc`), then:'
    expect(before).not.toContain('20.19')
    expect(before).not.toContain('22.12')
  })
})
