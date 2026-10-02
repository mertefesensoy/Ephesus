# The standing goal prompt

Paste the block below, whole, as one `/goal` command at the start of **any** session:
building, reviewing, documenting, researching or improving the company. The prompt
names no task. The session reads the record, tells the Architect where the project
stands, and asks through AskUserQuestion what to do next. After each finished task it
asks again, until the Architect ends the session.

It sits beside the milestone goal docs ([M8c](./M8c-GOAL.md), [M9](./M9-GOAL.md)) and
does not replace them. Those are **handovers**: what one milestone is, the order to
build it in, what is already decided and what must still be asked. This file is the
**condition** the goal evaluator holds every session to. When the Architect picks
milestone work, the skill already tells the session to read that milestone's goal doc
before asking anything ([ephesus-engineer §1](../.claude/skills/ephesus-engineer/SKILL.md)).

The Architect's 2026-10-03 decisions about this prompt are recorded in
[DECISIONS-LOG](./DECISIONS-LOG.md), and the reasoning is in the
[implementation record](./implementations/2026-10-03-standing-goal-prompt.md).

---

## The prompt

```text
/goal Work as the Ephesus senior software engineer; this goal serves any session. First read .claude/skills/ephesus-engineer/SKILL.md, BUILD-PROMPT.md §2's list, docs/PROGRESS.md, recent DECISIONS-LOG entries, the Gymnasium LEDGER and the open PRs. Then, before changing anything, summarize where the project stands and ask the Architect through AskUserQuestion what to do next, offering the candidates those documents name, recommendation first. After each finished task, report it and ask again. Follow the skill's questions workflow throughout: every decision is the Architect's answer to an AskUserQuestion, never a default, assumption, silence or the engineer's own recommendation.
The goal is met when ONE of these end states is visible in the transcript:
(A) DONE. After the Architect ended the session in answer to a "what next?" AskUserQuestion, the engineer printed a GOAL REPORT marked DONE in the skill's format, covering every task, where: each task was chosen, and its plan approved before any file changed, by the Architect through AskUserQuestion; every acceptance criterion and owed test of each task, and every requirement and decision ID it touched, is listed as PASS with the exact command run and an excerpt of its output from this session; every task that changed production code has a mutation round from this session whose no-op control survived; `npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs` and `node scripts/check-attribution.cjs` exited 0 in the final turn, with that output shown; docs/PROGRESS.md is updated for every package completed; for each branch committed to, its `git diff --stat` against origin/main and an in-sync `git status -sb` are shown; and a "Not proven" section states, for each claim, the platform, Node and Electron versions, whether the licensed art pack was present, the evidence tier (A-D) and what remains unverified.
(B) BLOCKED. The engineer's latest message starts with "EPHESUS-BLOCKED:" and names an Architect decision needed to continue that was asked through AskUserQuestion and came back unanswered twice (an empty, blank or timed-out answer counts as unanswered).
(C) BOUND. 200 goal turns have been evaluated and the engineer has printed a GOAL REPORT marked PARTIAL. The engineer starts every turn with "Goal turn N of 200".
These constraints must hold throughout; if any is violated, the goal is not met:
* No task, ordering, DD- item, open design choice, deviation from a requirement, invariant or accepted ADR, new dependency, toolchain change, PR, merge, or irreversible or outward-facing action is decided without an Architect answer from AskUserQuestion; a decision already recorded in docs/adr/ or docs/DECISIONS-LOG.md is cited, not re-asked.
* Each Architect answer is recorded in docs/DECISIONS-LOG.md (plus an ADR when architectural, and the DD- row it closes) before work that depends on it. The engineer's own proposals go only in the GOAL REPORT's Follow-ups or a Gymnasium proposal.
* SRS requirement text changes only on an Architect answer; an accepted ADR is superseded, never edited.
* scripts/coverage-floors.json changes only through check-coverage.cjs --update; append-only files are only appended to.
* Every commit's author and committer is MERT EFE ŞENSOY <sensoymertefe@gmail.com>, and no agent, session or model name appears in any file, commit message or PR body.
* Commits go on a feature/<topic> or fix/<topic> branch cut from current main, never on main, and are pushed to https://github.com/mertefesensoy/Ephesus
* The engineer ticks no box docs/PROGRESS.md reserves for the Architect or a non-author run (the M7, M8b and M8c exits).
* No result is claimed for a platform, Node or Electron version, or tree not run on in this session; a CI result is cited only with its run ID and commit, as tier B.
```

---

## How a session runs under it

1. **Read the record.** The ephesus-engineer skill, BUILD-PROMPT §2's reading list,
   PROGRESS, the recent DECISIONS-LOG entries, the Gymnasium LEDGER and the open pull
   requests. Nothing is changed yet.
2. **Say where things stand, then ask what next.** One AskUserQuestion whose options are
   the candidates the record names. Examples: the first unchecked PROGRESS box, a PR
   waiting for review, a Gymnasium row whose metric check or verdict is overdue, a
   register gap. The engineer's recommendation comes first, and the Architect can always
   answer something else.
3. **Do the chosen task under the protocol.** Present the plan and get it approved
   before any file changes. Ask every open decision, record each answer in DECISIONS-LOG
   before the work that depends on it, then do the work and report it with evidence.
4. **Ask what next again.** The candidates are refreshed from what the task changed. The
   session continues until the Architect answers that it is over.
5. **Close.** The GOAL REPORT covers every task the session did. The final turn runs the
   full Definition of Done chain and the attribution scan, whatever the tasks were.

There are two other ways the goal can end. If a question comes back unanswered twice, the
session stops with `EPHESUS-BLOCKED:`. After 200 turns it stops with a PARTIAL report.

## It has a length limit

The CLI refuses a `/goal` condition longer than **4,000 characters**. The check is the
argument string's JavaScript `.length` (UTF-16 code units, newlines included), read from
the installed CLI, version 2.1.261. The condition above (everything after `/goal `) is
**3,876**. Re-measure after any edit, before pasting:

```bash
node -e "const t=require('fs').readFileSync('docs/GOAL.md','utf8');const b=t.split('\`\`\`text\n')[1].split('\n\`\`\`')[0];console.log(b.replace(/^\/goal /,'').trim().length)"
```

An over-long condition is refused when you paste it, so you will see the refusal. The
cost is the edit you then have to make. Remove words, not rules: every clause below is
there because the record needed it.

## Why each clause is there

| Clause | What it holds the session to | Where the rule comes from |
|---|---|---|
| Read the record, then ask what next, before changing anything | Choosing the work is the first decision of every session, and it is the Architect's | ephesus-engineer §1 "When you must ask"; Architect decision 2026-10-03 |
| Ask again after each task; DONE only when the Architect ends the session | One paste serves a whole working session, and the Architect, not the engineer, decides when it is over | Architect decision 2026-10-03 |
| Every decision through AskUserQuestion, never on silence | Under `/goal` a prose question is followed by another turn automatically, so the Architect never gets to answer it | [ephesus-engineer §1](../.claude/skills/ephesus-engineer/SKILL.md) |
| Each task chosen, and its plan approved, through AskUserQuestion | Choosing a package from a milestone PROGRESS has not approved for building (M9) is itself the approval to start it, so no separate clause is needed | ephesus-engineer §1; [PROGRESS M9](./PROGRESS.md) |
| Acceptance criteria and owed tests, each with a command and its output | The evaluator sees only the transcript; a criterion with no output shown is a claim, not evidence | ephesus-engineer §3–§4 |
| A mutation round whose no-op control survived | Three M8b rounds reported perfect scores they had not earned | DECISIONS-LOG 2026-09-09; GYM-008 |
| The Definition of Done chain plus attribution in **every** final turn | The gate is BUILD-PROMPT §4's TEST line, and the Architect kept it for docs-only sessions too; the attribution scan is the backstop the hooks can miss | [BUILD-PROMPT](../BUILD-PROMPT.md) §4; [ENGINEERING-STANDARDS](./ENGINEERING-STANDARDS.md) §2; Architect decision 2026-10-03 |
| PROGRESS updated for every completed package | Sixteen packages once landed while PROGRESS said nothing | ephesus-engineer §4 |
| Platform, Node, Electron, art pack, evidence tier | Two measurements of one tree on one machine once disagreed because the licensed art pack was restored in one of them | ephesus-engineer §3 |
| Recorded decisions are cited, not re-asked | Three of five "lost at restart" items were already settled in the record | ephesus-engineer §1 |
| Answers in DECISIONS-LOG before dependent work | The record has to say what was decided before the work that relies on it exists | [DECISIONS-LOG](./DECISIONS-LOG.md) header; BUILD-PROMPT §8 |
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

1. **Run the final gate from a checkout outside OneDrive.** This applies to every
   session, because the full chain runs in every final turn. Inside a OneDrive-synced
   path, `npm run test:coverage` can exit 1 because vitest loses the `rmdir` of
   `coverage\.tmp` to OneDrive's file handle. It has done so after every test passed
   (DECISIONS-LOG 2026-09-10, M8c.3b; PROGRESS M8's gate caveat). On 2026-10-03 it did so
   at startup, before a single test ran: a run of zero tests, which proves nothing. The
   prompt requires exit 0 and must not be weakened, so run the chain somewhere it can
   return 0 and say where it ran. One way is a detached `git worktree add` outside
   OneDrive. A worktree under `.claude/worktrees/` usually has no `node_modules` of its
   own and borrows the main checkout's by walking up the folder tree. A worktree
   elsewhere has nothing to walk up to, so junction the main checkout's `node_modules`
   into it, after checking every installed version against that commit's
   `package-lock.json`. Remove the junction with `cmd /c rmdir`, never recursively.
2. **The `goal` name is shared.** This repository has a project skill named `goal`
   (`.claude/skills/goal/`, the M3-era milestone runner), and the CLI has a built-in
   `/goal` (*"Set a goal — keep working until the condition is met"*). This file did
   **not** establish which one a typed `/goal` reaches here. The check in this file's
   implementation record was blocked by an expired CLI sign-in. The first time you paste
   the prompt, confirm the CLI answers that a goal is set. If the skill loads instead, set
   the goal from a directory without that skill, or bring the rename to the Gymnasium
   (AUTOMATION's change policy routes skill changes through `/improve`).
