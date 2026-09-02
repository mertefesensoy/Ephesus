# The committed evidence artifact that rewrote itself on every test run

## Problem / motivation

`test/scenarios/m7-evidence.test.ts` is M7.7's **committed generator**: the
artifacts under `docs/demo/` are produced by a test rather than a scratch script,
so `npm test` reproduces them and a change that breaks the SRS §6.1 chain breaks
the suite. That design is deliberate and correct — it closed a gap M6's close-out
recorded, where the `docs/demo/*.svg` generator was a scratch file and the
artifacts were honest but unreproducible.

It had one flaw. The transcript printed two identifiers that a re-run cannot
reproduce:

```
[2] incident raised: owner/app#ci-run:4021 → mail 2026-09-01T18-07-22-353Z-inc33p
[4] Artemis proposed; task t-2026-09-01-7b72440 assigned to agent.mason
```

Neither is a defect upstream. `IncidentEndpoint.send` stamps the mail id from the
wall clock, and `LedgerEndpoint.mintId` puts three random bytes in a task id **on
purpose** — its own comment explains that a counter would let two proposals in
flight mint the same id, and that a counter read from the ledger is a
read-modify-write nobody holds a lock on.

The consequence was that running the suite dirtied a tracked file with a diff
that said nothing. This is worse than untidy:

- It appeared on branches that never touched Harbor. It was found as an
  unexplained `M docs/demo/m7-onehour-chain.txt` in a checkout doing unrelated
  profile work.
- It made a real regeneration indistinguishable from clock noise. The signal the
  committed-generator design exists to give — "the chain changed" — was buried in
  a diff that fired every single run.
- A dirty tracked file invites `git checkout --` or a reflexive `git add -A`,
  either of which can take unrelated work with it.

## What changed

| File | Change |
|---|---|
| `test/scenarios/m7-evidence.test.ts` | Checks each volatile id against its documented shape, then renders a stable placeholder; adds a guard that fails if any volatile id reaches the body; moves the file write after all assertions. |
| `docs/demo/m7-onehour-chain.txt` | Regenerated. Two normalised ids, plus four header lines stating the convention. |

No production source changed. No shared test rig changed.

## Implementation approach

### Finding every volatile field, rather than the two that were noticed

The two ids above were visible in one diff, but "the two I happened to see" is
not an inventory. The generator was run twice and the outputs byte-compared:

```
18c18  ... → mail 2026-09-01T18-07-15-231Z-inc33p   vs   ...T18-07-22-353Z-inc33p
21c21  ... task t-2026-09-01-a7b9130                vs   ... task t-2026-09-01-7b72440
```

Exactly two, and `docs/demo/m7-eplaybook-scorecard.md` — the other artifact this
same test writes — was already byte-identical across runs. Step 8's briefing
references are `log#N` positional indices, which are stable.

### Check the shape, then render it stably

```ts
const MAIL_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-inc33p$/
const TASK_ID = /^t-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}[0-9a-z]$/

expect(raised[0]?.msgId ?? '').toMatch(MAIL_ID)
step('2', `incident raised: ${raised[0]?.incident.key ?? '?'} → mail <stamped>-inc33p`)
```

This is **stronger than what it replaces**, which is the point worth stating: the
old line printed the id and nothing verified it, so a malformed id would have been
transcribed into the evidence file without comment. Now it must match its
documented shape or the test fails. What is lost is six random hex digits that
appear exactly once each and are cross-referenced nowhere in the file — verified
by grep before deciding, not assumed.

The `-inc33p` slug is deliberately kept in the rendered form and in the regex: it
is *derived* (`inc${incident.ref.toString(36)}`, from run 4021), so it carries
information and is reproducible. Only the clock-stamped half is masked.

### A guard, so this cannot come back quietly

```ts
expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/)
expect(body).not.toMatch(/t-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}/)
```

A future step that prints a fresh id now fails in the test that owns the reason,
rather than surfacing weeks later as a phantom diff in an unrelated branch —
which is exactly how this was found.

### Write last

The assertions used to run *after* `writeFileSync`, so a run that failed its own
evidence checks still overwrote the committed artifact with the output it had
just rejected. The write now happens after every check, so a failing run leaves
the last good artifact standing.

## Design decisions

**Rejected: pin the clocks and seed the randomness.** `IncidentEndpoint` and
`LedgerEndpoint` both already accept an injectable `now()`, so the timestamps
could have been pinned. But the task id's three random bytes have no seam, and
adding one would mean changing production code — or the shared `startCompany`
rig used by every scenario suite — for the benefit of a docs artifact. The blast
radius is far larger than the problem, and `mintId`'s randomness is a documented
correctness decision, not an oversight.

**Rejected: stop committing the artifact / write it to a scratch path.** This
would delete the M7.7 property on purpose. The artifact is committed *so that* a
reader of the repository can see the chain without running anything, and so that
a broken chain shows up as a reviewable diff.

**Rejected: write only when the content differs.** The content genuinely differed
on every run, so this fixes nothing. It would also hide real changes behind a
comparison whose rules nobody could see.

**Rejected: `.gitignore` the file.** Same as deleting the evidence, with an extra
step that makes the loss invisible.

## Verification

```bash
npx vitest run test/scenarios/m7-evidence.test.ts
```

Run three times in succession, the artifact is byte-identical
(`md5 46c1a8c1a911ad74b073eb8c05788248` each time), and `git status` is clean
after the first commit of the regenerated file.

### MUTATION-CHECK

Two mutations applied, two killed — each by the guard written for it, tested in
isolation after a clean restore between them:

| Mutation | Result |
|---|---|
| Restore the raw wall-clock mail id in step 2 | **Killed** — `expected … not to match /\d{4}-\d{2}-\d{2}T\d{2}-…/` |
| Restore the raw random task id in step 4 | **Killed** — `expected … not to match /t-\d{4}-\d{2}-\d{2}-[0-9a-f]{6}/` |

The write-ordering change was verified the same way: during the failing run the
artifact on disk was diffed against the last good output and was **unchanged**,
confirming a rejected body is never written.

### Gate

`npm run typecheck` · `npm run lint` · `node scripts/check-invariants.cjs` ·
`npx vitest run test/scenarios/m7-evidence.test.ts test/scenarios/s-onehour.test.ts`
— all green (7 tests).

## Related docs

- `docs/implementations/2026-09-01-m7-7-suites-and-exit.md` — introduced the
  committed generator and the two artifacts.
- `docs/implementations/2026-09-01-flaky-temp-dir-teardown.md` — the other
  test-hygiene defect found in the same week; both are cases of a suite leaving
  state behind it.
- `docs/PROGRESS.md` §M7.7 — where the transcript is cited as evidence.
