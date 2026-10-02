# The standing goal prompt

**Date:** 2026-10-03 · **Branch:** `docs/standing-goal-prompt` (from `main` at
`f048eb3`) · **Scope:** documentation only. No file under `src/`, `scripts/`, `test/` or
`.claude/` changes.

---

## 1. Problem / motivation

The Architect drives a session with the CLI's built-in `/goal`. It takes a condition, and
after every turn a separate evaluator reads the transcript and decides whether the
condition is met. The Architect's ONFLY project has a goal written for that evaluator. It
defines three end states (DONE, BLOCKED, BOUND) and a list of constraints that void the
goal if any is broken. Ephesus had nothing in that shape:

- [`M8c-GOAL.md`](../M8c-GOAL.md) and [`M9-GOAL.md`](../M9-GOAL.md) are **handovers** for
  one milestone each. They are instructions, not a condition an evaluator can check, and
  they go stale when their milestone closes.
- `.claude/skills/goal/SKILL.md` still says *"M3, resuming at M3.1"* (2026-08-27). It is
  a run driver, not a condition.
- Without a condition, a `/goal` session decides for itself when it is done. Under
  `/goal` a prose question is followed by another turn automatically
  ([ephesus-engineer §1](../../.claude/skills/ephesus-engineer/SKILL.md)). The two
  defaults the protocol forbids are exactly what that rewards: deciding on silence, and
  calling a package done without evidence shown in the transcript.

`M8b-GOAL.md` was written and never committed, and the session that needed it could not
find it. That is why this prompt is committed and linked rather than left in chat.

## 2. What changed

| File | Change |
|---|---|
| `docs/GOAL.md` | New. The standing `/goal` prompt, its length limit and how to measure it, a table of why each clause exists, and two conditions a DONE run has to meet on this machine. |
| `docs/AUTOMATION.md` | Adds a "Goal prompts" table under Skills, linking `GOAL.md` and the milestone goal docs, so a session can find them. |
| `docs/DECISIONS-LOG.md` | Appends one entry recording the Architect's four answers (2026-10-03). |
| `docs/implementations/2026-10-03-standing-goal-prompt.md` | This record. |

## 3. Implementation approach

**Clause-for-clause translation, not a new design.** The ONFLY goal was taken as the
template, because the Architect asked for one "just like" it. Each clause was mapped to
the Ephesus document that already states the same rule. Nothing in the prompt is a new
rule. Where a clause needed a source, it cites one that already governs Ephesus:

| ONFLY clause | Ephesus clause | Source in this repository |
|---|---|---|
| Read `onfly-engineer/SKILL.md` and `ONFLY-SRS.md` | Read `ephesus-engineer/SKILL.md`, BUILD-PROMPT §2's reading list and `PROGRESS.md` | BUILD-PROMPT §2 (which does not itself list PROGRESS) |
| Phase or gate chosen by the owner | Scope (milestone, package or finding) chosen by the Architect | ephesus-engineer §1 "When you must ask" |
| TBD-15 phase ordering signed off first | Approval to build the chosen milestone, when PROGRESS does not record it | PROGRESS M9: "APPROVED FOR PLANNING … build NOT started" |
| *(implicit)* | The plan approved before any code | ephesus-engineer §1: "Present the plan, then ask" |
| ONFLY-SRS §9 exit criteria, each PASS with command and output | PROGRESS / IMPLEMENTATION / milestone-plan acceptance criteria and owed tests, each PASS with command and output | BUILD-PROMPT §4 PROVE; ephesus-engineer §4 |
| *(none)* | A mutation round whose no-op control survived | DECISIONS-LOG 2026-09-09; GYM-008; the M8c and M9 bars |
| Tests for touched code, final turn, exit 0 | The full Definition of Done chain plus `check-attribution.cjs`, final turn, exit 0 | BUILD-PROMPT §4 TEST line; Architect answer 3 |
| `git diff --stat` | `git diff --stat origin/main...HEAD` and `git status -sb` | Architect answer 2: the push must be visible |
| Not proven: platform, compiler, float backend | Not proven: platform, Node, Electron, art pack, evidence tier | ephesus-engineer §3 |
| `ONFLY-BLOCKED:` after two unanswered asks | `EPHESUS-BLOCKED:` after two unanswered asks | ephesus-engineer §1 "Unanswered questions" (same rule, same prefix) |
| 200 turns, PARTIAL report | Unchanged | — |
| Answers in SRS Appendix A.1/B, proposals in A.2 | Answers in DECISIONS-LOG (plus an ADR and the DD- row); proposals only in Follow-ups or a Gymnasium proposal | DECISIONS-LOG header; ephesus-engineer §1 "Recording answers" |
| No SRS text changed without an answer | Same, plus an accepted ADR is superseded, never edited | CLAUDE.md; CI's ADR append-only check |
| Generated layout files never hand-edited | `coverage-floors.json` only through `--update`; append-only files only appended to | AUTOMATION CI section; BUILD-PROMPT §3 |
| Everything pushed to the ONFLY remote | A feature/fix branch from current main, never main, pushed to the Ephesus remote | CLAUDE.md conventions; Architect answer 2 |
| No result for a platform not run on | Same, plus a CI result cited only with its run ID and commit, as tier B | ephesus-engineer §3 tiers |
| *(none)* | The Architect's sole authorship; no agent, session or model name | ENGINEERING-STANDARDS §2 |
| *(none)* | No exit box the record reserves for the Architect is ticked | DECISIONS-LOG 2026-10-02 (DD-M9-7) |

**The evaluator sees only the transcript.** Every DONE clause names something that
can be printed: a command, its output, a diff stat, a branch status line, a report
section. A clause the evaluator cannot see could never be satisfied. It would turn every
run into BOUND.

**"The engineer", not a model name.** The ONFLY text names the assistant as the actor.
Ephesus forbids an agent, session or model name in the tree, including prose
(ENGINEERING-STANDARDS §2), and neither the milestone goal docs nor the skill names one.
The prompt's first sentence defines the role, *"Work as the Ephesus senior software
engineer"*, and the rest of the prompt refers to "the engineer". The evaluator has one
actor to attribute it to, so nothing is lost.

## 4. Mathematical / numeric details

The only numeric rule is the length limit.

- **The limit.** The installed CLI (version 2.1.261) checks the `/goal` argument with
  `if (e.length > 4000)` and refuses it with *"Goal condition is limited to 4000
  characters"*. This was read from the CLI's own bundle. The constant appears there as
  `aUe=4000`.
- **What is counted.** JavaScript `String.prototype.length` counts UTF-16 code units.
  Every character in the prompt is in the Basic Multilingual Plane, including `Ş` (U+015E)
  and `§` (U+00A7), so each counts as 1. Newlines count as 1 each. There are 13 in the
  prompt's 14 lines.
- **The measure used.** `L = text.trim().length`, where `text` is everything after
  `/goal ` in the fenced block. For this version, **L = 3,913**, which is 87 under the
  limit. Collapsing whitespace changes nothing here (no doubled spaces).
- **Why the margin matters.** An edit that adds a clause usually adds 80 to 200
  characters, so one more clause is likely to need a trim elsewhere. `docs/GOAL.md` gives
  the measuring command so the check takes seconds.

The draft went through three measured versions: 4,163 (over the limit), 3,952 (too thin
a margin once the actor was renamed "the engineer"), and 3,913. The cuts were wording only. No
rule was dropped.

## 5. Design decisions

The Architect answered four questions through AskUserQuestion, each with the
recommendation first. All four are recorded in DECISIONS-LOG 2026-10-03.

1. **Where it lives: `docs/GOAL.md`.** Rejected: also rewriting the stale
   `.claude/skills/goal/SKILL.md`. AUTOMATION's change policy sends skill changes through
   `/improve`, which would mean filing a Gymnasium proposal before the prompt could land.
   Also rejected: chat only, which is how `M8b-GOAL.md` was lost.
2. **"Everything is pushed".** Pasting the goal is the Architect's standing request to
   push to a feature or fix branch. Opening a PR and merging remain must-asks. Rejected:
   push only on an answer. That keeps ephesus-engineer §5's default, but a DONE would then
   show a branch that exists on one machine only.
3. **The full Definition of Done chain in the final turn.** Rejected: typecheck plus the
   touched tests. That is closer to ONFLY's wording, but lint, the invariant tripwires and
   the coverage floors would go unproven, and those are the gates that have caught what
   suites miss.
4. **This change lands on `docs/standing-goal-prompt`, pushed, with no PR.** The worktree
   was cut on an auto-named branch whose prefix is outside the branch convention, so the
   work moved to a branch named for its topic. The `docs/` prefix follows PR #67's branch.

Choices made without asking, because a recorded rule already settled them:

- **A mutation round with a control is a DONE requirement for production code.** It is
  the recorded bar of M8c and M9 (GYM-008) and ephesus-engineer §3 rule 5. It is limited
  to packages that change production code, because a docs-only scope has nothing to
  mutate.
- **No author-ticked exit box.** Recorded 2026-10-02 (DD-M9-7) and in every milestone
  goal doc.
- **The turn limit stays at 200**, as in the template. Nothing in the Ephesus record
  argues for a different number.

## 6. Verification

Run from the repository root.

1. **The prompt fits the CLI's limit.** Run the command in `docs/GOAL.md` under "It has a
   length limit". Expected: `3913`, and any value up to 4,000 passes. Observed this
   session (win32, Node 20.16.0): `3913`.
2. **The committed block is the one that was measured.** Extract the block and `cmp` it
   against the measured draft. Observed this session: byte-identical.
3. **No agent, session or model name in the change.** Scan the added lines
   (`git diff origin/main...HEAD | grep "^+"`) for the vendor, model-family and
   session-identifier spellings that `scripts/check-attribution.cjs` looks for in
   trailers. The only hits should be the `.claude/skills/...` paths and links to
   `CLAUDE.md`, which are file names, not attribution. The script itself does not read
   prose, so this scan is a manual step.
4. **Links resolve.** CI's *Docs integrity* job checks every relative markdown link.
   Locally, run its link loop from `.github/workflows/ci.yml`.
5. **Attribution.** `node scripts/check-attribution.cjs` exits 0.
6. **Live check, owed to the Architect.** Paste the prompt into `/goal` once and confirm
   the CLI reports a goal set, not the project `goal` skill loading. See §7.

## 7. Not proven

- **Which `/goal` wins in this repository.** The project skill `.claude/skills/goal/` and
  the built-in `/goal` share a name. A test in a scratch directory with a stand-in `goal`
  skill was attempted by running the CLI in print mode (`-p "/goal"`). It could not run:
  the CLI subprocess answered *"OAuth session expired and could not be refreshed"*, and
  signing in was not attempted. Two facts are consistent with the built-in winning, but neither proves it.
  ephesus-engineer §4 describes evaluator behaviour learned from earlier `/goal`
  sessions. `M8c-GOAL.md` was written to be pasted into `/goal`, and M8c landed. If the
  skill does win, the remedy is a Gymnasium proposal to rename it.
- **The 4,000 limit is version-specific.** It was read from CLI 2.1.261 on win32. A
  different CLI version may change it.
- **No goal session has run against this prompt yet.** Whether the evaluator reads every
  clause as intended is known only after the first session.

## 8. Related docs

- [`docs/GOAL.md`](../GOAL.md): the prompt
- [ephesus-engineer skill](../../.claude/skills/ephesus-engineer/SKILL.md): the questions workflow, GOAL REPORT format and evidence tiers the prompt points to
- [`M9-GOAL.md`](../M9-GOAL.md), [`M8c-GOAL.md`](../M8c-GOAL.md): milestone handovers
- [AUTOMATION](../AUTOMATION.md): where goal prompts are listed, and the change policy for skills
- [DECISIONS-LOG](../DECISIONS-LOG.md): 2026-10-03, the four answers
