# The Claude transcript directory slug — a POSIX-shaped test hiding a real Windows bug

## Problem / motivation

`test/main/engines/claude-transcripts.test.ts` had one failing test,
"points at the engine's own project directory", red on the baseline for some
time (confirmed by restoring the working tree and re-running):

```ts
expect(dir.endsWith(path.join('.claude', 'projects', '-home-user-ephesus'))).toBe(true)
```

The obvious reading is that only the *test* is wrong: it feeds
`/home/user/ephesus` and expects the POSIX slug `-home-user-ephesus`, but
`path.resolve('/home/user/x')` on Windows yields `C:\home\user\x`, which slugs
with a leading `C-`, not `-`. That reading is correct as far as it goes — and it
is also a trap, because it explains the failure without explaining the code.

Checking `claudeTranscriptDir` against ground truth instead of against the test
showed the implementation was wrong too, in a way the test could never have
caught, because its single fixture contained no character that would expose it.

**The implementation matched 6 of 31 real transcript directories.**

This mattered beyond tidiness. `claudeTranscriptDir` feeds
`BudgetKeeper.foldOne` (`src/main/watch/budgets.ts:124`), which lists the
directory and folds each transcript into the token ledger. A directory that
does not exist yields no files, so no facts, so a spend of zero — while
`spendFor` is still handed the `'engine'` reporting tier, i.e. the UI presents
a confident zero rather than a visible degradation. That inverts the guarantee
in the surrounding comment ("so a zero can never be mistaken for *spent
nothing*") and is precisely the spend-under-reporting class ADR-0011 exists to
close. On this machine the repository path is
`C:\Users\senso\OneDrive\Masaüstü\ephesus`, so the bug was live, not
theoretical.

## What changed

| File | Change |
|---|---|
| `src/main/engines/claude.ts` | Widened the cwd slug from `replace(/[\\/.:]/g, '-')` to `replace(/[^a-zA-Z0-9]/g, '-')`, and replaced the "verified against a real transcript" comment with the actual rule, the corpus it was measured against, and why a wrong slug under-reports spend rather than erroring. |
| `test/main/engines/claude-transcripts.test.ts` | Made the golden per-platform instead of POSIX-only, and added a second test covering the characters the old rule let through. |

## Implementation approach

### Deriving the rule instead of guessing it

Every Claude Code transcript line carries the `cwd` it was written from, and
each transcript lives in the project directory named for that cwd. That makes
`~/.claude/projects` a self-labelling corpus: read the `cwd` out of a
directory's own transcripts, slug it with a candidate rule, and compare against
the directory's actual name.

A scratch Vitest file scored four candidate rules over 31 directories. It
imported the *real* exported function rather than a retyped copy of its regex —
the first attempt retyped it, a shell heredoc silently ate a backslash, and the
resulting "0/31" was an artefact of the harness, not a finding. Importing the
function removed that whole class of error.

| Rule | Matches |
|---|---|
| `[\\/.:]` → `-` (the shipped rule) | **6 / 31** |
| `[^a-zA-Z0-9]` → `-` | **30 / 31** |
| keep alphanumerics + `-` | 30 / 31 |
| keep alphanumerics + `-` + `_` | 30 / 31 |

The three passing candidates are indistinguishable on this corpus, because
mapping `-` to `-` is the identity and no sampled path contains `_`. The
narrowest safe choice is `[^a-zA-Z0-9]`, which is also the engine's documented
behaviour; the underscore case is called out as unattested in the code comment
rather than quietly asserted as verified.

Worked examples that separate the rules:

```
C:\Users\u\OneDrive\Masaüstü\ephesus       -> C--Users-u-OneDrive-Masa-st--ephesus
C:\Users\u\OneDrive\Masaüstü\IBM Z Project -> C--Users-u-OneDrive-Masa-st--IBM-Z-Project
/home/user/ephesus                         -> -home-user-ephesus
```

So the drive-letter colon, both separators, a dotdir's dot, the space, and the
non-ASCII `ü` all collapse to a dash, while `-`, digits and letter case
survive. The old rule handled the first three and left `ü` and the space
intact — `Masaüstü` stayed `Masaüstü` where the engine writes `Masa-st-`.

### The one non-matching sample, and why it is not a counterexample

The single 30/31 miss is a directory named for a repository root whose only
recorded `cwd` is a worktree *inside* that root:

```
cwd  C:\Users\senso\OneDrive\Masaüstü\asset-integrity\.claude\worktrees\nice-hamilton-6c8f98
dir  C--Users-senso-OneDrive-Masa-st--asset-integrity
```

Every candidate rule misses it identically, so it does not discriminate between
them. It is a question of *which* cwd names the project directory — the engine
appears to fix the directory at session start, and this session entered a
worktree afterwards — not of how a cwd is slugged. It is out of scope here: the
adapter is handed a cwd by the spawn config, and slugging that cwd is the
contract under test. (Other worktrees in the corpus, including the one this
work was done in, do have their own directories, so it is not a general
"worktrees collapse to the parent" rule.)

## Design decisions

- **Fix the implementation, not just the expectation.** The brief allowed
  either; the corpus decided it. Adjusting only the test would have made a
  6/31-correct function permanently green — the worst of the available
  outcomes, because it buys silence rather than correctness.
- **`[^a-zA-Z0-9]` over "separators plus the characters I saw fail."** Patching
  in `ü` and space would fix this machine and break the next one. A whitelist
  rule is closed under any input; a blacklist is only ever as good as the
  sample that produced it, which is exactly how the original bug arose.
- **Goldens copied, not computed.** The tempting fix — derive the expected slug
  by calling `path.resolve` and applying the implementation's own rule — was
  rejected: it passes for *any* rule, including the broken one, and would have
  kept this bug invisible while looking like a stronger test.
- **Left the worktree/cwd anomaly alone.** It is a real observation about engine
  behaviour but a different defect, and inventing a fix for it without evidence
  would repeat the original mistake in a new place.

## Verification

```bash
npx vitest run test/main/engines/claude-transcripts.test.ts
```

19 passed (was 18 passed / 1 failed).

Mutation check — restoring the old rule turns **both** new tests red, so they
are load-bearing rather than decorative:

```
× points at the engine's own project directory
× slugs every character the engine slugs, not just the separators
Tests  2 failed | 17 passed (19)
```

Gates: `npm run typecheck` green, `npm run lint` green (exit 0).

`npm test` shows 12 failures across 6 files. These are pre-existing and
unrelated to this change:

- Re-running the same files on a clean baseline (changes copied aside and
  `git checkout --`, not `git stash` — the stash stack is shared across
  worktrees) reproduces 8 of them: `agent-worktree` (4), `s-crash` (3),
  `cost` (1).
- The other 3 (`hermes` 1, `s-stoploop` 2) fail only under full-suite parallel
  load and pass in isolation both with and without this change (48/48). They
  cannot reach the changed code: neither file imports `src/main/engines/claude`,
  and `test/scenarios/company.ts` drives the fake-engine binary, not the Claude
  adapter. They are real-subprocess scenario tests and are timing-sensitive
  under load.

To re-derive the corpus finding, read the `cwd` field from any transcript under
`~/.claude/projects/<dir>/*.jsonl` and compare `path.basename(claudeTranscriptDir(cwd))`
with `<dir>`.

## Related docs

- `docs/adr/ADR-0009-engine-adapters.md` — the optional `transcripts` capability
- `docs/adr/ADR-0011-watch-breaker-budgets.md` — why under-reporting spend is the
  failure this guards against
- `docs/srs/SRS.md` — FR-11.2, engine-reported usage
- `docs/sdd/SDD.md` §11 — the budget fold path
