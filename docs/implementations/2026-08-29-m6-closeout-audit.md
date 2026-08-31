# M6 close-out audit — what three independent passes found, and what was fixed

**Date:** 2026-08-29 · **Branch:** `fix/m6-closeout-audit` (from
`feature/m6-8-suites-exit`, 9 M6 commits atop `main` at `e2eb397`) ·
**Verdict:** M6 art DONE; M6 Herald BUILT BUT NOT INTEGRATED; **milestone
reopened**.

## Problem / motivation

M6 was recorded complete on 2026-08-29 with the verdict *"DONE, with two live
proofs OWED"*, every package ticked and an exit review written. M0, M2, M3, M4,
M5 and M5b each closed with an independent close-out audit; M6 had not had one.
The Architect asked for that audit before M7 began.

The reason the project spends a milestone's worth of effort on these audits is
on the record: every one of them found something the building session had
believed and could not see. M5b's found an exit demo citing a commit that
existed in no repository. This one is no different in kind, only in size.

## What changed

| File | Change |
|---|---|
| `src/main/herald/policy.ts` | `repeatBackToken` carries the gate's whole subject; new `repeatBackChallenge` (nonce + 2-minute lapse); `checkRepeatBack` matches EXACTLY, takes the challenge and a spent-nonce set, and gains `expired`/`replayed` refusals. |
| `src/main/herald/narration.ts` | `voiceApprovalAsk` issues the challenge; `checkVoiceApproval` verifies the ISSUED challenge rather than re-deriving one, and refuses a repeat-back gate answered with no challenge. |
| `src/shared/tileset.ts` | `resolveTileset` now CALLS `validateCompositions` and appends its problems to the visible `note`. |
| `src/main/gymnasium.ts` | `slice()` emits `spendSource` — the key `BriefInput.gymSlice` actually reads. |
| `.gitattributes` | **New.** `* text=auto eol=lf`, binaries marked, hooks pinned to LF. |
| `docs/srs/SRS.md` | FR-8.4 amended: whole-subject token, exact match, single-use, lapsing. |
| `docs/design/VOICE-DESIGN.md` | §3 confirmation ladder amended to match. |
| `docs/PROGRESS.md` | M6 exit UNTICKED; M6.8 amended; the close-out audit recorded; M6.9 + M6.10 added; the M7/M7b plans written. Renormalized to LF. |
| `docs/IMPLEMENTATION.md` | M7 split into M7 + M7b; dependency graph updated. |
| `BUILD-PROMPT.md` | Build state rewritten for the handoff; build order gains M7b; §10 gains the two voice SDKs approved at M6.5. |
| `docs/DECISIONS-LOG.md` | Four entries for the four fixes. |
| `docs/implementations/2026-08-29-m6-floor-face-and-herald.md` | Stale counts and the false spend-source claim corrected in place. |
| 5 test files | 11 new cases, every one mutation-checked. |

## Implementation approach

### The audit itself — three passes, deliberately different

The two-agent pattern (verify-by-execution + design-conformance) is what M0–M5b
used. The Architect added a third: an **adversarial mutation pass**, run in an
isolated git worktree so it could freely break the code it was attacking.

That third pass is what turned this audit from ordinary into consequential. The
first two read code and ran suites; both are vulnerable to the same blind spot,
which is that *a passing suite looks identical whether or not it can fail.* The
mutation pass asks the only question that separates them: **break the thing, and
see if the test notices.** Twenty-two mutations; four caught; eighteen survived.

All three converged on a finding none had been asked to look for.

### The headline: `src/main/herald/` has no production caller

```
$ grep -rn "herald/" src/ --include=*.ts --include=*.tsx | grep -v "^src/main/herald/"
(no output)
```

Seven modules, 1 406 lines — the ADR-0007 seam, the policy, both provider
adapters, the session, the narration, the phrase book — imported **only by test
files.** No IPC channel, no preload surface, no construction in `index.ts`, no
status-strip chip, no barge-in caller.

The M6 record framed the missing live proofs as an access problem: no
`ELEVENLABS_API_KEY` in this environment. That framing is what the audit
overturned. A key would have changed nothing, because there is no path along
which one could reach an adapter. The distinction matters for planning: "unproven"
is closed by borrowing a key for an afternoon; "unwired" is a work package.

Consequently M6's three exit criteria in `docs/IMPLEMENTATION.md` stand at 0 of
3 met, with two of them ticked — and the third ("a full day driven by voice
without touching the keyboard") never mentioned in the exit review at all.
BUILD-PROMPT §5 forbids starting M7 in that state, so **M6 reopened** with M6.9
(wire it) and M6.10 (close the false guarantees).

### The safety defect — the one thing here that could have cost something real

FR-8.4's repeat-back is the safety behaviour ADR-0007 says the policy layer
exists to hold. Run against the shipped code at HEAD, before any mutation:

```
delete branch release/9        → "confirm delete branch release"
delete branch release/10       → "confirm delete branch release"     collide
raise the daily cap to $80     → "confirm raise the daily"
raise the daily cap to $8000   → "confirm raise the daily"           collide
checkRepeatBack("no, do not confirm delete branch release 9", …) → { confirmed: true }
```

Three defects in one function:

1. **The token kept the first three words** of the gate's subject. This reads as
   faithful to FR-8.4's own example — *"say confirm delete"* — and is exactly why
   it survived review. But it means gates differing only in their tail share a
   token, and, worse, that a **spend** gate's amount is absent from the words
   that approve it. Repeating back the token for an $80 raise approves $8000.
2. **Matching was by substring**, a deliberate courtesy so that "confirm delete
   branch, please" would pass. A refusal necessarily quotes the token it is
   refusing, so *"no, do not confirm delete branch release 9"* approved the
   deletion.
3. **No nonce, no expiry** — the same words approved the same gate indefinitely.

Fixed at the Architect's direction, put as a BUILD-PROMPT §8.3 must-ask with
three options (the strongest chosen):

- the token carries the normalized subject **entire**;
- the match is **exact** — `said === wanted` after normalization;
- `repeatBackChallenge` issues a **nonce** with a **two-minute lapse**, and
  `checkRepeatBack` takes the issued challenge plus the spent set, so an answer
  is single-use and a stale asking cannot be answered.

The API change is the substantive part: `checkVoiceApproval` used to re-derive
the ask internally, which meant it verified a *recomputed* token rather than the
*issued* one. Taking the challenge as a parameter is what makes replay
detectable at all, and it makes "no challenge was issued" a refusal rather than
a silent pass.

**Cost, stated honestly:** a trailing "please" now fails and costs a retry. That
is the correct side to err on for the only spoken act that cannot be undone.
FR-8.4 and VOICE-DESIGN §3 were amended *with* the change, not after it, and the
superseded wording is preserved in the clause so the next reader knows it moved.

### Two more fixes of the same family — a wired half beside an unwired half

**`validateCompositions` had only test callers.** Its own contract comment read
*"a bad composition degrades that station to the procedural painter and says so
(invariant §7)"*. The degrading half was real — `compositionFor` returns null.
The saying-so half was never wired, so a pack shipping a wrong-sized station lost
it in silence. `resolveTileset` now appends the problems to the visible note, and
the pack still installs: one wrong entry must not cost the whole pack.

**`Gymnasium.slice()` emitted `source`; `BriefInput.gymSlice` reads
`spendSource`.** Nothing set it, so the true branch in `brief.ts` was dead code
and M6.7's recorded claim that "the brief prints both" was false. Two properties
of this bug are worth keeping:

- **Object spread bypasses excess-property checking.** `{ ...gymnasium.slice(),
  open, mode }` type-checks against a target declaring `spendSource?` even though
  the spread supplies `source`. `typecheck` stayed green across two milestones.
- **Both halves had passing tests.** `carried-items.test.ts` asserted
  `attributeSpend(...).source`; `gymnasium.test.ts` asserted the producer;
  `brief.test.ts` asserted the consumer given a hand-written input. None ran the
  two together, and the scenario rig reproduced the same wrong shape, so even
  S-BRIEF could not catch it.

The regression now drives the **real** slice into the **real** compiler. That is
the only shape of test that could have caught it, and it is the M5b lesson
recurring: two correct halves that have never met are not a feature.

### The audit trail had quietly become unreviewable

`docs/PROGRESS.md` entered the index with CRLF endings at `5b9ff87` and stayed
that way for the rest of M6. The milestone's PROGRESS diff therefore read as
**6582 changed lines** where **248** had changed.

Nothing was actually wrong with the content — `git diff --ignore-all-space`
shows 239 insertions and 9 deletions, and the nine are precisely the `- [ ]`
boxes becoming `- [x]`. I checked, because that is the point: this is the
document a close-out audit reads *by diff*, and a 6582-line diff is where a
substantive edit to an earlier milestone's record would hide. It didn't happen
here. Next time it would not be visible.

`core.autocrlf` is per-machine and cannot be relied on, so the fix travels with
the repository: `.gitattributes` pinning LF, and the three CRLF-in-index files
(`docs/PROGRESS.md`, `docs/gymnasium/LEDGER.md`, `prompts/herald/phrasebook.md`)
renormalized.

## Design decisions

**Why reopen M6 rather than carry the wiring into M7.** Three options were put to
the Architect; reopening was chosen. The alternative — amend the record honestly,
merge, and make the wiring M7.0 — is defensible and faster, and it was rejected
because BUILD-PROMPT §5's rule ("never start N+1 while N's exit criteria fail")
is precisely the rule that stops a project accumulating milestones that are
declared done and are not. A rule that bends the first time it is expensive is
not a rule. The cost is a delayed M7 start; the benefit is that "M6 is done"
keeps meaning something.

**Why the mutation pass gets a standing place.** It found what two careful
readings did not, and its findings are of a kind that reading cannot produce: you
cannot tell by looking that `expect(reduceEnvelope(f).info).toEqual(envelopeInfo(f))`
is a tautology, because `reduceEnvelope` returning exactly `envelopeInfo(f)` is
an implementation detail one file away. Every close-out from here runs one.

**Why the superseded exit review is kept verbatim.** It is wrong in its framing
and it is not dishonest — it discloses carefully what it did not run. Deleting it
would remove the evidence of *how* a building session can be confident and
mistaken at the same time, which is the thing these audits exist to catch. It is
marked superseded and left in place.

**Why FR-8.4 was amended rather than the code bent to fit it.** The old clause's
example (`say confirm delete`) is what the implementation faithfully followed.
The clause was underspecified, not the code disobedient — so the honest repair is
to the clause. Amending the spec in the same change that alters the behaviour is
what keeps SRS > SDD meaningful.

## Verification

Every command below was run on `fix/m6-closeout-audit`.

```bash
npm run typecheck                  # exit 0, four projects
npm run lint                       # exit 0, zero warnings, prettier clean
node scripts/check-invariants.cjs  # invariants ok (src, shims, scripts, test)
node scripts/check-attribution.cjs # attribution ok
npm test                           # 2364 passed | 16 failed | 6 skipped (2386)
```

The 16 failures are the recorded Windows-local baseline, unchanged by this work:
**9 deterministic** (agent-worktree 4, s-crash 3, claude-transcripts 1, cost 1)
and **7 load flakes**, each verified passing in isolation:

```bash
npx vitest run test/main/library.test.ts        # 13 passed
npx vitest run test/scenarios/s-blackout.test.ts # 6 passed
npx vitest run test/scenarios/s-ledger.test.ts   # 13 passed
npx vitest run test/main/worktrees.test.ts       # 14 passed
npx vitest run test/scenarios/s-livelock.test.ts # 3 passed
npx vitest run test/scenarios/s-stoploop.test.ts # 8 passed
```

Collected rose 2375 → 2386: exactly the 11 cases added here. Ubuntu CI is the
gate and was green on all eight M6 branches, each run's `headSha` matching the
local head.

**Every fix is mutation-checked** — the regression fails when the defect returns:

| Fix | Mutation | Result |
|---|---|---|
| Exact match | `said === wanted` → `said.includes(wanted)` | 2 failed (the refusal cases) |
| Visible degradation | stop calling `validateCompositions` | 1 failed |
| `spendSource` seam | producer emits `source` again | 3 failed |

Reproduce the safety defect on the pre-fix tree:

```bash
git stash && git checkout feature/m6-8-suites-exit
# then, against src/main/herald/policy.ts:
#   repeatBackToken({kind:'spend', what:'raise the daily cap to $80'})   → "confirm raise the daily"
#   repeatBackToken({kind:'spend', what:'raise the daily cap to $8000'}) → "confirm raise the daily"
#   checkRepeatBack('no, do not confirm delete branch release 9', token) → { confirmed: true }
```

## Related docs

- `docs/PROGRESS.md` — the M6 close-out audit verdict, M6.9/M6.10, the M7/M7b plans
- `BUILD-PROMPT.md` §5 — build state and the next session's handoff
- `docs/srs/SRS.md` FR-8.4 · `docs/design/VOICE-DESIGN.md` §3 — the amended clauses
- `docs/adr/ADR-0007-herald-voice-seam.md` — the seam this audit cleared, and the barge-in it found unwired
- `docs/DECISIONS-LOG.md` — the four fix entries
- `docs/implementations/2026-08-29-m6-floor-face-and-herald.md` — the M6 build doc, corrected in place
