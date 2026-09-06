# M8.9 — Seeing the work

**Date:** 2026-09-07
**Requirement:** FR-9.2, UC-09 (the incident path) · FR-2.3, SDD §10 (the event plane) ·
invariants §7 (every degradation visible) and §8 (prompt text is config)
**Docs:** ADR-0027 §5 (held or derived) · SDD §5 (the IPC contract) · SDD §4.3 (log kinds) ·
UI-DESIGN §4 (tabs and the status strip)
**Branch:** `feature/m8-9-seeing-the-work`, cut from `main` at `956b434`

---

## 1. Problem / motivation

M8.9 is not a features package. Everything in it was already working, already tested, and
already invisible — which on a system whose premise is *leave it running* is the same as not
working. Three separate instances, all read off the Architect's own `~/.ephesus/agora/log.jsonl`
rather than imagined:

**A refusal that could not teach the rule it enforced.** 21 incident triage attempts, **12
refused**. Nine of those twelve are `agent.artemis` replying to `agent.harbor` in prose —
`"Task opene…"`, `"Assigned t…"`, `"Reassigned…"`. She is doing exactly what
`prompts/harbor/incident-body.md` asks (open the task, assign it to the on-call agent) and then
writing back to say so, which the **same prompt forbids by name and warns will bounce**. It
bounced nine times, and each time she was told:

```text
triage report: not JSON — Unexpected token 'T', "Task opene"... is not valid JSON
```

The guard is correct. The sentence is useless. A parse error cannot teach the rule it is
enforcing, so the refusal is re-earned on the next incident — which is precisely what the nine
rows are.

**A verifier's reasoning thrown away for length.** 3 root-cause verifications asked, **3
refused**, and `incident-root-cause-verdict` appears **zero times in the whole file** — the
verification path has never once completed on this machine. All three refusals read
`because: Too big: expected string to have <=2000 characters`, and
`prompts/harbor/incident-verify-body.md` never told the verifier that limit existed.

**A bridge that could not stop saying "ready".** `App.tsx` probed `eph.config.get()` from a
`useEffect(…, [])` — once, at mount. `bridge: ready` therefore meant *main answered when this
window opened*, and went on meaning that through a main process that died an hour later. There
was no heartbeat anywhere in `src/`.

And under all three, the reason none of it surfaced: **`IncidentEndpoint` reaches the outside
world only through `onLogEvent`.** Every incident fact was in the book of record and nothing in
the application could show it.

## 2. What changed

| File | What |
|---|---|
| `src/main/incidents.ts` | A wrong-sender guard on `onTriage`; `stillOpen` on `refuseVerdict`; `advice` on `refuse`; `incident` on both refusal log rows |
| `src/shared/parse-reasons.ts` | **new** — re-words Zod's size issues against the value actually sent |
| `src/shared/incident.ts`, `src/shared/root-cause.ts` | Both parsers route their reasons through it |
| `prompts/harbor/incident-not-your-triage.md` | **new** — the rule Artemis needed instead of a parse error |
| `prompts/harbor/incident-verdict-refused.md` | **new** — the thread is still open and the reading still counts |
| `prompts/harbor/incident-verify-body.md` | States the two limits the verifier is held to |
| `src/shared/freshness.ts` | **new** — `stallOf`: has this reading stopped answering? |
| `src/renderer/src/App.tsx` | The bridge probe becomes a heartbeat; a strip clock; `capacityOkAt` |
| `src/renderer/src/StatusBadge.tsx` | `BridgeBadge` (and `BridgeState`); staleness on `CapacityBadge` |
| `src/shared/incident-view.ts` | **new** — `foldIncidents`: the book of record → what the panel shows |
| `src/renderer/src/IncidentsPanel.tsx` | **new** — the surface, inside the Profiles tab |
| `src/renderer/src/ProfilesPanel.tsx` | Mounts it |
| `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/index.ts` | `harbor:incidents` — one read channel |
| `docs/sdd/SDD.md` | §5 gains `harbor: incidents()` with why there is no store |
| `scripts/coverage-floors.json` | Three new modules assigned; the win32 floors ratcheted (see §7) |
| `test/main/hires-exchange.test.ts` | Its harbor tripwire gains a pinned read-only list |

New tests: `test/main/incident-refusals.test.ts` (12) · `test/shared/parse-reasons.test.ts` (6) ·
`test/shared/freshness.test.ts` (8) · `test/renderer/bridge-heartbeat.test.tsx` (6) ·
`test/shared/incident-view.test.ts` (15) · `test/renderer/incidents-panel.test.tsx` (11) ·
`test/main/incident-surface-wiring.test.ts` (6).

## 3. Implementation approach

### 3.1 The wrong-sender guard is deliberately narrow

`onTriage` refuses **the orchestrator alone**, and only when no live binding puts her on call —
looked up from the threaded incident when the reply threads, and from `bindings()` when it does
not, because an agent that composes a fresh message leaves nothing to resolve.

The obvious generalisation — *only `incident.agentId` may report* — is wrong, and the live log
says so:

```text
agent.artemis → agent.skeleton-crew-musahit-dependency-updater
  "t-inc-musahit-ci-34000060811 — triage MUSAHIT CI run #34000060811
   (reassigned to you; on-call agent is out of budget)"
```

Artemis reassigns triage. A rule that refused the reassignee would refuse honest work in order
to fix a courtesy reply. The guard also does not fire when a binding puts the orchestrator on
call, so a one-agent company is not refused for doing its job.

### 3.2 Refuse, do not truncate — and why that is the cheap option

The register left the choice open: *refuse with the limit named, or truncate with a marker.*
**Refuse.** Truncating rewrites a verifier's reasoning, and a `because` cut mid-qualification
("the claim holds only if you ignore that the file was renamed, which —") is a claim nobody
made, which is the exact failure `checkVerdict` exists to catch.

Refusal is cheap here because of a property of the code rather than a hope: `refuseVerdict`
never clears `awaitingVerdict`, so the thread stays open and a shortened second answer is
accepted. That property is now a test (`accepts the shortened second answer on the same
thread`), because it is the whole reason this option is better than the other one.

Three parts, because the message alone would not have stopped the waste:

1. the **prompt** states the limits — a limit an agent is never told is one it can only discover
   by losing a turn to it;
2. the **reason** names both numbers — `because: 4231 characters, and the limit is 2000` — since
   "the limit is 2000" alone does not say whether to cut fifty characters or four thousand;
3. the **advice** says the question is still open and the reading already done still counts, and
   is deliberately absent on the three paths where nothing is awaiting an answer.

### 3.3 A deadline, not a catch

A main process that *threw* rejects the invoke and the existing `.catch()` has always handled
it. A main process whose loop is *blocked* does neither — the invoke never settles — so a
catch-based heartbeat would sit silent through exactly the failure it was written for. What
distinguishes hung from idle is the answer **not arriving**, which is a fact about the clock.

Hence `stallOf`, and hence a strip clock that ticks on its own: a stall is the absence of
events, so a component that only re-renders on one cannot show a silence growing.

### 3.4 The incident surface is DERIVED, and the ADR had already said so

The design question the register required answering first has an answer already on the record.
**ADR-0027 §5's first bullet names incident correlation as deliberately NOT persisted**, and its
closing line rules out the alternative by name: *do not persist state that a live subsystem
re-derives from a durable source.* So `foldIncidents` reads `log.jsonl` through
`Agora.readLogAll()`, there is no new record and no new writer, and `harbor:incidents` folds on
every call rather than caching.

One thing had to be fixed before the fold was possible: a refusal row carried **no incident
key**, so twelve refusals could be counted and not attributed. `incident-triage-refused` and
`incident-verdict-refused` gained it in the first commit, before the surface was built.

The fold makes two choices that look like edge cases and are the point:

- a refusal it cannot attribute gets its **own list**, because the parse-failure path is exactly
  where the key is unknowable and dropping those would make the panel report *fewer* refusals
  than happened — the absence it exists to replace. Guessing would be worse: a refusal filed
  against the wrong incident is a fact nobody can correct.
- "nobody checked this diagnosis" is a **sentence**, not an empty space.

## 4. Numeric details

`stallOf({ lastOkAt, watchingSince, now, deadlineMs })`:

```text
since   = lastOkAt ?? watchingSince
silence = now − since
stalled = silence ≥ deadlineMs        →  return silence
otherwise                             →  return null
```

`deadlineMs` defaults to `STALE_AFTER_MS = 6 000` — three poll periods at the renderer's 2 s
cadence. One period would flag every ordinary scheduling hiccup and teach the Architect to
ignore the warning, which is worse than not showing it.

`watchingSince` is the fallback rather than an error case: it is what makes a poll that has
**never** answered age on the same clock as one that stopped, so a main process that was already
dead at mount is reported instead of reading "connecting…" forever.

A clock that has gone backwards yields a negative `silence`, which is already less than any
deadline, so no stall is reported and **there is no separate guard for it**. Adding one would be
a branch no mutation could kill. The property is pinned by a test even though the code for it is
not separable.

`reasonsFor` measures a rejected value by walking the issue's own path into the raw input —
`.length` for a string (characters) and for an array (items) — rather than reading
`issue.input`, which is present on some Zod paths and absent on others; a measurement that can
silently stop being available is a check that cannot fail.

## 5. Design decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| Refuse an over-long verdict | Truncate with a marker | Truncation rewrites reasoning; the thread stays open by construction, so refusal costs one turn and loses nothing |
| The wrong-sender guard fires on the orchestrator only | Only `incident.agentId` may report | The live log has Artemis reassigning triage; the broad rule refuses honest work |
| A deadline on the probe | A `.catch()` heartbeat | A hung main never rejects; the invoke never settles |
| Derived incident surface | An `incidents.json` store | ADR-0027 §5 forbids it by name and records the reason |
| Unattributed refusals get their own list | Drop them; or attach to a guessed incident | Dropping under-reports the exact defect; guessing is uncorrectable |
| A panel inside PROFILES | A fourteenth tab; the Watch; the Activity feed | UI-DESIGN §4 lists no Incidents tab; the incident path is a profile instance's; `SecretsPanel`/`SettingsPanel` set the precedent |
| Two passes in the fold | One pass over an append-only file | "Right given the order it is called with" is the coupling that breaks the first time somebody pages backwards |

Full reasoning, including what each rejection cost, is in `docs/DECISIONS-LOG.md` under
2026-09-07.

## 6. What the mutation pass found

43 mutations over every guard this package adds; **43 killed**, one after a round of reading.

The single survivor was `fold: a re-raise opens a second incident` — removing
`if (byKey.has(key)) continue`. It survived because the map is **keyed**: a second `set`
overwrites rather than appending, so the incident count stayed at one and the refusals, added in
pass two, still landed. What the guard actually protects is `raisedAt`: without it, a build that
has been failing since Monday is restamped as raised this morning and moves in a list ordered
newest first. That was a missing assertion, not an equivalent mutant — the test now pins
`raisedAt` to the first sighting, and the code comment was corrected to say what the guard is
really for.

Two of this package's own tripwires fired and both were working:

- `test/main/hires-exchange.test.ts` refused a fifth `harbor:` channel by name. That is what it
  is for — a new harbor channel must be looked at by a person. `harbor:incidents` was reviewed,
  confirmed to be a read with no write path, and added to a **pinned** read-only list, so
  "exclude the reads" cannot itself become the hole.
- `scripts/check-coverage.cjs` refused each new `src/shared/` module until the subsystem map
  claimed it.

## 7. Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs \
  && npm run test:coverage && node scripts/check-coverage.cjs \
  && node scripts/check-attribution.cjs
```

Observed on `win32`, Node v20.16.0: **212 test files, 4014 passed, 0 failed, 8 skipped**;
typecheck, lint, invariants (`reachability 179/187 src modules reached`) and attribution all
green.

Targeted:

```bash
npx vitest run test/main/incident-refusals.test.ts test/main/incident-surface-wiring.test.ts \
  test/shared/incident-view.test.ts test/shared/freshness.test.ts \
  test/shared/parse-reasons.test.ts test/renderer/bridge-heartbeat.test.tsx \
  test/renderer/incidents-panel.test.tsx
```

**Production call paths**, per ENGINEERING-STANDARDS §6.7:

- the refusals — `src/main/index.ts:1955` (`harbor` route) → `IncidentEndpoint.onTriage`;
  `src/main/index.ts:1952` → `onVerdict`;
- the heartbeat — `src/renderer/src/App.tsx`, the `probe()` effect → `BridgeBadge`;
- the surface — `src/main/index.ts` `incidentBoard: () => foldIncidents(agora?.readLogAll() ?? [])`
  → `src/main/ipc.ts` `harbor:incidents` → `src/preload/index.ts` → `IncidentsPanel`, mounted by
  `ProfilesPanel`.

`test/main/incident-surface-wiring.test.ts` closes the seam that the two half-tests leave open:
it runs the real endpoint against a real `Agora` in a temp directory and folds what
`readLogAll()` returns, so a field the endpoint writes as `oncall` and the fold reads as
`onCall` fails there rather than rendering an empty card in front of the Architect.

**Coverage.** Two notes on what moved and why, and then what is still owed:

- the `panels` **branch** floor was failing on `main` **before this package** — `main` at
  `956b434` produces the identical `39.91%` against a floor of `40.26%` recorded at `ca1158a`,
  because `SettingsPanel.tsx` (290 lines) landed after that measurement. Attributed by running
  the gate on `main` itself rather than assumed;
- it is no longer failing, because `src/renderer/src/App.tsx` is covered for the first time — it
  leaves the record's `untested` list (21 modules, down from 22), and `panels` lines rise from
  34.5% to 42.43%, branches from 40.26% to 44.57%, statements from 33.36% to 40.75%; `boot` lines
  rise from 20.63% to 26.69% on the App import graph.

The win32 floors are **ratcheted on tree `d2cddb05c4db`** across three corroborating runs, rising
only to their lowest: `panels` lines 34.5 → 42.43, branches 40.26 → 44.57, functions 27.35 →
30.61, statements 33.36 → 40.75; `boot` lines 20.63 → 26.69, branches 8.59 → 16.57, functions
8.19 → 12.75, statements 19.75 → 25.87; `stoa` statements 95.16 → 95.5. A plain
`node scripts/check-coverage.cjs` is green.

**A machine condition worth writing down**, because it cost an hour and looked exactly like a
regression: free memory fell to **0.11 GB of 16.8 GB** partway through the session, vitest's
forks began dying mid-run (`Worker exited unexpectedly`), and the suite reported first 15 and
then 39 "failures" — none of which were real, and no coverage report was written at all. Two
observations settled it without a code hunt: the same tree ran green at `--maxWorkers=4` with
**byte-identical totals** (8174/10625 lines), which is also the evidence that worker count does
not move this measurement; and the ordinary command succeeded again the moment free memory
returned to 2.78 GB. Read `os.freemem()` before believing a suite that starts failing in
batches — and do not run anything else during a corroborating run, which is how two of the three
were lost the first time.

## 8. Related docs

- `docs/adr/ADR-0027-what-survives-a-restart.md` §5 — held or derived, and why incidents are not
  held
- `docs/DECISIONS-LOG.md`, 2026-09-07 — the three B14 decisions recorded before anything was
  drawn, plus the refusal-quality choices
- `docs/sdd/SDD.md` §5 — `harbor: incidents()`
- `docs/PROGRESS.md` — the M8.9 block and its scope audit
- `docs/implementations/2026-09-06-the-renderer-can-die-unnoticed.md` — the neighbouring half of
  the same "the UI cannot say it has stopped" problem
