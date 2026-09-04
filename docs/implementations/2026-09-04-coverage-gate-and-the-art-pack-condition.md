# The coverage gate, and the condition its tree hash could not see

## Problem / motivation

On 2026-09-04 the coverage gate produced three wrong answers in a row about one
subsystem. Each was a different person reading the same number without its
condition.

| # | What happened | Commit |
|---|---|---|
| 1 | `--update` after ONE run raised `terraces.functions` win32 84.65% → 85.15%. One function in that subsystem is 0.495 points — twice the 0.25 tolerance — so a single-function wobble moves the gate. It then refused an unrelated branch. | `9b57f86` |
| 2 | The floor was "corrected" by hand back to 84.65% on four runs — all four in **one checkout on one machine**, which was the outlier. | `7322943` |
| 3 | A follow-up session measured 84.16% three times in a `git worktree`, matched it to the linux record, called that "corroboration from a second machine", and lowered four win32 floors to it. | `545ffc0` |

**All three misread the same thing.** The variable was never timing.

### The variable is the licensed art pack

`src/renderer/src/assets/{tileset,characters}/*.png` are a deliberate gitignored
drop. `assets/ATTRIBUTION.md` rule 2 keeps assets whose licence forbids
redistributing them *in source form* out of the repository; only the
`*.tiles.json` / `*.chars.json` manifests are tracked (`.gitignore:14`, `:26`).

So `import.meta.glob('../assets/tileset/*.png')` in `floor/tileset.ts` and its
twin in `floor/characters.ts` are **populated on a machine that bought the pack
and empty on every CI runner, every fresh clone and every `git worktree` —
permanently, and by design.** With them empty, `tileset.layers` and
`characters.urls` are empty, the two loader loops in `FloorCanvas` iterate zero
times, and `loadOne` is never called.

Measured here by moving the pack aside and putting it back:

| terraces | lines | branches | functions | statements |
|---|---|---|---|---|
| with the pack | 76.13 | 72.48 | 84.65 | 76.17 |
| without it | 75.13 | 71.69 | 84.16 | 75.30 |
| difference | 10 lines | 6 branches | 1 function | 10 statements |

Those four "without" figures are exactly what the linux record held and exactly
what the worktree measured three times. The two observers agreed **because they
shared an undeclared condition**, not because they were independent. The
remaining ~1 line was genuine jitter, from a floating `Promise.all` in
`FloorCanvas`'s mount that no test awaited.

`productionFiles` (`scripts/check-coverage.cjs`) matches `src/**/*.{ts,tsx}` and
`shims/**/*.mjs` only, so `treeHash` is structurally blind to a PNG. Both
checkouts stamped `tree: c08617b1335b` while measuring different subjects.

### Every figure in the record, accounted for

Two sessions each found one cause and each reached for a single explanation.
There are **two independent binary conditions**, and every number the record has
ever held is one of their four combinations:

| condition | what runs | worth |
|---|---|---|
| **A** — the art pack is present | `loadOne` is called at all | +1 function, +10 lines |
| **B** — the bring-up has settled | `loadOne`'s `.catch` arm | +1 function, +1 line |

Against the pre-change denominators (202 functions, 997 lines):

| | neither | A only | A and B |
|---|---|---|---|
| functions | 170 = **84.16** | 171 = **84.65** | 172 = **85.15** |
| lines | 749 = **75.13** | 759 = **76.13** | 760 = **76.23** |

- **84.16 / 75.13** — a pack-free worktree, and CI linux.
- **84.65 / 76.13** — this checkout: pack present, bring-up not yet awaited.
- **85.15 / 76.23** — the `9b57f86` run that happened to get both, and the
  committed record it produced.

So the original n = 1 ratchet was not luck in a vague sense: it was the run in
which a *second* binary condition also happened to hold. Nothing is left over.

### One line cannot be covered under jsdom, and that is not a gap to chase

With the stub in place, `loadOne`, `loadSheets` and `loadCharacters` are all
entered — and reading `coverage-final.json` back, **exactly three lines in that
region stay uncovered, and all three for one reason**:

```
734   if (texture) loaded.set(name, texture)        // characters
742   if (texture) loaded.set(layer.sheet, texture) // sheets
751   return new Texture({ … })                     // loadOne's try-arm
```

jsdom rejects `image.decode()` on a real PNG exactly as it does on a missing
one, so `loadOne` always takes its `catch` and always returns `null` — *whether
or not* the pack is installed, and whether or not the globs are stubbed. The
`Texture` is never constructed, so neither `set` ever fires.

Recorded here so a future reader of `121/331` does not go hunting. These three
need a real image decoder, which is a different **environment**, not a different
test — the same boundary this file's docblock has named since M6 ("Pixi cannot
initialise under jsdom… that is deliberate rather than worked around"), one
layer down.

*(The session that built `onBringUp` identified line 751 from its own line data;
checking it here showed the same mechanism accounts for 734 and 742 as well.)*

### And the defect nobody was looking for

`loadOne`, both loader loops and the sheet-error arm have **never once run in
CI.** They were exercised on exactly one machine on earth. Under the seam rule
(ENGINEERING-STANDARDS §6.7) that is a defect on its own, and it would have
survived every correct floor decision above.

## What changed

| File | Change |
|---|---|
| `test/renderer/floor-glob-modules.test.tsx` | New. Enters the two glob modules the stub displaces, asserting only what is pack-independent. |
| `test/renderer/floor-canvas.test.tsx` | Stubs both glob modules, calling the REAL resolvers over fixed inputs. The loader loops now run a fixed count everywhere — and the art path runs in CI for the first time. |
| `src/renderer/src/floor/FloorCanvas.tsx` | `onBringUp` hands out a handle on the mount's bring-up so a test can await it instead of guessing how deep the chain is. *(Taken from `35b31b1`.)* |
| `scripts/check-coverage.cjs` | The corroboration window *(taken from `545ffc0`)*, plus: the subsystem map is compared by **membership** rather than by its set of names, and the false `MAX_WINDOW_RUNS` restart comment is corrected to say the window slides. |
| `test/scripts/check-coverage.test.ts` | Their 47 cases, plus BYPASS 10 (a window recorded under a different map is refused) and its positive control. |
| `scripts/coverage-floors.json` | Schema 2 → 3 with `corroboratingRuns: 3`. **Floors NOT lowered.** `corroboratingRunsReason` rewritten — the original blamed the promise race for a spread that was mostly the art pack. |
| `docs/gymnasium/proposals/GYM-007-…md`, `LEDGER.md`, `GYM-006-…md` | The ledger entry §3 requires; GYM-006's outcome filled and its metric #2 amended. |

## Implementation approach

### Remove the variable rather than record it

Two options were weighed. Recording art-pack presence as a condition key is
honest about reality, but it institutionalises two win32 conditions, doubles the
floors to maintain, and leaves the art path untested in CI forever. Stubbing
removes the variable outright and covers the path. The Architect chose stubbing.

The stub calls `resolveTileset` / `resolveCharacters` — the **real** resolvers —
over fixed glob records, rather than hand-building a `TilesetState`. This is the
M8.4 lesson applied one package later: a literal state object is *our idea* of
the shape and drifts from the schema the moment the schema moves. What the
component receives is what the real resolution rules produce for an installed
pack.

### Compare the subsystem map by membership

`foldCandidate` compared `Object.keys(...).sort()` — the set of subsystem
**names**. Moving `src/renderer/src/floor/` from `terraces` to `panels` leaves
both names standing and changes what every figure under them means, and a
minimum taken across that move is a minimum across two different subjects. It
now compares a hash of every name **and its members**, built with
`JSON.stringify` so no member string can forge a delimiter.

### The gate caught the fix

The first stub used `vi.mock` on `floor/tileset.ts` and `floor/characters.ts`,
which meant nothing executed them any more. The coverage gate refused the branch
and named them:

```
src/renderer/src/floor/characters.ts  no test enters this production module
src/renderer/src/floor/tileset.ts     no test enters this production module
```

Worth recording rather than quietly fixing: the seam rule caught a fix for one
defect creating another, in the same subsystem, within an hour. The stub is
right — those two modules are exactly the build-dependent halves a test cannot
otherwise pin — so the answer was to give them their own file
(`test/renderer/floor-glob-modules.test.tsx`) asserting only what is
pack-independent: that the glob is read, the resolver is called, and a state
comes back carrying the `note` invariant §7 requires. The values differ by
machine; the contract does not, and asserting the values would have put the pack
back into the gate through a different door.

## Design decisions

**The corroboration guard was kept, not rewritten.** It is the right fix for
defect 1 and its 47 cases are sound. Only its calibration was wrong.

**The floors were not lowered.** Lowering to the worst observed condition makes
the gate weaker for everyone: the branch's own floors sat exactly 10 lines below
what a with-pack machine reproduces, so `loadOne` and both loops could have
stopped being covered altogether and the win32 gate would still have said
`coverage floors ok`. It also re-arms the trap in reverse — three `--update`
runs on a with-pack machine would raise it back, and the next pack-free run
would hard-fail at −1.00 against a 0.25 tolerance.

**Floors are left unratcheted for now.** The stub *raises* coverage, so every
floor is now conservative rather than wrong, and raising it takes three
corroborating runs — which is the process working, not a gap. `ratchetLag` is 5
points, so nothing goes stale meanwhile.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
```

**The claim this change exists for**, run both ways on this machine:

| | FloorCanvas lines | functions |
|---|---|---|
| art pack installed | 121/331 | 29/48 |
| art pack moved aside | **121/331** | **29/48** |

Identical. The pack no longer affects coverage, and the loader path runs in both
states. *(The assets were backed up, moved, measured and restored — 4 tileset
and 12 character PNGs, verified back in place.)*

Mutation evidence on the new guard: both mutations killed —

- remove the map check entirely → BYPASS 10 fails;
- compare by name-set again (the original bug) → BYPASS 10 fails.

### A residual, measured and not theorised

Across win32-with-pack and linux CI (permanently pack-free), on this branch:

| terraces | win32, pack present | linux CI, pack-free |
|---|---|---|
| lines | 76.39 | **76.39** |
| functions | 85.22 | **85.22** |
| statements | 76.40 | **76.40** |
| branches | 72.91 | 72.64 |

`FloorCanvas.tsx` itself reads **36.56% (121/331) in both**, which is the claim
this change was made for. Three metrics of four now agree to the hundredth.

**Branches still differ by 0.27 — roughly two branches — and the cause is not
isolated.** The likely path is `floor-glob-modules.test.tsx` itself: it enters
the two glob modules for real, which means `resolveTileset` /
`resolveCharacters` take their installed arm on a machine with the pack and
their not-installed arm without it. Those resolvers are separately and
exhaustively tested from fixtures in `test/renderer/tileset.test.ts` and
`characters-intake.test.ts`, so the union should already be covered; it is not
yet established which branches remain.

Consequence, stated so nobody walks into it: **do not ratchet `terraces.branches`
from win32.** A win32 ratchet to 72.91 would leave linux reading 72.64 — a 0.27
regression past a 0.25 tolerance, which is the trap of this whole episode
reproduced in miniature. Both platforms currently pass with headroom against the
unchanged 72.61 floor, so nothing is failing; this is a note about the next
ratchet, not a defect today. Tracked as the open half of GYM-007's metric 1.

## Related docs

- `docs/gymnasium/proposals/GYM-007-a-floor-names-every-input-that-moves-it.md`
- `docs/gymnasium/proposals/GYM-006-coverage-floors-and-the-seam-rule.md` — metric #2, amended
- `docs/ENGINEERING-STANDARDS.md` §3 (process changes go through the Gymnasium), §6.7, §6.8
- `src/renderer/src/assets/ATTRIBUTION.md` — why the pack is gitignored
