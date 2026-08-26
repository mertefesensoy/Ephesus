---
name: doc-sync
description: Detect and fix drift between the Ephesus documentation suite and the code — module map vs src/, IPC contract vs handlers, schemas vs validators, invariants vs implementation. Use after landing a milestone, before releases, or when asked whether the docs still tell the truth.
---

# Documentation ↔ code drift check

The docs are the contract; ENGINEERING-STANDARDS §6.4 says docs move in the same PR as
behavior. This skill audits that promise.

Check, in order, reporting each as OK / DRIFT (with file:line on both sides):

1. **Module map** — SDD §1.1 table vs actual `src/main/` contents (missing modules,
   undocumented modules).
2. **IPC contract** — SDD §5 surface vs handlers registered in `src/main/ipc.ts` and
   the preload bridge (missing, extra, or signature-changed entries).
3. **On-disk layout** — SDD §2 tree vs what the code actually creates under
   `~/.ephesus/` (grep for path constants).
4. **Schemas** — every schema'd file in SDD §4 has a validator in `src/shared/` and the
   documented fields match the validator's fields; `schemaVersion` present both sides.
5. **Invariant spot-checks** — grep-level tripwires from ENGINEERING-STANDARDS §5:
   secret reads outside `watch/`+`herald/`, `writeFile` onto live shared paths, hex
   colors in components, LLM-facing prose literals outside `prompts/`.
6. **Status honesty** — README/PROGRESS claims ("works", "shipped") that nothing in
   the test suite demonstrates.

Then fix: mechanical drift (tables, lists, signatures) — update the doc in place.
Behavioral divergence (code does something the design forbids, or the design needs to
change) — do NOT silently rewrite either side; file it as a must-ask or a Gymnasium
proposal (`/improve`) for the Architect. ADRs are never edited — supersede.

Output: a drift table (area · verdict · fix applied / escalated), then commit doc fixes
as `docs: sync <areas> with code`.
