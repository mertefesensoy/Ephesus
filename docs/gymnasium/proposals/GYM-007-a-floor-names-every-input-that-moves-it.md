# GYM-007 — A floor names every input that moves it: corroborated ratchets, and the condition the tree hash cannot see

**Status:** proposed · **Proposed:** 2026-09-04 · **Decided:** —

## Evidence

**On 2026-09-04 the coverage gate produced three wrong answers in a row, and
each wrong answer was a different person reading the same number without its
condition.**

1. **A ratchet on n = 1.** `node scripts/check-coverage.cjs --update` after one
   `npm run test:coverage` raised `terraces.functions` on win32 from 84.65% to
   85.15% (commit `9b57f86`). One function in that subsystem is 0.495 points —
   *twice* the 0.25 tolerance — so a single-function wobble is enough to move
   the gate. Later runs in the same checkout read 84.65% and the gate then
   refused an unrelated branch.
2. **A "correction" to another single condition.** The floor was restored by
   hand to 84.65% (commit `7322943`) on the strength of four runs — all four in
   *one checkout on one machine*, which turned out to be the outlier.
3. **A second correction, to the opposite condition.** A follow-up session
   measured 84.16% three times in a `git worktree`, matched it against the linux
   record, read the agreement as "corroboration from a second machine", and
   lowered four win32 floors to it. The two observers agreed because they shared
   an undeclared condition, not because they were independent.

**The undeclared condition is the licensed art pack.**
`src/renderer/src/assets/{tileset,characters}/*.png` are a deliberate gitignored
drop — `assets/ATTRIBUTION.md` rule 2 keeps assets whose licence forbids
redistribution in source form out of the repository, and only the `*.tiles.json`
/ `*.chars.json` manifests are tracked (`.gitignore:14`, `:26`). So the globs in
`floor/tileset.ts` and `floor/characters.ts` are populated on a machine that
bought the pack and **empty on every CI runner, every fresh clone and every
worktree, permanently and by design**. With them empty, `tileset.layers` and
`characters.urls` are empty, the two loader loops in `FloorCanvas` iterate zero
times and `loadOne` is never called.

Measured, on this machine, by moving the pack aside and putting it back:

| terraces | lines | branches | functions | statements |
|---|---|---|---|---|
| with the pack | 76.13 | 72.48 | 84.65 | 76.17 |
| without it | 75.13 | 71.69 | 84.16 | 75.30 |
| **difference** | **10 lines** | **6 branches** | **1 function** | **10 statements** |

Those four "without" figures are exactly what the linux record held and exactly
what the worktree measured. The remaining ~1 line of movement is genuine jitter
from a floating `Promise.all` in `FloorCanvas`'s mount that no test awaited.

**The tool cannot see the variable.** `productionFiles`
(`scripts/check-coverage.cjs:98-105`) matches `src/**/*.{ts,tsx}` and
`shims/**/*.mjs` only, so `treeHash` is structurally blind to a PNG. Both
checkouts stamped the same `tree: c08617b1335b` while measuring different
subjects.

**And the consequence nobody was looking for.** `loadOne`, both loader loops and
the sheet-error arm have **never once run in CI**. They were exercised on
exactly one machine on earth. Under this repository's own seam rule
(ENGINEERING-STANDARDS §6.7) that is a defect independently of any floor, and it
would have survived every correct floor decision above.

## Proposal

Three parts. The first is the gate change this proposal exists to record; the
second removes the variable that caused the misreadings; the third fixes the
metric that told us to do the wrong thing.

1. **A raise takes corroboration.** `--update` accumulates a *window* — the last
   `corroboratingRuns` (3) runs measured on one production tree **and one
   subsystem map**, each carrying its condition and the identity of the coverage
   report it read. A floor rises only when the window is full, and only to the
   window's metric-wise **minimum**. The window slides rather than emptying (the
   tree hash covers production files only, so adding tests must stay
   recordable) and restarts when the tree or the subsystem map changes. The
   **failure side is untouched**: a regression past the tolerance still fails on
   the single run that measured it, because a gate that waited for corroboration
   before failing would let the first regression through.

   The subsystem map is compared by **membership**, not by the set of names:
   moving a directory from one subsystem to another leaves both names standing
   and changes what every figure under them means.

2. **Remove the art pack from the coverage equation.**
   `test/renderer/floor-canvas.test.tsx` stubs both glob modules, calling the
   *real* resolvers over fixed inputs so the stub cannot drift from the schema.
   The loader loops then run a fixed count everywhere. And `FloorCanvas` hands
   out a bring-up handle (`onBringUp`) so the test can await the chain instead of
   guessing how deep it is.

3. **Amend GYM-006's success metric #2.** It reads: *"A platform-jitter failure
   counts as a false positive and triggers a re-measured tolerance, never a
   lowered floor."* The instruction is right and was violated. The *diagnosis* it
   offers is too narrow: it assumes the only cross-machine variable is jitter. It
   was not — it was an undeclared build input. Amend it to require that a
   per-platform floor names every input that changes it, and record the
   false-positive count honestly: one, and its cause was not jitter.

## Success metric

1. **The same number everywhere.** `terraces` measures identically with the art
   pack installed and with it absent, on win32 and on CI linux, across the M8.6
   and M8.7 branches. Verified by moving the pack aside and re-running, recorded
   in the implementation doc.

   **Met as of 2026-09-04.** `FloorCanvas` reads identically with the pack,
   without it, and on CI linux. The last 0.27 was two branch arms, found by an
   arm-level diff of two full runs rather than by comparing percentages:
   `src/shared/characters.ts:182` and `src/shared/tileset.ts:284`, both the
   `credit === undefined ? '' : …` ternary. Every fixture omitted `credit` and
   every shipped manifest carries one, so the credit side ran only on a machine
   holding the licensed pack — never in CI. Closed by giving each resolver a
   credit-bearing fixture case, which also gives a UI-DESIGN §7 licence
   obligation its first deterministic test.

   *The method is the transferable part: when a figure moves with an
   undeclared input, diff the two conditions at ARM level. Percentages are what
   hid this for three wrong diagnoses.*

2. **No floor is corrected by hand again before 2026-10-02.** Every floor change
   in that window is an `--update` over a full window, visible in the diff as a
   candidate with three runs. A hand edit in the window counts as a failure of
   this proposal, not of the person making it — it means an input is still
   unrecorded.
3. **A linux floor is still ratchetable.** At least one linux floor is raised
   through `--update --from` over three CI artifacts on one tree before
   2026-10-02, proving the corroboration requirement did not make the linux
   record inert. This is the metric most likely to fail and is the reason this
   is its own row rather than a fold-in.

## Rollback

`corroboratingRuns` back to 1 restores the pre-change raise behaviour with no
other edit (the validator's floor of 3 is lifted in the same commit); the window
in `platforms.<name>.candidate` is additive and is ignored by a reader that does
not know about it. The stub in `test/renderer/floor-canvas.test.tsx` and the
`onBringUp` prop are independently revertable and would return `terraces` to a
pack-dependent figure — which is the state this proposal exists to leave.

## Related

- [GYM-006](./GYM-006-coverage-floors-and-the-seam-rule.md) — the gate this
  corrects, and whose metric #2 this amends
- `docs/ENGINEERING-STANDARDS.md` §3 (process changes go through the Gymnasium),
  §6.7 (the seam rule), §6.8 (recorded engine output — the same lesson, one
  package earlier)
- `docs/implementations/2026-09-04-coverage-gate-and-the-art-pack-condition.md`
- `src/renderer/src/assets/ATTRIBUTION.md` — why the pack is gitignored, and why
  that is not going to change
