# Ephesus — Test Strategy

**Status:** binding for CI gates. Maps to SRS acceptance criteria (§6) and NFRs.

---

## 1. What makes this system hard to test — and the stance

Ephesus is a harness around *nondeterministic* processes (LLM CLIs) doing *real* side
effects (git, files, network) coordinated through *timing-sensitive* mechanisms
(fs-watch, sockets, hooks). The stance:

1. **Determinize the boundary, not the world.** Every nondeterministic dependency
   (engine CLI, voice provider, GitHub, clock) sits behind a seam that tests replace
   with a scripted fake. The mechanisms *between* seams — Hermes, the Agora, the
   Odeon gates, the breaker — are deterministic and get exhaustive coverage.
2. **The fake agent is a first-class test asset.** `test/fakes/fake-engine` is a real
   CLI binary that speaks the adapter contract: spawns in a PTY, emits scripted hook
   events, reads its inbox, writes outbox messages, exits on cue. Most integration
   tests are scripts for fake agents.
3. **Real-engine tests exist but don't gate merges.** A small live suite (needs a
   Claude Code login) runs nightly and before release, not per-PR.

## 2. The pyramid

| Level | Runner | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | Pure logic: schema validators, message rules (hop caps, obligation table), memo-policy matcher, briefing fact compiler, cost folding, breaker signal math, token/contrast checks | per-PR |
| Integration (main-process) | Vitest + real fs/git in temp dirs | Hermes end-to-end with fake agents; Agora committer under concurrency; Stop-hook decisioning; gate/memo flows; profile activation; ledger transitions | per-PR |
| Contract/conformance | Vitest | Engine adapters & voice adapters against recorded fixtures (§5) | per-PR |
| E2E (app) | Playwright + Electron | Boot app, spawn fake agents, drive real UI: floor states, approvals, Odeon panels, kanban, settings | per-PR (smoke) + nightly (full) |
| Live | Playwright/scripted | Real Claude Code, real voice keys (opt-in), real GitHub sandbox repo | nightly + release |
| Evals | custom runner | Agent-behavior quality (§6) | weekly + release |

Coverage is measured (`npm run test:coverage`, v8 provider) and gated as a
**per-subsystem ratchet**, never as an overall number: `scripts/coverage-floors.json`
records each subsystem's measured floor beside the condition it was measured in;
`scripts/check-coverage.cjs` fails CI when a subsystem falls below its floor or a
production file lands that no test reaches; floors rise by re-measurement and fall
only by a reviewed edit with a reason. The ≥ 90 % branch target for the mechanisms
(hermes/agora/odeon/watch) stays a target, and the floors file shows each one's
distance from it. Overall line coverage is still *not* a gate (it incentivizes junk
tests); mutation testing on the message-rule and gate-policy modules quarterly.
*(Amended at M8.0, GYM-006; the rule it enforces is ENGINEERING-STANDARDS §6.7.)*

A mutation round — how one is run, what it refuses, and what a survivor obliges — is
§10 *(GYM-008)*.

## 3. Scenario suites (the tests that matter)

Named suites mirroring SRS acceptance criteria — each is an integration/E2E script:

- **S-BLACKOUT** (SRS 6.6): kill main mid-delivery / mid-commit at injected fault
  points; restart; assert zero loss, zero double-processing, committer reconcile.
  **Amended M8.8 (ADR-0027):** the restart must happen with the company's
  coordination state LIVE — an activation, an open gate and a fired trigger —
  and not only with data in flight. Every case written before M8.8 restarted a
  company that was holding *nothing* (`liveAgents: () => []`, a fresh deny-all
  `GateManager`), so "restore exactly" was asserted over an empty set and passed
  for the life of the project while a restart silently un-hired the company.
  A scenario that restarts holding nothing cannot fail the way production does.
- **S-LIVELOCK**: two fake agents scripted to ping-pong; assert hop-cap diversion to
  Artemis at exactly the cap, log records, no delivery loop.
- **S-BOUNCE**: mail to archived/missing agent; assert `refuse` bounce + log, sender
  notified, nothing dropped.
- **S-WAKE**: mail lands while agent idle; assert watchdog nudge exactly once, no
  stale nudges, cursor idempotency on replay.
- **S-STOPLOOP**: fake engine's Stop hook cycles with pending mail; assert
  `stop_hook_active` respected, hard block-cap honored, breaker rung 1 on pathology.
- **S-DECKGATE** (SRS 6.3): `review:deck` task refuses `done` until deck exists;
  deck renders in-app; comment → follow-up task.
- **S-MEMO** (SRS 6.4): policy trigger (fake dependency add) holds the action;
  memo → Artemis delegated verdict (countersigned) vs Architect queue; rejection
  reverses; archive immutable.
- **S-GATE**: destructive op deny-by-default; remote approval path tags `remote`;
  voice approval requires repeat-back (policy layer test with scripted STT).
- **S-BRIEF** (SRS 6.2): seeded ledger/log/budget fixtures → compiled brief; assert
  every narrative sentence carries source refs and refs resolve; ≤ 90 s at configured
  wpm.
- **S-MEETING**: convene 3 fake agents; assert turn order enforcement, interjection
  floor-grab, minutes + action items in board/ledger.
- **S-FAILOVER** (SRS 6.5): scripted ElevenLabs adapter failure mid-utterance →
  OpenAI Realtime continues ≤ 3 s; both down → text-only banner, briefs still
  generated.
- **S-BREAKER**: scripted repetition/error-storm/burn-rate fixtures walk the ladder
  steer→constrain→stop; assert work preserved, ledger `stalled`, brief mentions trip.
- **S-LEDGER**: cost folding across restart — the upstream regression class: assert
  cumulative figure survives restart and session figure resets, sourced from
  transcript fixtures.
- **S-SECRETS**: broker write-only (no read IPC exists — asserted by API surface
  test); env grants least-privilege per hire; redaction filter masks a planted token
  in PTY stream.
- **S-PROFILE**: activate Skeleton Crew on a fixture repo; fake CI webhook →
  triage task auto-created → playbook path; assert stricter-wins autonomy
  composition.
- **S-CRASH**: SIGKILL a fake agent mid-task; ghost → archive, task back to `todo`,
  respawn offer; resume path where adapter supports it.
- **S-GYM** (SRS 6.7, FR-12): proposal missing a metric or rollback is rejected before
  reaching a human; a non-architect verdict on `gym.verdict` is refused; a proposal
  altering gym gating / an accepted ADR / Watch maxima is mechanically refused
  regardless of approver; a landed fixture proposal whose metric misses its window is
  rolled back and ledgered `regressed`; ledger rows are append-only.
- **S-STOA** (SRS 6.8, FR-13): fixture watched repo with a planted applicable pattern
  *and* a planted instruction addressed to the reader — the brief must cite the
  pattern (`repo@commit` + path) and report the instruction as a finding, never obey
  it; a brief with an uncited finding is rejected before reaching a human; watchlist
  registration through a non-architect path is refused; a `license: "unverified"`
  source allows study but refuses pattern intake; the researcher spawn plan carries
  no secret grants and a read-only checkout.
- **S-CLOSING** (GYM-003): closing time over real rails — requests land in every
  live inbox; real fake-engine processes append `memory.md` and acknowledge
  through their outboxes; all-ack resolves the protocol with the exchange in
  `log.jsonl` (`kind: shutdown`); a silent agent is named at the hard deadline;
  an ack with no closing in flight bounces ("no closing time is in progress");
  reentry while in flight is refused.
- **S-MODE** (SRS 6.9, FR-14): enabling `improving` with proof evidence missing is
  refused with the missing items listed; a fixture ledger meeting the §6.9 gate
  enables; records produced under autonomy carry the mode tag; a rung-3 breaker stop
  on gym/stoa work auto-reverts to `directed` and lands on the ledger; no agent-side
  path (Hermes message, hook, proposal) can change the mode.
- **S-RECURSE** (SRS 6.10, FR-9.5/FR-10.5): the Recursive Improvement profile over a
  fixture clone of the company's own repo and a scripted `gh` seam — activation in
  `directed` refused naming the missing §6.9 evidence; an approved fixture proposal
  yields an `agent/` branch and a PR under the company identity whose body cites its
  GYM and RB ids; commits carry company authorship + the agent co-author trailer and
  no Architect or vendor identity; no code path can merge or push `main` (asserted by
  API surface, the S-SECRETS pattern); the researcher role's spawn plan carries no
  GitHub grant while the improver's does; revoking the broker token fails delivery
  visibly and nothing else.

- **S-NATIVE** (SRS 6.11, FR-15; *planned M9.2–M9.4*): one `native` hire against a
  scripted OpenAI-compatible fake provider under `test/fakes/`; mail-in → tool call
  → mail-out → Stop → `block` continuation → idle; the block cap holds; a stall of N
  empty turns ends the turn as a visible degradation; an endpoint that dies mid-turn
  is a degradation and a `ghost`, never a hang; compaction leaves the stable tier
  byte-identical and the ledger total differs by exactly the compaction call;
  containment refuses `..`, a symlink and a junction (via `lstat`); a destructive
  shell call is HELD as a `native-tool` gate — approval runs it, rejection does not,
  a `prefix` grant runs without a gate, an undeclared command never does; the
  API-surface test (S-SECRETS pattern) that no tool reaches outside containment
  without a gate; the provider key never appears in argv, transcript or log.
- **S-BENCH** (SRS 6.11, FR-16; *planned M9.1*): the scorer DISCRIMINATES — a
  scripted good run passes; each named failure mode (an un-gated destructive act,
  a parked prompt, an abandoned task, a ledger total that disagrees with the
  transcript, a silence longer than the task's bound) fails it by name; a row with
  a missing condition field is refused by the ledger validator; a cell with fewer
  than three runs is flagged; the runner is refused `watch:approve` by the control
  surface; two rows differing in condition cannot be averaged.

## 4. E2E specifics (Electron + Playwright)

- App boots against a temp harness home; fake engines injected via adapter registry
  env override.
- Floor assertions read the scene's *state model*, not pixels (avatar id → state,
  position, station); one visual-regression snapshot suite covers panel chrome and
  each avatar state sprite at 3 zoom levels.
- Reduced-motion mode has an information-parity suite: every scenario asserted in
  normal mode re-runs with animations off and must expose identical state via labels
  (NFR-15).
- Keyboard map: every documented shortcut has a test.

## 5. Conformance suites (the extensibility guarantee, NFR-12)

- **Engine adapters:** a table-driven suite every adapter must pass: spawn/interrupt/
  kill lifecycle, identity injection observable in-session, hook grade honesty
  (declared grade matches demonstrated events), settings-file hygiene (local variant
  only, backup, uninstall), transcript reader against fixtures. The reference
  (claude) adapter additionally runs the live suite nightly.
  **Four subjects from M9.2** (ADR-0036): `claude`, the two unregistered partial
  adapters, and `native` — the native adapter passes every row including autonomy
  in both directions and settings hygiene (it writes nothing into any cwd). A table
  that passes by special-casing one subject has misread ADR-0024 and ADR-0036 alike.
- **Voice adapters:** contract tests over recorded fixtures — stream start latency,
  cancel latency (barge-in ≤ 250 ms simulated), error taxonomy mapping (auth vs
  transient vs latency-breach → correct failover state machine transitions).
- A new adapter PR is *only* its adapter + passing conformance run — any core diff
  fails the import-boundary lint (ENGINEERING-STANDARDS §1).
- **Every output the adapter MATCHES on is a recorded capture, never a string we
  wrote.** Version lines, auth status, capacity messages: the bytes live in
  `test/fixtures/engine-output/` with their command, engine version, platform and
  date in `PROVENANCE.json`, and the tests run the shipped matcher over them.
  `scripts/check-invariants.cjs` fails on a declared probe with neither a capture
  nor a written waiver (ENGINEERING-STANDARDS §6.8). M8.4 is why: a matcher
  written against imagined output passed forty-five tests while being unable to
  read a single byte the real CLI prints.

## 6. Agent-behavior evals (quality, not correctness)

Weekly and pre-release, with real engines, scored by rubric (LLM-judged with human
spot-check), non-gating but tracked as trend lines in the org panel:

- **E-DECOMP**: 10 canned directives → Artemis task specs; rubric: self-contained,
  right-sized, correctly routed by capability.
- **E-ESCALATE**: 20 borderline requests → does Artemis escalate exactly the critical
  ones (precision *and* recall against a labeled set)?
- **E-MEMO-Q**: memo quality rubric: real options, honest blast radius, rollback
  present.
- **E-BRIEF-FAITH**: generated brief vs ground-truth fixture ledger — hallucination
  rate must be zero (any unref'd claim fails the run; this one *does* gate release).
- **E-PLAYBOOK**: incident drill on the fixture repo — time-to-triage and
  playbook adherence.
- **E-GYM**: seeded operating records (metrics, log, breaker/budget fixtures with
  planted friction) → does Artemis surface the *planted* improvement opportunities,
  and are its proposals valid per FR-12.2 (evidence-ref'd, single-scoped, falsifiable
  metric, honest rollback)? Precision matters more than recall — speculative
  unreferenced proposals fail the run. Tracked alongside the live Gymnasium health
  ratio (validated vs regressed) from the ledger.
- **E-STOA**: a fixture source seeded with planted applicable patterns (and noise) →
  does the researcher surface the *planted* patterns with correct citations and an
  honest applicability mapping? Same precision bias as E-GYM: an uncited or
  speculative finding fails the run. Tracked alongside the Stoa's live health
  metrics (approved proposals per brief; validated ratio of Stoa-seeded proposals).

**The bench is not an eval** (FR-16, *planned M9*). Evals judge quality by rubric;
the bench scores facts the harness recorded — outcome by verifier, time, cost,
parked prompts, un-gated acts, silences, redundant reads, recovery — under an
ablation protocol, and its rows are the trend line this section always said the
org panel should show. Its judged half is owed and not faked, the same stance
E-PLAYBOOK and E-STOA take.

## 7. Performance & soak

- Bench harness (nightly): 15 fake agents at realistic event rates — assert NFR
  budgets: delivery p95 ≤ 500 ms, hook→state p95 ≤ 200 ms, floor ≥ 60 fps (frame
  timing probe), 30-agent degraded mode holds 30 fps.
- 24 h soak weekly: memory ceiling flat (leak budget < 2 MB/h), zero fd leaks, Agora
  repo growth linear with events, watchdog false-nudge count = 0.
- Startup: cold boot to interactive floor ≤ 4 s with 10 restored agents.

## 8. CI gates summary

Per-PR: typecheck · lint (incl. boundaries, token/hex, secret tripwires) · unit ·
integration · conformance · E2E smoke · schema-migration check (changed schema ⇒
bumped version + migration test).
Nightly: full E2E · live engine suite · bench.
Weekly: soak · evals · mutation (rotating).
Release: everything + S-suite full pass + E-BRIEF-FAITH gate + `npm audit` policy +
signed builds smoke-launched on all three OSes.

## 9. The one criterion no suite can cover

[SRS §6.1](./srs/SRS.md) — the one-hour company test — asks whether a real agent
handed a real broken test triages it correctly within the hour. Every level above
runs against the fake-engine rig, deterministically, which is exactly what makes
them useful and exactly why none of them can answer that question: judgment is
what the rig replaces. M8 adds two more conditions no fixture can satisfy — the
run must be performed by **a developer who is not the author, from a clean clone,
following only the README**, and it must survive a deliberate restart mid-run.

So it is executed by a person, and the record of that execution is the evidence.
The runbook is **[`docs/EXIT-M8.md`](./EXIT-M8.md)**: it names, for each clause,
the log `kind`/`event` its evidence lands under, the panel it appears in, and
what a *vacuous* pass looks like written down — because "filed the required memo
if the fix crossed policy" is satisfied when nothing crossed policy, and a tired
person writes nothing rather than saying so.

It lives in its own file rather than here for the reason this document exists:
§1–§8 say what tests are owed and which level owns them; that is an operator
runbook for one human doing one run by hand. Folding it in would make this
document answer two questions in one voice.

## 10. The mutation round (GYM-008)

A round plants one hand-aimed change at a time in the code a package claims to defend,
runs that package's test files against each, and puts the file back. It is how this
project tells a test that can fail from one that cannot — M6's close-out ran 22
mutations against its recorded guarantees and 18 survived — and it has been the third
leg of the verification bar since M8. It is evidence an author runs, not a CI job, and
its mutants are aimed by hand at the sentence the package is about: a generator
produces mostly equivalent mutants, which this project treats as a design smell rather
than a score.

**Running one.** Commit the package first, then:

```bash
node scripts/mutate.cjs test/mutation/<package>.json --check
node scripts/mutate.cjs test/mutation/<package>.json
```

`--check` validates the spec and its anchors and runs nothing. The spec is checked in
beside the tests it mutates, under `test/mutation/`, and it is part of the evidence: it
says which sentences the package defends, and when a refactor moves the code an anchor
that no longer matches is refused rather than skipped. Its shape (`schemaVersion: 1`) is
`package`; `about`, the sentence the round defends; `tests`, the repository paths every
run executes; and `mutants`, each with an `id`, a `file`, a `find` that must occur in
that file exactly once, its `replace`, and a `why` naming the sentence it attacks. At
least one mutant is a `"control": true` no-op — a comment reworded, nothing a test can
see.

**Exit status.** `0` ROUND OK: every real mutant killed and the control survived. `1`
ROUND HAS SURVIVORS. `2` ROUND INVALID: the round could not be scored, and that includes
a harness crash, which must never read as `1`.

**What it refuses.** Each rule is a way a round once reported a score nobody had earned
— a scratch harness's (DECISIONS-LOG 2026-09-09 and 2026-10-02), or this tool's own
before an adversarial pass broke it (2026-10-03):

1. A spec with no control is refused, and a killed control makes the round INVALID: the
   control's survival is the round's certificate.
2. The baseline runs first and must be green. A red baseline makes every mutant look
   killed, the control included.
3. Each run is scored from vitest's JSON report, never from its exit code alone. No
   report, or a report holding no file — the shape the free-memory gate in
   `test/global-setup.ts` leaves when it refuses — is INVALID, never a kill, and is
   retried after a wait (`--retries`, `--retry-wait`). A run scores only over the
   tests that **passed at the baseline**: every listed file must hold at least one, so a
   file whose tests are all skipped defends nothing, and a run in which one of them
   neither passed nor failed (a worker that died leaves it pending) is INVALID. A report
   with no failure from a vitest that exited non-zero — an error outside any test, a
   dead worker; the report says `success` through both — is INVALID too, and so is a
   run that hit `--timeout`, which has its own reason and is not retried. Under a
   mutant, a kill needs a test that passed at the baseline to fail, or a listed file
   that cannot load at all; a test the mutant switched on, or a hook that threw around
   passing tests, is INVALID, not a kill.
4. Every round file — the mutated files, the test files and the spec — is hashed when
   the round starts, after every run and after every restore, and each mutant is built
   from the bytes the round started with. A file that changes while the suite runs
   voids the verdict.
5. Files are read and written as bytes, so the edit and the restore are exact.
6. The whole working tree must be clean at the start, untracked files included, and
   nothing outside the round's files may change during the baseline or any run — a
   leftover test file would otherwise "kill" the next mutant, and a snapshot the
   baseline writes would become its own oracle. Every round file must be what git
   holds where git holds it: inside the repository by its real path (no link on the
   way), one hard link, the bytes git indexed, and no `assume-unchanged` or
   `skip-worktree` flag hiding it from `git status`. `git checkout --` restores each
   mutant and `git status` checks the restore. An interrupted round leaves its mutant
   in the file, and the next round refuses to start until it is restored.
7. The files that ran must be exactly the files listed. vitest reads a file argument as
   a filter, so a run that also picks up another file is INVALID and names it.
8. Every anchor matches its file exactly once, checked before anything runs. A path
   with a part beginning `-` (vitest would read it as an option) and `find` or
   `replace` text in malformed Unicode are refused.
9. A survivor exits `1` and prints the question it owes.

**A survivor is a question, not a number.** *Is this state reachable from outside the
module, and can any listed test file read the line you changed?* If yes, a test is
missing: write it, commit, and run the round again. If no, the mutant is equivalent —
two things that cannot disagree — so remove the duplicate or record why it stays. A
survivor inside a `process.platform` branch is a third case: move the rule out of the
branch. A file kill (the mutant stopped a test file loading) is reported as one,
because it proves the file depends on the line, not that a test reads it.

**What it does not check** (decided 2026-10-03, so an author knows the limit): `--check`
exits `0` as a ROUND OK does, and only its CHECKED line tells them apart; nothing
verifies that the control really is a no-op, which is its author's to make true; a
listed test file may itself be a mutant's target; and the nested vitest inherits the
author's environment.

**Known limits** — the second refutation pass (2026-10-03) found eleven more ways to make a
round report what it had not earned; the Architect chose to record them here rather than
close them in GYM-008, and they are tracked as a follow-up. Nine were reproduced; the
last two were not, and need a repository written to deceive the round.

1. A snapshot written into an *ignored* directory becomes the oracle that "kills" the
   next mutant: `git status` does not show ignored files.
2. A same-named test can stand in for the one that passed at the baseline, because a
   test is keyed by its file, full name and place among same-named tests, not its
   location.
3. One file reported twice — vitest `projects` — shares one key per test.
4. A test that commits moves `HEAD` while the tree stays clean; refs and the index are
   not watched.
5. A submodule marked `ignore = dirty` hides what a test writes inside it.
6. A clean filter hides a working-copy edit from both `git status` and the index-blob
   check, and the restore then destroys it.
7. `text=auto` under `core.autocrlf=true` does the same to line endings. In this
   repository (`* text=auto eol=lf`) a working file saved with CRLF is this case: run
   rounds on LF files.
8. A per-repository `core.fsmonitor` hook can blind `git status`.
9. A vitest `retry` setting turns a kill into a pass; the report keeps no retry count.
10. State kept outside the repository, or a detached process that writes after the
    round has looked (not reproduced).
11. A vitest configuration that rewrites the report the round reads (not reproduced).

**The trust boundary.** A round runs the repository's own tests and configuration as
code, so it trusts them. A test or configuration written to deceive it can forge any
verdict (10 and 11 are the shape); a round's verdict means that the repository's tests,
written honestly, catch the change (THREAT-MODEL §6.9).

**Where to run it.** Not in a folder a sync client watches: OneDrive has twice put a
restored file back with a mutant in it. The hashes catch that and call the round
INVALID; they cannot prevent it, and a write that lands after the round has ended is
outside what any round can see. Run from a detached worktree outside the synced folder
(`git worktree add --detach <a directory under %TEMP%> <commit>`, with `node_modules`
linked), and never while a measurement such as a coverage ratchet is running, because a
round rewrites source files.

**What the record carries.** The spec path, the commit, the command, the ROUND line,
the test files run, and the platform and Node version — a score without its condition
is not evidence (§2).
