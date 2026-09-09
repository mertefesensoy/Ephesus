# A ref resolves from the home a reader has

**Date:** 2026-09-09 · **Milestone:** M8b.3 — *the briefing can be read* ·
**Branch:** `fix/m8b-3-refs-resolve` from `origin/main` `9a4560b`

---

## 1. Problem / motivation

Finding 13 of [the M8 exit run](../demo/m8-onehour-aftershock.md), **which is wrong on
its central claim** — and correcting it is half of this package.

The finding reported, at high severity, that the run's one brief *"was archived
pointing at a file that was never written"*. Its evidence:

```
$ ls $EPH_HOME/odeon/briefs/2026-09-09T06-08-00-374Z.md
No such file or directory
$ ls $EPH_HOME            # there is no odeon/ directory at all
DIAGNOSIS.md  activations.json  agora/  authority.json  …
```

**The file was written.** It is at
`$EPH_HOME/agora/odeon/briefs/2026-09-09T06-08-00-374Z.md` — 1,781 bytes, exactly the
name in the `briefRef` — and it was still there when this package went looking. The
listing quoted above contains `agora/`; the runner never looked inside it.

`fileBrief` writes under the **agora root** (`<home>/agora`) and records `briefRef`
relative to *that*. The archiving was also already atomic — the file is written before
the log row is appended, and a name that already exists is refused rather than
overwritten. So the filed acceptance ("archiving is atomic with writing") was satisfied
on the day it was written.

**What is actually wrong is still worth a package.** A reference whose root is stated
nowhere, in a field named `briefRef`, read by a person who has only the home. For a
field whose entire job is to be resolved, one the holder cannot resolve is broken in
the way that matters — and it cost a careful runner a high-severity finding and an hour
of the record's credibility.

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/odeon.ts` | **new** `AGORA_REL` and `homeRef(...)` — the root, stated once. Pure; no `node:path`. |
| `src/main/odeon.ts` | `briefRef`, and the ref the BRIEFS tab lists, go through `homeRef`. |
| `src/main/meeting.ts` | `minutesRef` likewise. |
| `src/main/org.ts` | `retroRef` likewise. |
| `src/main/index.ts` | The Agora is rooted at `path.join(home.root, AGORA_REL)` — the same constant, so the directory and the promised prefix cannot drift. |
| `docs/demo/m8-onehour-aftershock.md` | Finding 13 corrected **in place**, above the original, which is left standing. |
| `test/main/briefing.test.ts` | 3 cases — the returned ref, the LOG row's ref, the listed refs; and the negative: it must *not* resolve from the agora root. |
| `test/main/meeting.test.ts` | 2 cases — a closed and an adjourned meeting's minutes both open from the home. |
| `test/main/org.test.ts` | The retro assertion now joins to the home; **it used to join to the agora root**, which is the assumption this package changes. |

**Deck refs deliberately do not change.** The ledger stores a `deckRef` and reads it
back, so its shape is data other code depends on rather than a pointer for a human.
`briefRef`, `minutesRef` and `retroRef` are all write-only — nothing in `src/` reads
any of them.

`retroRef` was not named in the Architect's decision, which cited `briefRef` and
`minutesRef`. It is included because it is identical in kind — same directory, same
write-only shape, same log row — and leaving it would knowingly re-arm the same trap on
a third artifact. Flagged here so the one place this went beyond the decision is
visible rather than buried.

---

## 3. Implementation approach

One exported helper, and the root stated once:

```ts
export const AGORA_REL = 'agora'
export function homeRef(...segments: readonly string[]): string {
  return [AGORA_REL, ...segments].join('/')
}
```

Three archives used to build their refs by hand with `path.posix.join('odeon', …)`.
They now share `homeRef`, and `index.ts` roots the Agora at the same constant — so
"where the Agora is" and "what the book of record promises" are one fact rather than
two copies that agree until one is edited.

Pure and in `src/shared` because the renderer reaches these types and may not import
`node:path` (invariant §2); the join is plain string work.

### Why the home rather than the agora

These refs go into `log.jsonl` and are read by **people**. A reader has the home: it is
what `EPH_HOME` names, what `ephctl` reports, what they `ls`. They do not necessarily
know `odeon/` sits inside `agora/`, and nothing in the row says so. The run is the
evidence that this is not hypothetical.

---

## 4. Mathematical / statistical details

Not applicable — this package changes a path prefix and a directory-resolution
convention. No formula, statistical test or numeric algorithm is involved.

The one property worth stating precisely is the resolution contract, which the tests
assert in both directions:

- for every archived artifact, `join(EPH_HOME, ref)` **exists**;
- for every archived artifact, `join(agoraRoot, ref)` **does not**.

The negative half is not decoration. Without it, a regression dropping the `agora/`
prefix would still pass every positive assertion on any fixture whose agora root
happened to coincide with its home — which is precisely the confusion that produced
Finding 13.

---

## 5. Design decisions

**Correct the record in place; do not edit the finding away.** The original Finding 13
stands with a correction block above it. A record of a run is worth more when it shows
where the runner got it wrong — the same reasoning §4a of that record already applies
to its own correction of Finding 6.

**Change the value, not the reader.** The alternative was to leave the refs
agora-relative and teach every reader where they resolve — cheaper, no schema churn,
and consistent with the sibling `deckRef`. It was rejected because the convention stays
invisible at exactly the moment somebody needs it, and the next reader who has not read
the doc repeats the runner's mistake.

**Rows already written keep the old shape.** `log.jsonl` is append-only (invariant §5),
so a reader of history meets the ambiguity once. Stated rather than hidden; the
alternative — rewriting the book of record — is forbidden and would be worse.

---

## 6. Verification

### Definition of Done

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs
```

### Mutation — 6 of 6 real mutants killed, baseline green, control survived

| Mutant | What it breaks | |
|---|---|---|
| P1 | the ref loses its root — the 2026-09-09 state exactly | killed |
| P2 | the root names a directory that does not exist | killed |
| P4 | `fileBrief` goes back to an agora-relative ref | killed |
| P5 | the BRIEFS tab's list drifts from the ref `fileBrief` returned | killed |
| P6 | `minutesRef` goes back to an agora-relative ref | killed *(after its own test; it SURVIVED before)* |
| P7 | `retroRef` goes back to an agora-relative ref | killed |
| **P8** | **CONTROL — changes nothing** | **SURVIVED, as it must** |

### The round the control caught, and the guard that was missing

An earlier round reported **7/7 with the control killed**. The cause was not the
harness this time: `test/main/org.test.ts` was **already failing on the clean tree**,
because its assertion resolved the retro ref against the agora root — the very
assumption this package changes. With a red baseline, *every* mutant looks killed.

The harness now runs the suite once **before any mutant** and aborts if it is not
green. That is the general fix for both this and the earlier RAM case: the harness was
reading "non-zero exit" as "the mutant did it".

That failing test is also the best evidence the change is load-bearing — the only
place in the tree that actually *resolved* one of these refs, and it broke.

### Adversarial refutation

- **Who else consumes these refs?** Nothing in `src/` reads `briefRef`, `minutesRef` or
  `retroRef` back. The renderer uses `.ref` only as a React key. `odeon.read(ref)`
  takes a **deck** ref and resolves it by `basename`, so it is unaffected either way.
- **Can the prefix be true and the directory be elsewhere?** It could: `AGORA_REL` and
  `path.join(home.root, 'agora')` were two hand-written copies of one fact. `index.ts`
  now uses the constant, so they cannot disagree.
- **What a substring assertion misses.** The pre-existing checks were
  `toContain('odeon/briefs/')`, true of both shapes — which is exactly why P6 survived
  the first valid round. The new tests **join and open the file**.

### What this does NOT prove

That §5.4 passes. A brief that resolves is necessary and not sufficient: the clause
asks whether the narration describes what actually happened, which only a live run
against a real repository can answer.

---

## 7. Related docs

- [The M8 exit run](../demo/m8-onehour-aftershock.md) — Finding 13, corrected in place.
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8b.3's acceptance criteria.
- [ADR-0008](../adr/ADR-0008-odeon-accountability.md) — the Odeon archive and what it owns.
- [`docs/EXIT-M8.md`](../EXIT-M8.md) §5.4 — the clause this serves.
