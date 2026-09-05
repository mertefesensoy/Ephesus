# M8 goal prompt — the company you can leave running

Paste the block below as the argument to `/goal`. It is written to be pasted
whole; every clause in it exists because something in this repository went wrong
without it.

Keep this file updated as M8 progresses — it is the handover, and a stale
handover is worse than none.

---

## The prompt

> Build milestone **M8 of Ephesus — "The company you can leave running"**.
> Resume at **M8.7 (engine isolation, and whose autonomy hinge it is)**.
> M8.0–M8.6 are ticked. The seam rule is mechanical (`scripts/reachability.cjs`
> inside `check-invariants`, `scripts/check-coverage.cjs` over
> `scripts/coverage-floors.json`), GYM-006 is on the ledger, and the DoD command
> below is the new one. As of M8.6 every profile hire runs in its own git
> worktree by default, a rung-3 breaker stop outlives the process it stopped,
> and a crew agent either offers to come back or comes back by itself — so the
> three sentences below about a company that cannot survive are now the reason
> this milestone exists rather than a description of the tree.
>
> **FIRST, follow `BUILD-PROMPT.md` §2's reading protocol in full, every
> session.** Do not skip it and do not substitute `docs/PROGRESS.md` for it.
> PROGRESS tells you WHICH package is next and what it owes; §2 is the router
> that sends you to the normative sources for that package — the SRS for *what*,
> the SDD for *how*, and the ADR that governs it, with the precedence rule
> (**SDD > ADR > SRS > README** for how; **SRS > SDD** for what). ADRs are
> append-only: never edit an accepted one, supersede it.
>
> Then read the **M8 plan in `docs/PROGRESS.md`** — packages M8.0–M8.12 are
> already derived with their Docs/Tests/Risk lines — and the **build-state block
> in BUILD-PROMPT.md**. Do not re-litigate decisions recorded in either.
>
> ### What M8 is, in one sentence
>
> M8 is not a feature milestone. Every item is setup, wiring or disclosure, and
> the whole milestone exists because **the suite is green while the product is
> not**: Closing Time has never once run in the shipped app, the standup reads
> the oldest 500 log entries, the dock shows an overnight run's first 300
> events, and every one of those passes its tests today.
>
> ### The standing instruction that outranks convenience
>
> **The goal is not the smallest fix. It is the most reliable and testable one.**
> Where the MVP register offered a cheap fix and a correct one, take the correct
> one. Everything must come out reliable, maintainable and testable, and test
> coverage is first-class work in this milestone rather than a follow-up — the
> point is to stop meeting bugs on the fly.
>
> If a package can be closed quickly by making the symptom go away, that is the
> wrong close. Fix the cause, and leave a test that fails if the cause returns.
>
> ### The rule this milestone enforces, and why it exists
>
> **A wiring seam with no test is a defect, not a gap.**
>
> The recurring defect of this codebase is *a check that cannot fail*. Five
> distinct instances were found in a single day (2026-09-01/02):
>
> 1. A scenario rig that copies production's handler **minus the line that
>    throws** — which is why the closing-time suite is green against a protocol
>    that has never run.
> 2. A contention probe whose child processes had **all exited before it
>    measured**, reporting a clean result that meant nothing.
> 3. A mutation check that only dies in a non-UTC timezone, so it would survive
>    on CI.
> 4. A timeout margin computed from a **file total against a per-test ceiling**,
>    then from a single sample of the right metric — six measurements, four
>    wrong, none caught by their own author.
> 5. A test asserting a refusal that **its CI platform never makes**, so it
>    could only fail, never pass, where it ran.
>
> Every one was a correct measurement of the wrong thing. So:
>
> - **Mutation-check every regression you write.** Break the thing, confirm the
>   test goes red, revert. Confirm the baseline is GREEN before you start — a
>   mutation run against a red baseline reports every mutation as killed and
>   proves nothing.
> - **Test the SEAM, not the two halves.** Object spread bypasses excess-property
>   checking; that is how a dead field survived two milestones with passing tests
>   on both sides of it.
> - **Record the CONDITION beside any figure, and record it once.** A number
>   copied into a second document is how six measurements came to disagree.
> - **If a probe can silently no-op, it must report that it did.** Three-valued:
>   yes / no / could-not-establish — and *could-not-establish must FAIL*, not
>   skip. `test/pin.ts` is the worked example in this repository.
> - **State each package's production call path — file and line — in its
>   evidence, or record that there is none.** M6 shipped 1,406 lines nothing
>   could reach.
>
> ### Decisions already made — implement them, do not reopen them
>
> - **The crew may open pull requests unattended** (Architect, 2026-09-02;
>   implemented in `610eb0a`). Force-push, branch deletion, pushing to a branch
>   someone else builds on, production changes and dependency additions stay
>   gated.
> - **The MVP ships Claude only** — [ADR-0024](adr/ADR-0024-claude-only-for-the-mvp.md).
>   **Refuse** a non-reference engine at profile load with the engine named; do
>   not degrade it. This is **not** licence to collapse the adapter seam:
>   `codex.ts` and `gemini.ts` stay in the tree, unregistered, as the conformance
>   suite's second implementation. If a change makes conformance pass by
>   special-casing Claude, the ADR has been misread. The conformance table gains
>   an **autonomy case** — its absence is exactly why the silent drop survived
>   two milestones.
>
> ### Decisions that are the Architect's — ask, do not assume
>
> Use the asking-me-questions workflow and do no guesswork. Make style and idiom
> calls yourself; bring up anything genuinely architectural or scope-changing.
> **If a decision would change a DOCUMENT rather than code — a spec clause, an
> ADR consequence, an exit criterion — that is always the Architect's, even when
> it looks small.**
>
> Open right now, and **M8.4 is blocked on the first one**:
>
> 1. **What the shipped gate policy grants** (DD-1). Deny-all is defensible and
>    makes the product unusable on first run; permissive makes "the Watch held
>    every gated action" untrue by default.
> 2. ~~M8.0's coverage provider~~ **DECIDED 2026-09-02:** `@vitest/coverage-v8`
>    at exact `4.1.11`, dev-only. The premise this bullet used to carry — "it
>    ships with vitest and adds no package" — was FALSE: `vitest run --coverage`
>    fails without the package. Recorded in DECISIONS-LOG and BUILD-PROMPT §10.
> 3. The shipped hire budgets, which measured a breach inside one working day for
>    every hire; whether a company-wide daily ceiling exists at all; whether the
>    block cap and pathology signal are dead code or a wrong early return (both
>    are currently unreachable by construction); consent on first launch, since
>    boot starts an agent unconditionally and the first tick fires standup,
>    reflection and retro together sixty seconds later; and whether a settings
>    surface is in scope — its absence is *why* four packages are "hand-write a
>    file you were never told about".
>
> ### Things you must not get wrong, because they have cost milestones before
>
> - **M7 is NOT closed.** Its exit is SRS §6.1 on a real repo and §6.1's action
>   half has not been run. M8 does not close it; the two are independent and
>   §6.1's action half is owed to both. **Do not tick that row.**
> - **M6.9 — wiring the Herald into the application — is DEFERRED INDEFINITELY
>   by Architect decision.** Do NOT wire it, and do not "fix" the Herald's
>   unreachability in passing because it looks like a bug. It is a recorded,
>   deliberate gap.
> - **SRS §6.2, §6.5 and the voice-driven day were NOT demonstrated and are NOT
>   waived.** They are unchanged v1 acceptance criteria attached to M6.9. Never
>   restate M6 as though voice was proven.
> - **M7b work must not be pulled forward.** M8 runs before it, on purpose.
> - **`~/.ephesus/profiles/` is the Architect's copy and SHADOWS the built-in
>   permanently.** A repo-only edit to a profile changes nothing for a live run.
>   Check both, and never overwrite the home copy wholesale — it carries real
>   configuration (`harbor.json`'s target repo is theirs, not staleness).
> - **Every commit is authored solely by the Architect.** No `Co-Authored-By`,
>   no session or model name in a commit message, a file, or a PR body — this
>   was violated once and the history had to be rewritten. `node
>   scripts/check-attribution.cjs` scans trailers and authorship, NOT prose, so
>   the script passing is not proof; grep the diff.
> - **Do not open a PR unless the Architect asks.** Merging to `main` is theirs
>   per package unless they say otherwise.
>
> ### Repo facts worth having before you touch anything
>
> - `StationView` is a discriminated union with a branded `StationReason`;
>   weakening it to `string` fails typecheck.
> - `check-invariants` bans clocks under `src/renderer/src/floor/` outside
>   `FloorCanvas.tsx`.
> - `jsdom` is pinned to `^26` because 30 cannot start a vitest worker on this
>   toolchain's Node 20.
> - `testTimeout`/`hookTimeout` are 30 s **per unit**; nothing governs a file's
>   total. The s-stoploop distribution and its condition live in
>   `vitest.config.mts` beside the timeout — read it there and **do not copy the
>   figure into another document**.
> - On Windows a process's cwd is an open handle on that directory, so a live
>   child pins it against deletion. `fs.rmSync`'s own `maxRetries`/`retryDelay`
>   do not help — measured, it gives up in 0–3 ms whatever it is told.
> - `writeFileAtomic` retries a transient rename for 500 ms then throws, and the
>   dominant cause of that transient is **this harness contending with itself**
>   (`Agora.commitSoon`'s fire-and-forget `git add -A` holding the files the
>   Hermes sweep renames). A retry is the wrong shape for self-inflicted
>   contention; ordering is. Recorded, not fixed.
>
> ### Definition of done for every M8 package
>
> `npm run typecheck && npm run lint && node scripts/check-invariants.cjs &&
> npm run test:coverage && node scripts/check-coverage.cjs` green before every
> commit — this is BUILD-PROMPT §4's TEST line as updated at M8.0 (the suite
> runs once, under coverage, and the seam rule's two gates run with it); §4 is
> canonical, this is the copy a pasted prompt needs. Never proceed on red;
> never weaken a test to pass it.
> A coverage figure is written in exactly ONE place, `scripts/coverage-floors.json`,
> with its platform and condition — never copied into prose. When a package
> raises coverage, `node scripts/check-coverage.cjs --update` ratchets the floor
> on the platform you are on; linux floors come from the CI artifact
> (`--seed --from <artifact> --platform linux` the first time, `--update --from`
> after; take it from a PUSH run). A NEW untested module or an unreachable one
> is a hand edit citing a decision, never an `--update` — and `--update`
> refuses to start a platform block, so a deleted block cannot be re-seeded by
> accident. "Untested" means no function entered, not "no line run". The package's owed tests are part of the package, not a follow-up.
> Tick the package in `docs/PROGRESS.md` with a one-line evidence note in the
> same commit series, log minor choices in `docs/DECISIONS-LOG.md`, and write the
> implementation doc at `docs/implementations/YYYY-MM-DD-<slug>.md`.
>
> End with the BUILD-PROMPT §9 session report, and re-run
> `node scripts/check-attribution.cjs` — the run is not clean until it says so.
