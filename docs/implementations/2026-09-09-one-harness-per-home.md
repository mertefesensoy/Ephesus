# One harness per home

**Date:** 2026-09-09 · **Milestone:** M8 follow-up — the must-ask M8.14 left open ·
**Branch:** `fix/one-harness-per-home` from `origin/main` `ba0023e`

---

## 1. Problem / motivation

A harness home holds **one book of record and one single committer** (invariant §4/§5,
ADR-0004). Nothing checked that only one harness was using it.

Not hypothetical. `docs/EXIT-M8.md` §4 already warns a reader that killing the
`npm run dev` wrapper leaves Electron alive, and that a second boot against one home means
*"two harness instances, one book of record and two single-committers"* — and it names the
evidence: the **duplicate `seq` in the Architect's own `log.jsonl`**, 2026-09-07. The
hazard was documented and unguarded.

M8.14 then found half of it by accident. Its CI run — on linux, against a test written on
Windows — showed the control endpoint's stale-socket cleanup running unconditionally:

```ts
if (process.platform !== 'win32' && fs.existsSync(endpoint)) fs.rmSync(endpoint, { force: true })
```

On POSIX a second instance **deleted the first one's live socket** and bound over it.
`src/main/hooks.ts` — the event plane every agent posts to — carried the identical line.
That was raised as a must-ask at the M8.14 session report rather than fixed there.

**The Architect's answer went further than the report proposed:** guard *and* lock. It is
the right call on the evidence. A refused endpoint only stops that plane being stolen; the
second instance would still boot, still hire, and still commit through a second single
committer — which is the failure that actually happened.

## 2. What changed

| File | What |
|---|---|
| `src/main/home-lock.ts` | **New.** `isListening` (moved here — three callers now share it) and `occupiedBy`, which answers whether another harness is working on this home |
| `src/main/hooks.ts` | Probes before it clears: refuses an address something is serving, on both platforms |
| `src/main/control.ts` | Imports the probe rather than owning a private copy |
| `src/main/consent.ts` | `blockedBy()`, consulted in `startWork` — the funnel `boot()` and `grant()` share; `startWork` now reports back so `grant()` cannot claim a company started |
| `src/main/index.ts` | Asks once, before either endpoint binds; skips both starts when occupied; passes `blockedBy` |
| `src/shared/diagnosis.ts` | A busy home reads `WAITING FOR YOU` on *the book of record*, not `BROKEN` |
| `scripts/coverage-floors.json` | `home-lock.ts` joins the `agora` row |
| `docs/adr/ADR-0034-…md` · `docs/adr/README.md` | The decision, indexed |
| `docs/sdd/SDD.md` · `docs/THREAT-MODEL.md` | Module map, tier diagram, controls table |
| `docs/PROGRESS.md` · `docs/DECISIONS-LOG.md` | The record |
| `test/main/home-lock.test.ts` | **New.** Real servers on real addresses |
| `test/main/hooks.test.ts` · `test/main/consent-gate.test.ts` · `test/shared/diagnosis.test.ts` | The guard, the block on both paths, the verdict |
| *Second pass (§7):* `src/main/degradations.ts` · `src/main/diagnosis.ts` | `mayAppend()` and `mayWrite()` — one seam each, so a blocked instance writes nothing into a home it does not own |
| *Second pass:* `src/shared/diagnosis.ts` | The report names the process that wrote it; the unreachable `waitingWhen` deleted |
| *Second pass:* `docs/adr/README.md` | A clause note against ADR-0034, which is accepted and never edited |

## 3. Implementation approach

### Three rules, and only the third is new in kind

**1. Both endpoints refuse an address something is already serving.** The M8.14 shape
verbatim: probe, refuse with a sentence, and only then clear a leftover — on the platform
that has one.

**2. The company does not start on a home somebody else is working on.** `CompanyStart`
gains `blockedBy()`, consulted in **`startWork`**, the single funnel both `boot()` and
`grant()` already pass through. On a busy home the second instance boots, opens its window,
hires nobody, arms nothing, and reports `agora/home-occupied` naming the owning process.
That is the consent gate's shape (ADR-0032) because it is the consent gate's situation: a
company deliberately not working, which must not look like one that has finished.

Three details that are not incidental:

- **The refusal does not latch.** `started` is left false, because the condition clears
  when the other harness stops — a latched flag would mean the company never came up.
- **Consent given anyway is still recorded.** The Architect's answer is their answer; what
  is refused is *starting*. `ConsentGrantOutcome.ok` now reports which happened, so
  `ephctl consent:grant` cannot print *"the company is starting"* while nothing does.
- **It is not folded into `ConsentVerdict`.** Consent is a standing answer; occupancy is a
  condition of this machine right now. Collapsing them would make a busy home read as
  *"nobody has said go"*.

**3. Liveness is probed, never locked.** No lockfile. A pidfile would owe a schema and a
validator (invariant §9), a stale-lock policy, and a release on every exit route —
including the ones that do not run, which is how stale locks are born. The check probes
what a live harness is already serving: both endpoints, plus the `control-endpoint.json`
ADR-0033 already writes, whose `pid` names the owner.

**The address file is a courtesy, never the authority.** A stale one left by a killed
harness does not make a home occupied — only an endpoint that answers does. Refusing to
start over a leftover *file* would turn every crash into an outage.

### Why the cause is `agora/*`

What two instances endanger is one book of record and one single committer. And
mechanically: the `DIAGNOSIS.md` probe table has an `agora` area and **no `home` area**, so
a `home/*` cause would have appeared in the conditions list and turned no row. It reads
`WAITING FOR YOU` rather than `BROKEN` — nothing has gone wrong; the harness refused to let
it.

## 4. Mathematical / statistical details

None. The only quantity is `SOCKET_PROBE_MS = 250` — the budget after which an address that
has not answered is called abandoned. It bounds boot by at most 250 ms per endpoint in the
one case where an address exists and nothing is behind it; a refused connection returns in
about a millisecond, which is every ordinary boot.

## 5. Design decisions

The alternatives — a pidfile lock, fixing `hooks.ts` alone, quitting instead of refusing to
work, and carrying on visibly degraded — are in
[ADR-0034](../adr/ADR-0034-one-harness-per-home.md) with why each was rejected.

One decision belongs here because it is about testing rather than design: **the probe runs
on both platforms deliberately.** The first version of this guard (in M8.14) sat inside the
`process.platform !== 'win32'` branch, and two mutations of it survived the local mutation
pass — not because they were equivalent, but because nothing on win32 could execute the
code they changed. *A guard only one platform runs is a guard only one platform's tests can
check.* Windows would refuse a duplicate pipe name on its own, but with `EADDRINUSE`
instead of a sentence, so the guard earns its place there too.

## 6. Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
```

```bash
npm run test:coverage && node scripts/check-coverage.cjs && node scripts/check-readme-current.cjs
```

**230 test files / 4388 passed / 8 skipped / 0 failed.** Reachability 184/194 → **185/195**.
Coverage floors green with none lowered and no ratchet needed; `boot` rose (27.85 → 28.21),
because the occupancy check is one statement there and the logic is in a tested module.

**15 mutants, 14 killed, the fifteenth a planted no-op** that survived as designed. Both
directions of every guard: the hook endpoint stolen and a dead socket blocking the next
boot; occupancy never noticed and every home busy; only one endpoint probed; a stale
address file alone making a home occupied; an unreadable one taking the boot down; the
company starting anyway; a silent block; a block with no log row; a refusal that latches;
`grant()` claiming a company started; and the verdict reading `BROKEN` or blanketing every
`agora` fault as merely waiting.

### Live proof — two harnesses, one home

1. **A** boots on a fresh `%USERPROFILE%\ephlock`, is granted consent through `ephctl`, and
   hires Artemis. `control-endpoint.json` names pid 30580.
2. **B** is started against the same home and refuses:

   ```text
   agora: another Ephesus harness is already working on this home (process 30580) —
   it is answering on \\.\pipe\ephesus-events-62e834490d25d23e. Two instances on one
   home share a book of record and a single committer, so this one will hire nobody
   and arm no schedule. Stop the other one and restart.
   ```

3. The shared book of record carries `orchestrator/not-started` at seq 18, `from: 'boot'`,
   with that reason.
4. **Exactly one `agent.artemis` spawn** exists across both instances.
5. `ephctl agents:list` still reaches **A**, and `control-endpoint.json` still names A's
   pid: B took neither plane.

## 7. Second pass, same day — a blocked instance writes nothing

The observation this shipped with was narrow: **both instances write `DIAGNOSIS.md`**, and
they disagree honestly — A reads `the book of record | WORKING`, B carries
`agora/home-occupied` and would read `WAITING FOR YOU`, and whichever wrote last is what a
reader sees. It was recorded rather than taken, because who that file is for is a judgement.

The Architect's answer was **a blocked instance should not write it** — and looking for the
fix found the larger half of the same problem.

### What the narrow observation was hiding

`degradations.report()` appends every condition to `log.jsonl` (`index.ts`'s `append`
closure). So a blocked instance was writing into the **owner's book of record for its whole
life** — not one `orchestrator/not-started` row, but every degradation it ever raised. The
live proof above had reproduced exactly that, at seq 18, and it was read as evidence the
lock worked.

The rule is the simple one: **an instance that does not own the home writes nothing into
it.** Enforced at the two seams that already existed —

- `DegradationLog`'s single private `append`, so every condition is covered rather than
  the one that happened to be noticed;
- `DiagnosisWriter.write()`, which covers all three call sites: boot, the minute timer, and
  the quit path.

The ring and the window keep every condition. Invariant §7 still owes the blocked
instance's own user the truth; what it does not owe is a row in somebody else's book.

`DIAGNOSIS.md` now also names the process that wrote it — the same reasoning as M8.13's age
line, which is first in the file because a stale report read as current is a degradation
failing as good news. A report that cannot say *who* wrote it can be misread the same way,
and this entire rule was found by two reports disagreeing.

### Two things deleted, which is the honest half

**The `waitingWhen` for `agora/home-occupied`, and its two tests.** With a blocked instance
writing nothing, that condition can never reach a rendered row — the owner never has it,
and the instance that has it never writes. A predicate that cannot fire is the check that
cannot fail, in the report built to refuse exactly that. Recorded as a clause note against
ADR-0034 in `docs/adr/README.md`, since an accepted ADR is never edited.

**The class-level "does not latch" test.** `index.ts` computes `occupancy` once and
`blockedBy` closes over it, so nothing can flip it inside a process: the test was green
against a path production cannot reach — written the same day, by me. Occupancy is a
boot-time decision by Architect decision, and the refusal already says to stop the other
harness and restart; a company that quietly starts itself minutes later is a surprise
nobody asked for. A comment stands where the test was, saying why `started` is left false:
a block is not a start, not an offer of recovery.

### Proved live again, on the same scenario

A fresh home, A brought up as a working company through `ephctl`, then B started against
the same home. Before B: 13 log rows, `DIAGNOSIS.md` written by process 34216. After B
refused:

| | before the fix | after |
|---|---|---|
| `orchestrator/not-started` rows in the owner's log | 1 (at seq 18) | **0** |
| `agora/home-occupied` rows in the owner's log | 1 | **0** |
| `hooks/*` or `control/*` rows from the blocked instance | present | **0** |
| `DIAGNOSIS.md` header | no writer named | `written by process 34216` — **A's**, never overwritten |

The three rows that did appear while B was up are A's own — a `budget` pace row, its
`budgets/state:agent.artemis` condition, and a second `budget` row. B contributed nothing
to a home it does not own, and its own console and window still carry the refusal in
full.

## 8. Related docs

- [ADR-0034 — One harness per home](../adr/ADR-0034-one-harness-per-home.md)
- [ADR-0033 — A script may run the company](../adr/ADR-0033-a-script-may-run-the-company.md)
- [ADR-0032 — The company asks before it starts](../adr/ADR-0032-the-company-asks-before-it-starts.md)
- [ADR-0004 — The Agora: single committer](../adr/ADR-0004-agora-single-committer.md)
- [M8.14 — the control surface, whose CI run found half of this](./2026-09-08-m8-14-control-surface.md)
- [EXIT-M8 §4](../EXIT-M8.md) — the restart step, and the warning this now enforces
