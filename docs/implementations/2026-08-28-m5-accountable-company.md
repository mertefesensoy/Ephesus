# 2026-08-28 — M5: the Odeon + Gymnasium v1 (the accountable company)

## Problem / Motivation

M4 reached parity with the upstream inspiration; M5 is the first differentiator
milestone (IMPLEMENTATION M5): a company that doesn't just work but *accounts
for its work* — decks that gate task closure, memos that hold actions until a
human (or a countersigning, delegated Artemis) has ruled, briefings that cannot
say anything they cannot cite, meetings with enforced turn order and filed
minutes, an org layer that computes without deciding, and the Gymnasium's
governed self-improvement loop running in the product, not just the repo.

## What Changed

One package per merge, eleven `--no-ff` merges gated individually (the
integration order is a DECISIONS-LOG entry):

| Package | What landed |
|---|---|
| M5.1 | The agent↔task binding join (derived from `tasks.json`, never remembered); gates attach to bound tasks; breaker rung 3 returns work as `stalled` — the M3/M4 carried item |
| M5.2 | Deck archive + mechanical close gate (`review:deck` refuses `done` without its deck) + in-app viewer (`sandbox=""` kept), Architect comments as mail |
| M5.3 | Memo policy engine at the choke points; `memo.md`+`verdict.json` per SDD §4.5; Artemis triage — `mayDecide`'s first production caller, countersignature written by the harness; rejection reverses the held action |
| M5.4 | Briefing compiler: facts with refs first, narration checked sentence-by-sentence against the issued fact set; refusal leaves the ask open (`BriefingJob.narrated`) |
| M5.5 | Meeting driver: enforced turn order (early answers held, not lost), interjection floor-grab, minutes archived; the Odeon room |
| M5.6 | Org layer v1: chart, versioned hire templates, metrics recomputed from `log.jsonl` + the cost fold (no rollup table — a recorded decision), the weekly retro that decides nothing |
| M5.7 | Gymnasium v1: shape validation pre-human, Architect-only verdicts (R1 three ways), authority-widening refused before any verdict, `regressed ⇒ rollback`, ledger seeded from `docs/gymnasium/` |
| M5.8 | The five suites (S-DECKGATE, S-MEMO, S-BRIEF, S-MEETING, S-GYM) + exit demos; the ODEON_ENDPOINT (`agent.odeon`) so agents file artifacts only by mail; `odeon-endpoint.ts` factory shared by app and rig |

In parallel on the same mainline: the research-department line (ADR-0017–0020,
RB-001, GYM-002 hook-boundary steer, GYM-003 closing time) — merged one branch
at a time; the merge itself surfaced the gymnasium linked-id parser defect,
fixed with the `idCell` round-trip.

## Implementation Approach

Accountability is *enforced, not conventional* (ADR-0008): every gate is a
mechanical refusal (`canCloseTask`, the memo hold, the narration check), every
archive is harness-written and append-only, and every agent contribution
arrives as mail to a reserved endpoint — an artifact cannot be back-dated,
edited in place, or filed for a task its author was never given. The Gymnasium
reuses that machinery wholesale (ADR-0015): same endpoints, same gates, same
single committer.

## Mathematical / Statistical Details

Org metrics are ratios over the book of record (tasks done, rework, escalation
rate = escalations/tasks, budget efficiency), recomputed on read; `—` (null)
distinguishes "no tasks" from a zero rate. The brief's length budget is
word-count arithmetic at VOICE-DESIGN's 150 wpm against the ≤ 90 s bound.

## Design Decisions

In DECISIONS-LOG under the M5.x entries; the load-bearing ones: one scribe per
shared file extended to the Odeon (agents file by mail, `agent.odeon`); minutes
mail their action items to the orchestrator rather than writing the ledger
(single-scribe; ADR-0008 §4 clause-noted in the ADR index); metrics recompute
rather than roll up; the `sandbox=""` deck viewer was not loosened for a
screenshot.

## Verification

- **M5 exit review** (PROGRESS): all six criteria run against the committed
  tree — five suites 55/55, real memo/deck/meeting/brief demos through the
  app, the retro generated from the company's own records
  ([demo](../demo/m5-retro-report.md)); full suite 1887/6-skipped; CI green on
  every M5 commit and on the integrated tree (run 33177234907) before `main`
  moved.
- **M5 close-out audit** (this session, two agents): execution audit re-proved
  every criterion (55/55 + 80/80 scenarios, parser proven against the live
  archive, CI green at HEAD); conformance audit found one violation — the
  ledger's seven-cell `renderRow` erasing Measured/Outcome on rewrite — fixed
  with round-trip regressions, plus four smaller fixes (verdict prompts, seed
  proposals, honest gym-slice null, `memory`/`stoa` log kinds + full
  reserved-id test) and doc syncs, all recorded in DECISIONS-LOG and the
  PROGRESS audit section.

## Related Docs

[PROGRESS](../PROGRESS.md) M5 + close-out audit · [ADR-0008](../adr/ADR-0008-odeon-accountability.md) ·
[ADR-0015](../adr/ADR-0015-gymnasium-self-improvement.md) · [SDD](../sdd/SDD.md) §4.5, §7.2–7.6 ·
[demo view](../demo/) · [RB-001](../stoa/briefs/RB-001-munder-difflin-orchestration-autonomy.md)
