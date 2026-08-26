---
name: build-package
description: Execute the next Ephesus work package from BUILD-PROMPT.md — resume from docs/PROGRESS.md, run the READ→PLAN→BUILD→TEST→PROVE→COMMIT→REPORT loop, and never proceed on red checks. Use when asked to continue building Ephesus, implement a milestone/package, or "keep going".
---

# Build the next work package

1. Read `BUILD-PROMPT.md` in full. It is the contract for this session; its §3
   invariants and §7 prohibitions override any instinct you have.
2. Open `docs/PROGRESS.md`. If missing, create it seeded with the M0–M7 checklist from
   `docs/IMPLEMENTATION.md` and the M0/M1 packages from BUILD-PROMPT §5. Find the first
   unchecked package. If the current milestone has no package list yet, derive one per
   BUILD-PROMPT §5 ("M2 → M7") and write it into PROGRESS.md before coding.
3. Read only the docs BUILD-PROMPT §2 maps to this package.
4. Execute the working loop (BUILD-PROMPT §4). Hard rules:
   - `npm run typecheck && npm run lint && npm test` green before any commit.
   - Tests owed by the package (TEST-STRATEGY §2 mapping) are part of the package.
   - Evidence (command + observed result) goes in the commit description.
   - 3 failed distinct attempts on a blocker → stop, record it, report (don't hack around).
5. Tick the package in `docs/PROGRESS.md` with a one-line evidence note; log any minor
   choices in `docs/DECISIONS-LOG.md`; queue must-ask questions for the Architect.
6. End with the session report format from BUILD-PROMPT §9.

Package too big mid-flight (> ~10 files)? Split it in PROGRESS.md and do the first half
properly rather than all of it loosely.
