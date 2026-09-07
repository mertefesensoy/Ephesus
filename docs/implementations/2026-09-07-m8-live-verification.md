# M8 — live verification against the Architect's own harness

**Date:** 2026-09-07
**Branch:** `feature/m8-11-engine-honesty`
**Scope:** Architect-chosen — boot, surfaces and restart, **no agent spawned, no
tokens spent**. Two Architect decisions executed here (the gate policy, the
standing breaker stops) and one routed into M8.12 (first-launch consent).

This is not a test run. It is the shipped code booting twice against
`~/.ephesus` — the real roster, the real book of record, the real activation
store — and what it did being read back out of the durable record.

---

## 1. Problem / motivation

Every M8 package carries unit and integration evidence. What none of them
carried is the milestone's own claim: *the company you can leave running*. That
claim is about a real home directory with a week of history in it, and the
recurring defect of this codebase is a check that cannot fail — so the point of
this pass is to run the shipped thing and read what it actually wrote.

A second motivation: the M8 register lists seven Architect decisions (DD-1…DD-7)
as open. Three of them were not.

---

## 2. What changed

| File | What |
|---|---|
| `~/.ephesus/gate-policy.json` | Backed up, removed, and **re-seeded by boot** with `shippedGatePolicy`. Architect decision, §5.1. |
| `~/.ephesus/breaker-stops.json` | Backed up; both standing rung-3 stops cleared. Architect decision, §5.2. |
| `docs/PROGRESS.md` | DD register corrected; M8.12 scope extended with the consent gate; this evidence recorded. |
| `docs/DECISIONS-LOG.md` | The audit, the two executed decisions, and three findings. |

Both replaced files were backed up in place as `*.bak-2026-09-07` and neither
backup has been deleted.

---

## 3. The register audit — three of seven were already answered

Established by reading the code, not the register.

| Item | Register said | Actually |
|---|---|---|
| DD-1 gate policy | open | **Decided 2026-09-04**; `shippedGatePolicy`, [gates.ts:233](../../src/shared/gates.ts) |
| DD-2 claude-only | open | **Decided** (ADR-0024); implemented in this branch |
| DD-3 hire budgets | "breach inside one working day for every hire" | Shipped bundles declare **no budget at all** — every hire file's keys are `schemaVersion, name, version, role, displayName, engine, capabilities, envGrants, brief`. The live 5M–60M figures are the Architect's own, set by hand |
| DD-4 company-wide daily ceiling | "whether one exists at all" | **It exists** — `maxDailyTokens` (ADR-0029), `maxDailyTokensSchema` at gates.ts:142, surfaced in `SettingsPanel`. The Architect has set none, which the code reads as `unbudgeted` |
| DD-5 block cap + pathology | "both currently unreachable by construction" | **Stale — both reachable.** `hermes.ts:1179` calls `onPathology` when `isPathological(blocks)` (`PATHOLOGY_SIGNAL_AT = 10`), wired at `index.ts:2082` to `breaker.notePathology`; `blockCap` (`DEFAULT_BLOCK_CAP = 20`) reaches `decideStop` via `index.ts:2040` |
| DD-6 first-launch consent | open | **Genuinely open.** No consent machinery exists anywhere in the tree; `artemis.start` runs unconditionally once the reference engine is registered |
| DD-7 settings surface | "whether one is in scope at all" | **Mostly answered** — `SettingsPanel` ships the two company ceilings and is reachable (`App.tsx:503` → `WatchPanel` → `SettingsPanel`). The `rules` table is deliberately excluded, with the reason in the panel's header |

This is the third consecutive package where auditing the register before building
saved work (M8.9, M8.10, M8.11). It is now a habit worth naming as one.

---

## 4. Mathematical / statistical details

None. Nothing here computes a figure; every number below is a count read out of
a file or a log.

---

## 5. Design decisions

### 5.1 The gate policy was stale, and looser than the decision

`home.ts` seeds `gate-policy.json` **only when it is absent**, deliberately —
`~/.ephesus` is the Architect's copy. The consequence is that a machine set up
before a decision never receives it. The live file was dated 2026-09-01; DD-1
landed 2026-09-04.

| kind | shipped (DD-1) | was live | direction |
|---|---|---|---|
| destructive / prod-facing / scope-change | supervised | supervised | same |
| **outbound** | **supervised** | **absent** → composes at top-level `autonomous` | **looser — posts went out ungated** |
| **needs-human** | **manual** | supervised | looser |
| **spend** `maxSpendTokens` | 200,000 | 50,000,000 | 250× looser |

Architect decision: bring it to the shipped default. Executed by backing the
file up and **letting boot re-seed it**, rather than by hand — so the value
written is the one `gates.ts` holds and cannot drift from it. Verified: the
seeded file is byte-identical to the literal, and the second boot did **not**
touch it (mtime `1788808476` before and after).

### 5.2 The standing stops, and what clearing them is not

Two durable rung-3 stops, `agent.artemis` and the health-watcher, both
`burn-rate / budget: breached`, written 2026-09-06 ~09:00 UTC. The budget window
is a **day** — `spendFor` filters `row.day === dayKey(this.now())` — so the
condition that produced them expired about 34 hours before this run, and nothing
re-evaluates a stop. Architect decision: clear both.

**How it was actually done, which is not what was planned.** The intent was to
clear them in the Watch panel's STOPPED AGENTS section, so the clear path itself
would be exercised. Driving the Electron window needs desktop-control access,
whose approval dialog the Architect was not at the machine to answer, so that was
not attempted. Instead both stops were cleared by writing
`{"schemaVersion":1,"stops":[]}` over the store file **with the app stopped**,
via temp-file + rename, after a backup. That reaches the same durable state but
it is **not** proof that the button works; what is proved about that path is
static — the channel is wired end to end (`ipc.ts:199` → main handler at `:362` →
preload `clearBreakerStop` → `WatchPanel` `onClear`). The written file was then
parsed with the shipped `breakerStopsSchema`: parses `true`, `stops.length` 0.

**Consequence the Architect should expect:** the next launch will hire Artemis,
because the thing that was refusing her is gone.

### 5.3 First-launch consent goes to M8.12

Architect decision: add a consent gate in M8.12 rather than defer it to M7b. The
present behaviour is confirmed live — boot hires the orchestrator with no consent
step, and `~/.ephesus/triggers.json` shows `standup`, `retro` and
`gym-metric-check` sharing the timestamp `1788631795998`, so the first tick does
fire them together. Recorded into M8.12's scope in `docs/PROGRESS.md`.

---

## 6. Verification — what the two boots actually did

Boot 1 `ELECTRON_ENABLE_LOGGING=1 npm run dev`, 2026-09-07 22:14 local. Boot 2 at
22:17. 82 new rows in `agora/log.jsonl`, seq 2689–2770.

### 6.1 Proved

| Claim | Evidence |
|---|---|
| **M8.4 / §5.1** the harness creates what it needs and says so | `home: gate-policy.json was missing and has been created with the shipped default — review it at C:\Users\senso\.ephesus`, also a `degradation` row with cause `home/seeded-config` |
| the seeded value cannot drift | seeded JSON compared field-by-field to the `gates.ts` literal — identical, `outbound: supervised` present, `needs-human: manual`, spend ceiling 200000 |
| seeding is only-when-absent | boot 2 left the file's mtime unchanged |
| **M8.8** the trigger clock survives a restart | `restart: restored the last-fired clock for 7 trigger(s)` — on **both** boots |
| **M8.8** a restored instance declares its crew down | `restart: skeleton-crew@repo:musahit restored from 2026-09-06T08:51:49.229Z — 4 hire(s) are down and 2 schedule trigger(s) stay disarmed until it is reactivated` — both boots |
| **M8.8** a durable stop refuses the hire, with a reason that teaches the rule | `{"kind":"orchestrator","event":"down","agentId":"agent.artemis","detail":"could not be hired: agents: \"agent.artemis\" will not be respawned — the breaker stopped it at rung 3 (burn-rate); clear the stop first","seq":2697}` |
| **M8.10 D5** stranded mail is disclosed, not dropped | three `hook/mail-stranded` rows plus three degradations: 9 for `agent.artemis`, 10 for the health-watcher, 3 for the verifier. Mail left in place; nothing spawned |
| **M8.5** the Harbor ingests a real repository | 4 open pull requests and 7 CI runs from `mertefesensoy/MUSAHIT`, tagged `remote` |
| **M8.9** the incident fold has real material | 75 `incident-*` rows → **7 distinct incidents**, 39 raised, **12 triage refusals against 21 attempts**, 3 verdict refusals |
| **M8.11** a non-reference engine is refused | see §6.2 |

### 6.2 The M8.11 refusal, against a real bundle on disk

A throwaway bundle was installed at `~/.ephesus/profiles/engine-honesty-probe/`
with two hires — `watcher@claude` and `stranger@codex` — and a profile autonomy
default of `autonomous`, which is the exact level ADR-0031's spawn guard lets
through. It was read from disk by the real `parseProfile` and planned by the real
`activationPlan`:

```text
EVIDENCE loaded bundle: engine-honesty-probe v1
EVIDENCE hires: stranger@codex, watcher@claude
EVIDENCE profile autonomy default: autonomous
EVIDENCE activation ok: false
EVIDENCE refusal: hire "stranger" declares engine "codex", which this build
refuses: the MVP ships claude only (ADR-0024), and on any other engine this hire
would ignore the autonomy it was granted, stop after one turn for want of a
continuation hook, and report itself idle for ever — set the hire's engine to
"claude"
```

Three things this shows that a fixture could not: the bundle **loads** (the
refusal is at activation, not at parse, which is where ADR-0024 puts it); only
the offending hire is named; and the case is the `autonomous` one that ADR-0031
deliberately lets past the spawn guard. The bundle was removed afterwards.

### 6.3 NOT proved — stated so nobody reads more into this than it holds

- **No UI was driven.** No screenshot, no click. Everything above is the book of
  record and the production code paths behind those panels. The panels' own
  rendering is covered by the renderer suite, not by this run.
- **Log rotation was not exercised.** `log.jsonl` is 688 KB against a 4 MiB
  threshold, so no segment was ever sealed. M8.10's rotation evidence stands on
  its own synthetic runs and the forced rotation recorded there.
- **M8.10 D10 (the roster's `profile` field) was not exercised.** It is written
  during a spawn, and no agent spawned. Every roster entry still reads
  `profile: null`.
- **M8.11's hook-grade migration was not exercised.** The live roster is
  `{"native": 7}` — no entry carries the retired spelling, which is why the
  migration's tests build the legacy roster themselves.
- **No agent ran and no tokens were spent.** That was the Architect's choice of
  scope, and it means the milestone's headline claim — a company left running —
  is proved here only up to the point where work would begin.

---

## 7. Findings

**F1 — the book of record contains a duplicate sequence number.** `seq: 143`
appears twice: once at line 142 (`spawn`, 2026-08-29T15:15:02Z) and again at line
177 (`exit`, 2026-08-29T17:31:48Z), where 178 was expected. Pre-existing and
unrelated to this run: today's 82 rows are perfectly contiguous with zero
out-of-order entries. It matters because M8.10 built cursor-based readers keyed
on `seq`, so a cursor landing there can skip or repeat one row. **Not repaired** —
`log.jsonl` is append-only (invariant §5) and rewriting history to fix a
readability wart is the larger harm. Owed: a decision about whether readers
should tolerate a duplicate seq explicitly.

**F2 — stopping `npm run dev` does not stop Electron.** Killing the npm wrapper
left eight `electron.exe` children alive, so boot 2 ran **concurrently with boot
1 against the same `~/.ephesus`** for about three minutes — two harness instances,
one home, one git repository. No damage resulted (contiguous seqs, clean
`git status` in the Agora bar the expected `log.jsonl` modification), but that is
luck rather than design, and the eventlog's own contract already names the
second-process case as one it takes seriously. Stop Electron by process, not by
the wrapper.

**F3 — a suspected disclosure gap that was not one.** Artemis's refusal prints
nothing to stdout, which looked like an invariant §7 violation. It is not:
`artemis.start` catches and calls `reportDown`, which writes the
`orchestrator/down` row quoted in §6.1. Recorded because the wrong conclusion was
reached first and the correction is the useful part.

**F4 — two greps on the wrong key, both nearly reported as defects.**
`clearStop` looked unwired because the preload names it `clearBreakerStop`; the
incident board looked empty because it folds `event: 'incident-*'`, not
`kind: 'incident'`. Both would have been false findings. The general rule: before
reporting something as absent, search for what the *consumer* calls it.

---

## 8. Related docs

- [ADR-0024](../adr/ADR-0024-claude-only-for-the-mvp.md) — the refusal proved in §6.2
- [ADR-0031](../adr/ADR-0031-an-engine-declares-whether-it-can-enforce-autonomy.md) — the `autonomous` hole §6.2 closes
- [ADR-0027](../adr/ADR-0027-what-survives-a-restart.md) — what §6.1's restart rows are asserting
- ADR-0029 — the company-wide daily ceiling of §3's DD-4
- `docs/implementations/2026-09-07-m8-11-engine-honesty.md` — the package this run verifies
- `docs/DECISIONS-LOG.md` — 2026-09-07, the two executed decisions and F1–F4
