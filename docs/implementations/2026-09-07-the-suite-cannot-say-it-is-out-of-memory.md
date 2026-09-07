# The suite refuses a machine it cannot run on, and tidies up after itself

**Date:** 2026-09-07
**Requirement:** ENGINEERING-STANDARDS §6 (testing rules) · invariant §7 (every degradation is
visible, never a silent fallback)
**Branch:** `fix/test-harness-does-not-exhaust-the-machine`, cut from `main` at `6162e06`

---

## 1. Problem / motivation

This began as an audit, not a change. After a session of heavy test runs the Architect reported
that the laptop's drive had crashed, and asked what this session's work had done to cause it.

**It had not, and no drive crashed.** That is worth stating first because everything below is
smaller than the question that prompted it. Read from the machine:

| Check | Result |
|---|---|
| `Get-PhysicalDisk` | NVMe WD PC SN560 1 TB — `HealthStatus: Healthy`, `OperationalStatus: OK` |
| `Get-Volume C:` | `HealthStatus: Healthy`, NTFS |
| System log, disk/Ntfs/storahci/stornvme/volmgr errors, 3 days | **none** |
| Event 41 (dirty shutdown) / 1001 (bugcheck) | **none** |
| 05:47 shutdown | `Kernel-Power 109/577` — *system initiated reboot*, EventLog 6006 → 6005 = a **clean** restart |
| NTFS on the way back up | Event 98: every volume *"healthy, no action needed"* |

The reboot was Windows-initiated (Defender and Store updates had been installing through the
night) and landed **2 h 40 m after** the last heavy run. Nothing this session did left the
machine: no branch reached `origin`, no PR was opened, and **zero files** in the live
`~/.ephesus` were modified — the one test that read it only read it, and was deleted.

What the audit *did* find were two real defects in the test harness. Neither threatened the
drive. Both make the machine worse the more the suite is run, and both had been invisible for
two weeks.

### 1.1 The suite could not say it was out of memory

With free memory at 0.11 GB of 16.8, vitest's forks began dying mid-run. From outside, that does
not look like memory. It looks like **15, then 39, then 43 unrelated tests failing** — a
different set each time — with `Worker exited unexpectedly` buried in an unhandled-error block,
no mention of memory anywhere, and no coverage report at the end. An hour went into reading it
as a regression that did not exist.

`check-coverage.cjs` then said *"no report — run `npm run test:coverage` first"*, which is
exactly wrong in the one case that matters: you just did, and its workers died.

This is the same defect the preceding milestone had just fixed in the product — **a refusal that
cannot teach the rule it is enforcing gets re-earned every time** — reappearing in the harness.
A red suite that is not evidence is worth no more than a green one that is not.

### 1.2 The suite had been filling `%TEMP%` since 2026-08-26

**3 279 `eph-*` directories — 42 910 files across 24 405 directories** — on a drive that is 92%
full (75 GB free of 926). Only 0.04 GB, so this is metadata growth rather than a space threat,
but it was unbounded and nothing would ever have mentioned it. Measured: one full run left 11
behind.

## 2. What changed

| File | What |
|---|---|
| `test/global-setup.ts` | **new** — refuses to start below a measured memory floor; sweeps stale `eph-*` directories |
| `vitest.config.mts` | Registers it as `globalSetup` |
| `test/temp-hygiene.test.ts` | **new** — the guard, plus tests for the sweep and the refusal |
| `test/main/incident-verification-wiring.test.ts` | Removes the temp homes it makes |
| `scripts/check-coverage.cjs` | The missing-report message says what actually happened |

## 3. Implementation approach

### 3.1 Refuse, and name the number

`requireHeadroom` throws before any test runs, with a sentence that says the free memory, what
the suite needs, **and what the failure looks like** — that last part is the one that cost the
hour, because "out of memory" alone would not stop the next person reading a scattered red run
as a regression.

It deliberately does not quietly reduce the worker count instead. Degrading here would trade a
loud, correct refusal for a slow run whose result nobody could interpret, which is the direction
ADR-0024 rejects for engines and the same reasoning holds.

### 3.2 Sweeping what per-file teardown cannot reach

Two categories are legitimately beyond a test's own `afterEach`: the directories
`tmpdir.test.ts` **deliberately pins** (it asserts `removeTempDir` gives up on a held directory,
so the directory is by construction still there when the test ends), and residue `removeTempDir`
honestly reported as a leak rather than hiding. So the sweep runs in `globalSetup`, before the
run rather than after it, and is **age-gated at two hours** against a 30 s per-test timeout — a
concurrent worktree's live directories are minutes old and are never touched, which matters
because this repository is regularly worked on from three worktrees at once. It announces how
many it removed, because silent housekeeping that deletes things is what nobody can audit later.

The first sweep reclaimed all 3 279.

### 3.3 The guard, and the mutation that proved it wrong

`test/main/incident-verification-wiring.test.ts` called `mkdtempSync` per test and removed
nothing — **1 391 of the 3 279**, the single largest source. That is one missing line, which no
review catches and no test could catch, so the fix is a guard rather than an edit.

**The guard's own first version was wrong, and only a mutation found it.** Written as
`source.includes('removeTempDir')`, it *survived* being fed the real defect: deleting the
teardown's body leaves the `import { removeTempDir }` line behind, so the file still "mentioned"
the helper while removing nothing. It checks for a **call** now, and that mutant is kept as its
regression. A shape check standing in for a semantic one is this repository's oldest recurring
defect, and it had just reproduced inside the test written to prevent it.

## 4. Numeric details

The floor is **measured, not guessed**. Sampling `Get-Process node` every 8 s through a full
`npm run test:coverage`:

```text
t   procs  totalMB  maxMB  freeGB
0      28     1986    137    1.65
1      31     1948    138    1.81
...
PEAK   31     1986    162    min free 1.43
```

Peak **31 worker processes holding 1 986 MB in total**, largest single process 162 MB. So the
suite's appetite is about 2 GB.

`MIN_FREE_BYTES = 1 GB`. The observed death zone was 0.11–0.37 GB free; the observed healthy
start was 1.4 GB and up. 1 GB sits below every run that has worked and above every run that has
died, and is deliberately not tuned finer than the evidence supports.

**What this measurement refuted.** The first draft of this change capped the worker count,
because the obvious story was that the suite exhausted the machine. It does not: it needs 2 GB,
not 14. Something else held ~13 GB and the suite then could not get its 2. A cap would have
fixed the wrong thing and slowed every run for no memory benefit — so it was deleted before it
was written.

## 5. Design decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| Refuse below a floor | Cap worker count | The measurement shows the suite uses 2 GB; the cap addresses nothing and costs every run |
| Sweep in `globalSetup` | `globalTeardown` | Before the run cannot race the run's own fresh directories |
| Age-gate at 2 h | Sweep everything | Three worktrees run concurrently; a sweep must never be why somebody else's suite failed |
| Guard on a **call** | Guard on the name | The name version survived the real defect — an import satisfies it |
| Guard accepts `removeTempDir(` **or** `rmSync(` | Require the helper | Five files legitimately use `rmSync` with their own retry budget; forcing a migration is beyond this fix |

## 6. Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs \
  && npm run test:coverage && node scripts/check-coverage.cjs \
  && node scripts/check-readme-current.cjs && node scripts/check-attribution.cjs
```

Observed: **207 test files, 3969 passed, 0 failed, 8 skipped**; typecheck, lint, invariants,
README currency, attribution and the coverage gate all green.

**9 mutations over the new guards, 9 killed** — 8 on the first pass, and the ninth only after
the guard itself was fixed (§3.3). The sweep's age gate, its prefix check, its never-throws
contract, the headroom floor's inclusivity, and both halves of the refusal's wording are each
killed by a named mutant.

Directly observed: `[suite] swept 3279 stale eph-* temp directories` on the first run, and
`eph-*` count unchanged (16 → 16) across two runs of the file that used to leak six per run.

## 7. Still open — the Architect's call, outside this fix

- **The drive is 92% full** (75 GB free of 926). `Volsnap 33` at 03:05 recorded Windows deleting
  the oldest shadow copy to stay under its space limit, which is a pressure signal even though
  nothing failed.
- **The repository lives inside OneDrive.** `C:\Users\senso\OneDrive\Masaüstü\ephesus` holds
  **95 676 files / 1.85 GB** in OneDrive's sync scope, of which `node_modules` (39 379 files) and
  `.claude/worktrees` (40 714) are pure build churn that is re-hashed and re-uploaded as it
  changes. Moving the working checkout outside OneDrive would remove that entirely; it is a
  bigger change than this package and it is not mine to make.

## 8. Related docs

- `docs/DECISIONS-LOG.md`, 2026-09-07 — the refuted hypothesis, and the guard that survived
- `docs/implementations/2026-09-07-m8-9-seeing-the-work.md` — the milestone whose runs surfaced
  this, and the same refusal-quality lesson one layer up
- `test/tmpdir.ts` — why removal waits, and why a wait that fails is reported rather than hidden
