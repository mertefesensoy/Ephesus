# M8.3 / M8.4 defect clearance — and the rule that stops the class

## Problem / motivation

M8.3 and M8.4 both landed green: 3,410 tests, coverage floors held, three CI jobs
passing. An adversarial pass over the two packages — reading the production code
against what the real world does, then running 52 targeted mutations against the
suites that claim to guard it — found **two live defects and seven surviving
mutants**, all of them in the code those packages were written to add.

That is the standing lesson of this repository (M8.0, GYM-006, and the M8.0
close-out's own three bypasses) arriving again: *a check that cannot fail is the
recurring defect here.* So this change is not only the fixes; it makes one of
the two classes structural.

### D1 — the login probe could not read the engine it was written for

M8.4's `needs-login` lifecycle asks the CLI whether it has a session. The shipped
matcher looked for `logged in as`, `authenticated as` or `account:`.

Run on this machine, against the CLI actually installed (`@anthropic-ai/claude-code`
2.1.252):

```
$ claude auth status
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  ...
}
$ claude auth status --help
  --json  Output as JSON (default)
  --text  Output as human-readable text
$ claude auth status --text
Login method: Claude Max account
Organization: …
Email: …
```

The matcher matches **neither mode**. Every real invocation fell through to
`return null` — "cannot tell" — which the manager trusts. So `needs-login` could
not fire on any machine that has ever existed, `fixCommand` was never set, and
the dock's `engine not logged in` row was unreachable. The README told the
Architect that Ephesus asks this at every spawn.

Forty-five tests passed, because every one of them fed the matcher a string we
had written ourselves. This is the third instance of that exact shape:
`reproduce` matching `prod` in the M7.4 scorer, and a spoken refusal confirming a
gate in M6.

### D2 — the Activity panel's opening race could restore the bug it fixed

M8.3 changed the panel to open at the tail. Mounting starts a `logTail` read, and
`onAppend` can fire before it answers — the company does not stop working while a
window opens. The append handler then called `pull()` with `cursorRef.current`
still `0`, so a **forward page from the head of the book** raced the tail. If it
answered second, `absorb` appended the company's first 300 rows and rewound the
cursor to 300: register item B4, arriving through the back door, on the very code
path added to remove it.

Both legs are IPC round trips. Nothing ordered them, and nothing tested the order.

### The seven surviving mutants

| id | Mutation the suite did not catch | Where |
|---|---|---|
| F1 | `grantsUnavailable: missingGrants(…)` → `[]` — the whole "preview asks the spawn's resolver" deliverable | M8.4 |
| D1 | delete the dock's `notReady()` branch — every `needs-login` / `missing-binary` / `installing` row goes back to `no signal yet` | M8.4 |
| D2 | drop the fix command from the dock row | M8.4 |
| M3 | an adapter that declares *no* auth probe read as logged out | M8.4 |
| G4 | change the shipped 200 000-token spend ceiling to anything at all | M8.4 |
| A4 | `publish` walks the live listener set instead of a snapshot | M8.3 |
| L7 | a degradation reported once renders a redundant `×1` | M8.3 |

F1, D1 and D2 are the headline claims of M8.4: the activation screen's honest
promise about secrets, and the dock telling an Architect why an agent cannot
work. Gutting either passed every test in four files.

## What changed

| File | Change |
|---|---|
| `src/main/engines/claude.ts` | `loggedInField()` reads the CLI's machine-readable answer; the matcher reads it first, keeps prose as a fallback, and no longer treats a bare `auth login` (a usage line) as a denial. |
| `src/renderer/src/ActivityPanel.tsx` | `absorb` is monotonic and never rewinds the cursor; no forward page is issued before the tail read lands, and an append that arrives during it is collected afterwards rather than lost. |
| `scripts/check-invariants.cjs` | Rule 6: an engine adapter may not declare a probe with no recorded output. |
| `test/fixtures/engine-output/` | The captures, a `README.md` stating the rule, and `PROVENANCE.json` — command, engine version, platform, date, redactions, and what is *not* captured, with the reason. |
| `docs/ENGINEERING-STANDARDS.md` | §6.8, the Definition-of-Done clause the invariant enforces. |
| `docs/AUTOMATION.md` | Branch protection recorded as APPLIED, with a correction of the previous session's false "the API answers 404"; the new gate listed. |
| `test/main/engines/claude.test.ts` | The matcher run over the recorded bytes, plus the CLI's own denial wordings read out of the shipped binary. |
| `test/renderer/activity-panel.test.tsx` | Both orderings of the opening race, with a rig that can hold either read open. |
| `test/main/profile-activation.test.ts`, `test/shared/profile-activation.test.ts`, `test/renderer/profiles-panel.test.tsx` | The preview's grant question, at the seam and on the screen. |
| `test/renderer/agent-dock.test.tsx` | Every `notReady` row and its fix command. |
| `test/main/agents.test.ts` | An adapter with no probe declared (Codex) starts, and is never asked. |
| `test/main/setup-cliff.test.ts` | The shipped spend ceiling, asserted *through* `evaluateGate`. |
| `test/main/log-surfaces.test.ts`, `test/shared/log-row.test.ts` | The publish snapshot, and the `×1` suppression. |

## Implementation approach

### The document is the contract; the prose is the fallback

`claude auth status` answers JSON by default. The matcher now:

1. `JSON.parse` the stdout and return `loggedIn` **when it is a boolean**. A
   string `"false"` is not an answer this code will invent one from — that is
   the difference between reading the engine and guessing at it.
2. Failing that, prose: denials first (they are *substrings* of the positives —
   `Not logged in` contains `logged in`), then the positives, now including the
   `--text` mode's real `Login method:`.
3. Failing both, `null` — "cannot tell", which the manager trusts.

The direction of the conservatism is deliberate and unchanged: an unrecognised
wording must never be the reason a healthy company refuses to start. What changed
is that the *recognised* wordings are now the engine's, not ours.

### Monotonic absorption, and no page before the panel has opened

Two independent guarantees, because either alone leaves a hole:

- **`absorb` drops anything not newer than the cursor, and never moves the
  cursor backwards.** A late answer cannot rewind the panel or duplicate a row.
- **No forward page is issued until the tail has landed.** An append arriving
  first sets a flag; the tail's continuation then pages once from the new cursor,
  so nothing is lost and nothing is asked for at seq 0.

Mutating either one out fails a test.

### A fixture is a capture, or it is a lie

`test/fixtures/engine-output/` holds the CLI's real bytes. Identifying values —
the account email, the org id, the OS username — are replaced by **substring
substitution in the text**, never by re-serialising the document, so the CLI's own
keys, ordering, escaping and indentation survive intact. `PROVENANCE.json` names
every redaction, and a test asserts that no redacted field is one the matcher
reads: otherwise the fixture would be testing our redaction rather than the
engine.

The one case that cannot be captured — logged out — is recorded as *not
captured*, with the reason (it means signing the Architect out of their own
machine) and with the evidence that stands in its place: the logged-out document
is the captured one with its one boolean flipped, and the text-mode denials were
read out of the shipped binary (`Not logged in · Run /login`, `Not logged in ·
Please run /login`, `/^Not logged in$/`). Inventing a capture and presenting it as
one would be worse than having none, because the next reader would trust it.

### The rule, and refuting it before trusting it

`scripts/check-invariants.cjs` now scans `src/main/engines/*.ts` for adapters,
extracts each `readonly id`, and requires every declared `versionProbe` /
`authProbe` to appear in `PROVENANCE.json` — as a capture whose file exists and
whose command, version, platform and date are recorded, or as a written waiver
of at least a sentence.

Per the M8.0 close-out lesson, the gate was **attacked before it was believed**.
Six bypasses attempted, six caught:

| Attempt | Result |
|---|---|
| Delete the `authProbe` provenance entry | caught (`claude.ts declares authProbe with no recorded output`) |
| Point an entry at a file that does not exist | caught |
| Waive a probe with a one-word reason | caught |
| Delete `PROVENANCE.json` entirely | caught |
| Add a new adapter declaring a probe | caught (and by the reachability rule too) |
| Collapse the declaration onto one line to dodge a line-anchored regex | caught — the scan is not line-anchored, and skips comment lines so a doc comment about a probe does not demand a fixture |

Codex and Gemini are waived: their CLIs are not installed here and neither ships
in the MVP (ADR-0024). The waiver list *is* the visible debt — capture and delete
the entry before either adapter is offered to an Architect.

## Design decisions

**Read the JSON rather than asking for `--text`.** Passing `--text` explicitly
would let one wording carry everything, but it breaks on any version that
predates the flag (exit non-zero, empty stdout, "cannot tell" forever — the same
inert feature in a new costume). Reading the default and handling both shapes
degrades in the safe direction on every version.

**Waivers instead of exempting the check.** The alternative was to scope the rule
to "adapters that ship". That is a moving target decided elsewhere, and it would
have made the rule silently stop applying the day an adapter was promoted. A
waiver is a line of prose in a file reviewers read.

**`absorb`'s filter *and* the opened gate, not either alone.** With only the
gate, a future caller adding a second read path reintroduces the rewind; with
only the filter, appends arriving during the opening read are dropped until the
next one. Each is tested independently.

**A dock render test was dropped, not faked.** `AgentDock` fetches its own cards
over IPC and cannot be handed one, so a component render would have asserted
React rather than the projection. `dockRows` is the seam; the file records where
`row.status` reaches the DOM (`AgentDock.tsx:405`, and the row's `aria-label` at
`:379`) instead of pretending to cover it.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
```

Mutation evidence — the same 52 mutations, before and after:

| Set | Applied | Killed | Survived |
|---|---|---|---|
| M8.3 + M8.4 as merged | 40 | 33 | **7** |
| After this change | 40 | 40 | 0 |
| New code (panel race, matcher, `loggedInField`) | 12 | 12 | 0 |

The two defects, reproduced and then killed:

- `src/main/engines/claude.ts` — replace `loggedInField(stdout)` with `null`
  (i.e. the pre-fix matcher): `test/main/engines/claude.test.ts` fails on the
  recorded fixture.
- `src/renderer/src/ActivityPanel.tsx` — remove either the monotonic filter or
  the `opened` gate: `test/renderer/activity-panel.test.tsx` fails.

## Related docs

- `docs/ENGINEERING-STANDARDS.md` §6.7 (the seam rule), §6.8 (recorded engine output)
- `docs/AUTOMATION.md` — the gates, and branch protection as applied
- `docs/adr/ADR-0009` — adapters own engine specifics
- `docs/adr/ADR-0024` — claude-only for the MVP
- `docs/implementations/2026-09-04-m8-3-log-derived-surfaces.md`
- `docs/implementations/2026-09-04-m8-4-the-setup-cliff.md`
- `test/fixtures/engine-output/README.md`
