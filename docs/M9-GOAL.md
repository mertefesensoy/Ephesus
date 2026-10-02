# M9 goal prompt — the harness is the product

**Do not paste this into `/goal` until the Architect has said the build may start.**
On 2026-10-02 the Architect approved the *planning and documentation* of M9 and said,
in those words, "not build it yet". This file exists so the handover is ready when
that changes, and so the session that starts M9 does not have to rediscover what
was decided. `docs/M8b-GOAL.md` was written and never committed, and the session
that needed it could not find it; this one is committed with the plan.

The seven decisions below are settled and are **not** to be re-asked. What is still
the Architect's is the single question of *when*.

---

Build milestone **M9** of Ephesus — *"The harness is the product"*. All eight
packages, M9.0 through M9.8. They are defined with acceptance criteria in
`docs/M9-PLAN.md` §6 and digested in `docs/IMPLEMENTATION.md` M9; do not restate
them, work from them.

**FIRST, follow `BUILD-PROMPT.md` §2's reading protocol in full**, then read, in
this order:

1. `docs/M9-PLAN.md` — the whole file. §1 is why, §2 is the direction as six claims
   the milestone is held to, §3 is what the inspirations do (pre-Stoa, unpinned —
   M9.0 replaces it), §4 is the thesis you are building an instrument for.
2. `docs/adr/ADR-0036-two-engine-kinds.md` — what is superseded (one sentence of
   ADR-0009) and what is not (everything else).
3. `docs/sdd/SDD.md` §13 and `docs/srs/SRS.md` FR-15/FR-16/§6.11 — the design shape
   and the requirements, written at plan time. Where a package lands differently,
   amend them in that package's PR and record the difference.
4. `docs/adr/ADR-0035-an-engine-prompt-is-declared-in-advance.md` and ADR-0031 —
   the residuals the native engine exists to remove, and the method (establish
   engine behaviour by execution, never by guessing) you inherit.

## Why this milestone exists, in one paragraph

Ephesus owns everything around the agent loop and nothing in it. Every residual the
record keeps rediscovering — the permission prompt nobody may answer, the hooks only
the harness may author, the binary the company may not upgrade, the autonomy two
adapters cannot carry, the `tool-permission` gate the Watch refuses because it has
no action to permit — is a limit of wrapping a CLI the harness does not own. And the
harness has no metric of itself: the one criterion no suite covers has been
attempted four times and completed zero. M9 builds Ephesus's own engine behind the
existing adapter seam, running local models first, and builds the bench *before* the
engine so the exit is a measured uplift under ablation rather than a feature list.

## The order to build them in, and why

**M9.0 first, and it is mostly reading and writing.** ADR-0037 and ADR-0038 are
owed; the two `/research` cycles against `src-odysseus` and `src-hermes-agent` must
run at **pinned** commits and produce RB-002 and RB-003 before any engine code
exists, so the design is grounded in the Stoa's governed evidence and not in the
plan's §3. Replace §3 with citations when they exist.

**M9.1 second, against the engine that does not change.** The baseline row is
measured on the wrapped `claude` adapter so nobody could have tuned it. Build the
scorer's discrimination suite (S-BENCH) before the live run — a scorer only ever
tested against a good run passes everything.

**Then M9.2 → M9.3 → M9.4 in series.** M9.2 is the largest package since M3; split
it if its plan exceeds ten files (BUILD-PROMPT §4), but keep the conformance table
as the gate — `native` passes every row or the package is not done. M9.3 is
gate-shaped: budget the adversarial refutation pass (ephesus-engineer §3 rule 6).

**M9.5 may run in parallel with M9.4.** Then **M9.6**, which needs everything
before it. **M9.7 last**, because the headless boot is proven by running T1.

## ASK THE ARCHITECT — in series, not in a batch

Through AskUserQuestion, never in prose:

- **Before M9.0:** may the build start? (The only open question.)
- **Before M9.2:** the exact `tsconfig.engine.json` shape and where its output is
  wired into `electron-vite`'s build — DD-M9-5 decided the kind of change, not the
  lines; a toolchain change is always shown first.
- **Before M9.5:** that a provider key may be declared by a shipped hire template
  (it is a broker secret; the consent screen must name the spend).
- **Before any live bench run on a real model:** which local model, on which
  machine, with which endpoint — the condition is part of the row.
- **At M9.6:** whether a negative or null uplift on any cell changes the plan. The
  exit does not require a positive number; the Architect may still want to act on
  one.

Recorded decisions you must NOT re-ask (DECISIONS-LOG 2026-10-02): M9 before M7b;
own loop as own CLI in TS; OpenAI-compatible local endpoint first; headless-first,
nothing deleted; a third TS build target; the two watchlist rows; bench T1 subsumes
the unattended hour.

## The verification bar

Every package: typecheck, lint, `check-invariants`, the suite under coverage,
`check-coverage` — all green before a commit, output in the record. Every package
owes a mutation round from a checked-in `test/mutation/<package>.json` **with a
control** (GYM-008). Every conformance claim is checked in both directions. Every
number carries its condition. Tier D is never "done".

## What NOT to do

- Do not start on silence. "Plan it, don't build it yet" is the standing instruction.
- Do not special-case `native` anywhere in core. The conformance suite has four
  subjects; a table that passes by excepting one has misread ADR-0036.
- Do not add a runtime dependency. Every network call is platform `fetch`; the first
  package that needs a package stops and asks (invariant §10).
- Do not build prompted-tool recovery for weak models in M9. It is a recorded
  follow-up, and a parser that guesses a tool call is a second place a decision is
  made.
- Do not delete the floor, the Herald or the Odeon. DD-M9-4 was "nothing deleted".
- Do not tick the M7, M8b or M8c exit boxes. T1's first live row is the Architect's
  evidence to tick on.
- Do not put any agent, session or model name in a commit, a doc or a comment, and
  never commit under any identity but the Architect's.

## Where the evidence lives

`docs/bench/LEDGER.md` (every row, with its condition) · `docs/PROGRESS.md` M9
(ticked in the same session as the work, with the evidence note) ·
`docs/implementations/<date>-m9-<n>-<slug>.md` per package · `docs/DECISIONS-LOG.md`
for every answer the Architect gives.
