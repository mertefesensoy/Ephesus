# 2026-08-28 — M5b: the Stoa + company modes

Living document for the M5b milestone. Sections are appended as each work package
lands; the package plan is in [`docs/PROGRESS.md`](../PROGRESS.md) (M5b.1–M5b.6).

---

## Problem / Motivation

The Gymnasium (ADR-0015) governs *how* the company improves itself, but FR-12.1
admits only **internal** records as evidence: org metrics, `log.jsonl`, breaker
trips, memo patterns, drift audits. That rule is load-bearing — it is what keeps a
proposal falsifiable — and it also means the company is structurally blind to every
other harness solving the same problems. It can learn from its own friction and
from nothing else.

ADR-0017 answers that with **the Stoa**: a research department that studies
repositories the Architect chooses, so a proposal can say not merely "this hurt us"
but "here is how a comparable system avoids it" — with the claim pinned to a commit
the Architect can open. The dangers are specific and were named up front: prompt
injection from arbitrary third-party text, license contamination, erosion of the
evidence rule, and authority creep (a researcher that can widen its own reading
list is the FR-12.3 problem reborn one subsystem over).

M5b builds that machinery, and ADR-0018's company modes decide *when* it is allowed
to run on its own initiative.

---

## What Changed

### M5b.1 — Watchlist + `stoa.ts` core

| File | What it does |
|---|---|
| `src/shared/stoa.ts` | NEW. The §4.7 watchlist schema (strict), `parseWatchlist`, the build-phase markdown seed reader, id derivation, and the three refusal predicates: `checkRegistrar` (R1), `checkStudiable` (FR-13.2), `checkIntake` (FR-13.5). |
| `src/shared/stoa-view.ts` | NEW. Renderer-facing types, zod-free so `shared/ipc.ts` and the sandboxed preload keep no runtime dependency. |
| `src/main/stoa.ts` | NEW. The `Stoa` driver: seeds from `docs/stoa/` at first use, reads/writes `agora/stoa/watchlist.json` atomically, Architect-only `register`/`retire`, read-only brief archive access. |
| `src/shared/ipc.ts` | The `stoa:` channel constants and the `EphApi.stoa` group — exactly SDD §5's five channels. |
| `src/main/ipc.ts` | The five handlers, each validating its payload at the boundary; `register` accepts a draft only. |
| `src/preload/index.ts` | The bridge methods. No registrar field crosses it. |
| `src/main/index.ts` | Constructs the `Stoa` beside the Gymnasium; supplies `'architect'` to every mutation; builds the panel rows with their blocked/intake reasons. |
| `src/renderer/src/StoaPanel.tsx` | NEW. The reading desk: register a source, see the watchlist (retired rows struck through), read archived briefs. |
| `src/renderer/src/App.tsx` | The `STOA` tab. |
| `docs/sdd/SDD.md` | §4.7 gains the `retired` array and the nullable `pin`, with the reasoning inline. |
| `docs/DECISIONS-LOG.md` | Six entries covering the shape decisions below. |
| `test/shared/stoa.test.ts` | NEW. 43 cases — schema accept/refuse table, seed reader, authority, gates, id minting. |
| `test/main/stoa.test.ts` | NEW. 27 cases — seeding both halves, register/retire, damaged file, read-only archive surface. |
| `test/main/ipc-handlers.test.ts`, `test/scenarios/s-secrets.test.ts` | The two rigs that construct `IpcDeps` gain the five stubs. |

---

## Implementation Approach

### M5b.1

The package is a vertical slice built to mirror the Gymnasium beside it, because
the two subsystems have the same governance shape and a reader who knows one should
recognise the other.

**Authority is asserted by main, never claimed by a caller.** `register(draft, by)`
and `retire(id, by)` take the actor from the caller and refuse anything that is not
`'architect'`. The only caller that may pass `'architect'` is the IPC handler, which
knows it is the Architect because the call arrived on the window bridge. The
renderer therefore has no field with which to name a registrar — the payload schema
is `.strict()` over a draft carrying `url`, `tags`, `license`, `pin`, `notes` and
nothing else, so an attempt to smuggle `registeredBy: 'artemis'` is rejected *at the
boundary* rather than quietly ignored. This is the `gym:verdict` pattern verbatim
(FR-12.3 → FR-13.1).

**The studiable set is a location, not a predicate.** Retiring moves an entry from
`sources` to `retired`, verbatim. Nothing filters; `sources` simply contains only
studiable sources. This is the same idiom SDD §2 uses for `inbox/` → `inbox/.done/`.

**The seed brings both halves across together.** At first use the driver parses
`docs/stoa/WATCHLIST.md` into entries *and* copies `docs/stoa/briefs/RB-*.md` into
`agora/stoa/briefs/`, then emits one `kind: stoa` log event naming both counts. The
Gymnasium shipped a ledger without the proposals its rows linked to and every link
broke (M5 close-out audit, finding 3); a seeded source whose brief did not cross
over would be the same half-archive one subsystem over, so the test asserts both.

**Degradations are visible and non-destructive.** No build-phase archive → a
reported degradation and an empty watchlist, never a failed boot. A watchlist on
disk that fails validation → reported, read as empty, and **left byte-for-byte
untouched**: the file may be the only copy of what the Architect registered, so a
boot that "repaired" it by truncating would destroy the record it could not read.

---

## Mathematical / Statistical Details

Not applicable to M5b.1 — no formula, statistical test, or numeric algorithm is
involved. The only computed values are an id slug (last URL path segment,
lower-cased, non-alphanumerics collapsed to `-`, capped at 48 chars, prefixed
`src-`, with a `-2`, `-3`, … suffix minted on collision) and the brief-id successor
(`RB-` + zero-padded `max(existing) + 1`, which never reuses a number even across a
gap, because a deleted brief's id may still be cited).

---

## Design Decisions

Two genuine gaps between documents were hit and resolved rather than guessed; both
are in `docs/DECISIONS-LOG.md` and both changed SDD §4.7.

1. **Retirement: a sibling array, not a flag.** FR-13.1 requires `retire`; SDD §4.7's
   entry shape has no way to express it. *Alternative considered:* a `retiredAt`
   field on the entry. Rejected because it makes every consumer responsible for
   filtering, and the day one forgets is the day the Stoa studies a source the
   Architect withdrew. The sibling array makes the invariant structural. Nothing is
   deleted either way — a brief that cites a source the record no longer contains is
   a citation nobody can check.
2. **`pin` is nullable.** §4.7 types it as a string because it describes a source
   that *has been* studied; the build-phase table carries "(set at first study)" for
   the rest, and FR-13.2 requires a pinned snapshot. *Alternative considered:*
   keeping it required and having the seed synthesise a commit. Rejected outright —
   an invented pin is the one thing the provenance chain cannot survive. Making the
   unpinned state representable is what lets `checkStudiable` refuse it.
3. **No `stoa:pin` channel.** `Stoa` will need to record the commit a study ran
   against, but SDD §7.7 puts pin-setting *inside the study flow*, so it lands with
   M5b.2 which owns that flow — not here as an Architect button nothing yet calls.
   Widening a documented IPC signature is a BUILD-PROMPT §8 must-ask.
4. **Study and intake are separate gates.** An `unverified` license permits study and
   refuses pattern intake (FR-13.5). "We did not check" is not a licence to copy, but
   it is no reason to refuse to read something public.

---

## Verification

Run from the repository root.

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
```

```bash
npx vitest run test/shared/stoa.test.ts test/main/stoa.test.ts
```

Expect **70 passed**. The load-bearing cases:

- `refuses "artemis" — the Stoa can never widen its own reading list` (and three
  other actors), each asserting the watchlist is unchanged *and* that a
  `register-refused` event was logged.
- `moves the entry to the retired list, verbatim — never deletes it`.
- `brings the briefs across WITH the table, not after it`.
- `is reported and read as empty — and is never overwritten`.
- `exposes no way to write one — the archive is read-only from here` (an exhaustive
  method-name assertion, so adding a method forces the question to be answered).

**Live run** (the evidence in `docs/demo/`):

```bash
EPH_HOME=/tmp/eph-demo npx electron-vite dev
```

Open the **STOA** tab. Expect three sources seeded from
`docs/stoa/WATCHLIST.md`; `src-hermes-agent` showing both refusals (no pinned
commit → FR-13.2; unverified license → FR-13.5) and `src-munder-difflin` showing
`MIT · pin: b91a49f` with none; `RB-001` listed under BRIEFS and readable in full.
Then confirm the harness wrote through the single committer:

```bash
git -C /tmp/eph-demo/agora log --oneline -1
```

Expect `stoa: seed the watchlist from the build-phase archive`, a clean tree, and a
`{"kind":"stoa","event":"seeded","sources":3,"briefs":1}` line in
`/tmp/eph-demo/agora/log.jsonl`.

Photographs: [`docs/demo/m5b-stoa-desk.png`](../demo/m5b-stoa-desk.png),
[`docs/demo/m5b-stoa-brief.png`](../demo/m5b-stoa-brief.png).

*Note on the local suite:* nine tests fail on this Windows machine before and after
this change (path- and TZ-dependent cases plus worktree/PTY timeouts), and five more
are load-flakes under full-suite parallelism that pass in isolation. Both sets are
recorded in `docs/DECISIONS-LOG.md`; the Linux CI gate is green on them.

---

## Related Docs

- [ADR-0017 — the Stoa](../adr/ADR-0017-stoa-research-department.md) (normative)
- [ADR-0018 — company modes & the proof gate](../adr/ADR-0018-company-modes-proof-gate.md)
- [SRS](../srs/SRS.md) FR-13, FR-14, NFR-17, UC-14, §6.8, §6.9
- [SDD](../sdd/SDD.md) §2, §4.3, §4.7, §5, §7.7
- [TEST-STRATEGY](../TEST-STRATEGY.md) S-STOA, S-MODE, E-STOA
- [PROGRESS](../PROGRESS.md) — the M5b package plan and per-package evidence
- [The Stoa's build-phase archive](../stoa/WATCHLIST.md)
