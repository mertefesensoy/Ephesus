# The standing goal prompt

Paste the block below, whole, as one `/goal` command. It does not name a milestone: the
Architect chooses the scope inside the session, through AskUserQuestion, and the prompt
holds the session to the same contract whatever the scope turns out to be.

It sits beside the milestone goal docs ([M8c](./M8c-GOAL.md), [M9](./M9-GOAL.md)); it does
not replace them. Those are **handovers**: what one milestone is, the order to build it
in, what is already decided and what must still be asked. This file is the **condition**
the goal evaluator holds every session to. The skill already tells the session to read the
milestone's goal doc before asking anything
([ephesus-engineer §1](../.claude/skills/ephesus-engineer/SKILL.md)), so this prompt does
not repeat what those docs say.

The Architect's 2026-10-03 decisions about this prompt are recorded in
[DECISIONS-LOG](./DECISIONS-LOG.md), and the reasoning in the
[implementation record](./implementations/2026-10-03-standing-goal-prompt.md).

---

## The prompt

```text
/goal Work as the Ephesus senior software engineer. First read .claude/skills/ephesus-engineer/SKILL.md, BUILD-PROMPT.md §2's reading list and docs/PROGRESS.md, and follow the skill's questions workflow for the whole goal: every Architect decision is asked through AskUserQuestion and answered by the Architect, never by default, assumption, silence or the engineer's own recommendation.
The goal is met when ONE of these end states is visible in the transcript:
(A) DONE. The engineer has printed a GOAL REPORT marked DONE, in the format defined in the skill, where: the scope (milestone, package or finding) was chosen by the Architect through AskUserQuestion in this session; if docs/PROGRESS.md does not record approval to build the chosen milestone (M9: "build NOT started"), the Architect approved the start through AskUserQuestion before work began; the plan was approved through AskUserQuestion before any code was written; every acceptance criterion and owed test of the chosen scope (per PROGRESS, IMPLEMENTATION and any milestone plan), and every requirement and decision ID the work touched, is listed as PASS with the exact command run and an excerpt of its output from this session; every package that changed production code has a mutation round from this session whose no-op control survived; `npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs` and `node scripts/check-attribution.cjs` were run in the final turn and exited 0, with that output shown; docs/PROGRESS.md is updated for every package completed; `git diff --stat origin/main...HEAD` and `git status -sb` (branch in sync with origin) are shown; and a "Not proven" section states, for each claim, the platform, Node and Electron versions, whether the licensed art pack was present, the evidence tier (A-D) and what remains unverified.
(B) BLOCKED. The engineer's latest message starts with "EPHESUS-BLOCKED:" and names an Architect decision needed to continue that was asked through AskUserQuestion and came back unanswered twice (an empty, blank or timed-out answer counts as unanswered).
(C) BOUND. 200 goal turns have been evaluated and the engineer has printed a GOAL REPORT marked PARTIAL. The engineer starts every turn with "Goal turn N of 200".
These constraints must hold throughout; if any is violated, the goal is not met:
* No scope, ordering, DD- item, design choice the SRS or SDD leaves open, deviation from a requirement, invariant or accepted ADR, new dependency, toolchain change, pull request, merge, or irreversible or outward-facing action is decided without an Architect answer from AskUserQuestion. A decision already recorded in docs/adr/ or docs/DECISIONS-LOG.md is cited, not re-asked.
* Each Architect answer is recorded in docs/DECISIONS-LOG.md (plus an ADR when architectural, and the DD- row it closes) before code that depends on it is written. The engineer's own proposals go only in the GOAL REPORT's Follow-ups or a Gymnasium proposal.
* No SRS requirement text is changed without an Architect answer authorizing that change; an accepted ADR is superseded, never edited.
* scripts/coverage-floors.json changes only through check-coverage.cjs --update, and append-only files are only appended to.
* Every commit's author and committer is MERT EFE ŞENSOY <sensoymertefe@gmail.com>, and no agent, session or model name appears in any file, commit message or PR body.
* Work happens on a feature/<topic> or fix/<topic> branch cut from current main, never on main; everything is pushed to https://github.com/mertefesensoy/Ephesus
* The engineer ticks no box docs/PROGRESS.md reserves for the Architect or a non-author run (the M7, M8b and M8c exits).
* No result is reported for a platform, Node or Electron version, or tree it was not actually run on in this session; a CI result is cited only with its run ID and commit, as tier B.
```

---

## It has a length limit

The CLI refuses a `/goal` condition longer than **4,000 characters**. The check is the
argument string's JavaScript `.length` (UTF-16 code units, newlines included), read from
the installed CLI, version 2.1.261. The condition above (everything after `/goal `) is
**3,913**. Re-measure after any edit, before pasting:

```bash
node -e "const t=require('fs').readFileSync('docs/GOAL.md','utf8');const b=t.split('\`\`\`text\n')[1].split('\n\`\`\`')[0];console.log(b.replace(/^\/goal /,'').trim().length)"
```

An over-long condition is refused when you paste it, so you will see the refusal. The
cost is the edit you then have to make. Remove words, not rules: every clause below is
there because the record needed it.

## Why each clause is there

| Clause | What it holds the session to | Where the rule comes from |
|---|---|---|
| Every decision through AskUserQuestion, never on silence | Under `/goal` a prose question is followed by another turn automatically, so the Architect never gets to answer it | [ephesus-engineer §1](../.claude/skills/ephesus-engineer/SKILL.md) |
| Approval to build the chosen milestone | M9 is approved for planning only; a session resuming there asks whether the build may start | [PROGRESS M9](./PROGRESS.md), [M9-GOAL](./M9-GOAL.md) |
| Acceptance criteria and owed tests, each with a command and its output | The evaluator sees only the transcript; a criterion with no output shown is a claim, not evidence | ephesus-engineer §3–§4 |
| A mutation round whose no-op control survived | Three M8b rounds reported perfect scores they had not earned | DECISIONS-LOG 2026-09-09; GYM-008 |
| The Definition of Done chain plus attribution in the final turn | The gate is BUILD-PROMPT §4's TEST line; the attribution scan is the backstop the hooks can miss | [BUILD-PROMPT](../BUILD-PROMPT.md) §4; [ENGINEERING-STANDARDS](./ENGINEERING-STANDARDS.md) §2 |
| PROGRESS updated for every completed package | Sixteen packages once landed while PROGRESS said nothing | ephesus-engineer §4 |
| Platform, Node, Electron, art pack, evidence tier | Two measurements of one tree on one machine once disagreed because the licensed art pack was restored in one of them | ephesus-engineer §3 |
| Recorded decisions are cited, not re-asked | Three of five "lost at restart" items were already settled in the record | ephesus-engineer §1 |
| Answers in DECISIONS-LOG before dependent code | The record has to say what was decided before the code that relies on it exists | [DECISIONS-LOG](./DECISIONS-LOG.md) header; BUILD-PROMPT §8 |
| SRS text and accepted ADRs | ADRs are append-only and CI enforces it; requirement text changes only on the Architect's word | [CLAUDE.md](../CLAUDE.md); [AUTOMATION](./AUTOMATION.md) CI |
| Coverage floors only through `--update` | `coverage-floors.json` is the one place a coverage figure is written, with its condition | [AUTOMATION](./AUTOMATION.md) CI |
| The Architect's sole authorship, no agent, session or model name | The repository has to read as one person's work, and the attribution script does not read prose | ENGINEERING-STANDARDS §2 |
| A named branch, pushed | `main` is protected; a branch that exists only on one machine cannot be reviewed or resumed | [CLAUDE.md](../CLAUDE.md) conventions; Architect decision 2026-10-03 |
| No author-ticked exit box | M7, M8b and M8c close on T1's first live row, which is the Architect's to tick | DECISIONS-LOG 2026-10-02 (DD-M9-7) |
| No result for a platform not run on; CI only with its run ID | Coverage floors and mutation scores are specific to a machine | ephesus-engineer §3 rule 8 |

The prompt says **the engineer** where the ONFLY prompt it was modelled on names the
assistant. The first sentence defines the role, so the evaluator can tell who is meant,
and the tree stays free of a model name (ENGINEERING-STANDARDS §2).

## Two conditions a DONE run has to meet on this machine

1. **Run the final gate from a checkout outside OneDrive.** Inside a OneDrive-synced
   path, `npm run test:coverage` can exit 1 *after every test passed*, because vitest
   loses the `rmdir` of `coverage\.tmp` to OneDrive's file handle (DECISIONS-LOG
   2026-09-10, M8c.3b; PROGRESS M8's gate caveat). The prompt requires exit 0 and must
   not be weakened, so run the chain somewhere it can return 0 and say where it ran.
2. **The `goal` name is shared.** This repository has a project skill named `goal`
   (`.claude/skills/goal/`, the M3-era milestone runner), and the CLI has a built-in
   `/goal` (*"Set a goal — keep working until the condition is met"*). This file did
   **not** establish which one a typed `/goal` reaches here. The check in this file's
   implementation record was blocked by an expired CLI sign-in. The first time you paste
   the prompt, confirm the CLI answers that a goal is set. If the skill loads instead, set
   the goal from a directory without that skill, or bring the rename to the Gymnasium
   (AUTOMATION's change policy routes skill changes through `/improve`).
