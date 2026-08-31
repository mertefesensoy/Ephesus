# 2026-08-31 — M7.3: the Harbor's GitHub ingestion

## Problem / Motivation

The Harbor is the port — everything in and out. M7.3 builds its *inbound* half:
FR-10.1's "ingest issues, PRs, and CI runs for registered repos; act via the
`gh` CLI under the agent's own auth", and FR-10.3's "every remote-originated
directive SHALL be tagged `remote` in the event log".

Without it the two outward missions have nothing to be outward about: the
Skeleton Crew's CI babysitter (FR-9.2) has no CI runs to watch and the Front
Office's triage (FR-9.3) has no issues to triage.

The package's risk line names the failure precisely: **ingestion that invents a
task the API did not report is the E-BRIEF-FAITH failure wearing a Harbor hat.**
It is the same defect at two ends of the building — a queue listing an issue
nobody opened and a briefing narrating a bug nobody filed.

## What Changed

| File | Change |
|---|---|
| `src/shared/harbor.ts` | **New.** `InboundItem`; `parseIssues` / `parsePulls` / `parseRuns` over `gh --json` output; `remoteLogEntries` (FR-10.3 as a projection); `isCiFailure`; `RepoQueue` / `HarborView`. |
| `src/main/harbor/github.ts` | **New.** `GitHubHarbor`: version probe, per-repo ingestion, the `GhRunner` seam, visible degradation. `HARBOR_INGEST_EVERY_MS`. |
| `src/shared/ipc.ts` · `src/main/ipc.ts` · `src/preload/index.ts` | `harbor:repos` (SDD §5's `harbor: repos()`). |
| `src/main/index.ts` | Constructs the Harbor over the active profiles' repos; probes and ingests at boot; adds the `harbor-github` cadence. |
| `test/shared/harbor.test.ts` | **New.** 22 cases — the drop-and-count table, the null conclusion, total `remote` tagging. |
| `test/main/harbor-github.test.ts` | **New.** 19 cases over a scripted `gh`, including the S-SECRETS-pattern API-surface assertions. |

## Implementation Approach

### Never invent

Every row is validated. A row that fails is **dropped and counted** — never
repaired, defaulted, or half-read into the queue. An issue with no number has no
identity; one with no title would enter the queue as an empty line the Architect
cannot act on, which reads as a bug in the company rather than in the payload.

The dropped count travels **out with the items**, not into a log line. Reporting
"12 open issues" when 3 rows were unreadable is a false statement, so the number
that qualifies it cannot be left behind.

Row schemas are `.loose()`: every field *read* is declared, and anything `gh`
adds in a future release is ignored and never carried. Refusing an issue because
a new field appeared would make an upgrade look like an outage; reading it would
be inventing.

### A failure is never an empty queue

`RepoQueue.failure` is a field rather than an absence. A repository whose call
errored and one with genuinely nothing open must not look alike: the second is
fine, the first means the company is blind (invariant §7).

Three consequences:

- A failure part-way through fails the **whole repo**, not just that call. A
  board showing issues but silently no CI runs looks *clean* to the babysitter,
  which is worse than a named outage.
- A failed ingestion **keeps what the Harbor last knew** rather than replacing it
  with emptiness — turning a degradation into a false all-clear is exactly the
  bug shape.
- One repo's failure never costs the others their ingestion.

### The probe comes first

ADR-0009's subprocess discipline, as ADR-0016 already reuses it for MemPalace:
`gh --version` answers before anything is driven, and an unprobed or
unrecognised `gh` leaves the Harbor **unavailable, visibly**, short-circuiting
every later `ingest`. An unprobed Harbor producing empty queues would read as
"nothing to do".

### `remote` tagging as a projection

`remoteLogEntries(items)` is a pure function of what was ingested, so an item
that reached the queue without reaching the log would have to be one that
function never saw. FR-10.3's totality is structural rather than a call somebody
remembers to make.

### No token, anywhere

FR-10.1 says the company acts under `gh`'s own auth. So `GitHubHarbor` has no
token option, reads no environment variable, and its `GhRunner` seam takes args
and a timeout only — no env parameter for a credential to arrive through. The
absence is asserted by API surface the way the broker's write-only-ness is: the
suite reads the module's own `GitHubHarborOptions` block and fails if `token`,
`secret`, `auth` or `env` appears in it.

A Harbor that *accepted* a token would be a Harbor an imported profile (FR-10.4)
could hand one to.

## Mathematical / Statistical Details

None — this is parsing and process control. One threshold worth stating:
ingestion runs every 10 minutes (`HARBOR_INGEST_EVERY_MS`), bounded at 50 rows
per kind per repo. Ten minutes because `gh` is a network round-trip per repo per
kind and the Skeleton Crew's own triggers are what make a failure urgent; the
one-hour company test (SRS §6.1) has room for six passes.

## Design Decisions

Seven entries in `docs/DECISIONS-LOG.md` dated 2026-08-31 (M7.3). The two most
load-bearing: **no token field exists** (above), and **registered repos come from
the active profiles' `harbor.json`**, not a second Harbor registry that could
disagree with the bundle the Architect approved.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/shared/harbor.test.ts test/main/harbor-github.test.ts
```

41 new cases. Full suite **2530 passed / 6 skipped**; failures unchanged — the
recorded 9 Windows-local deterministic ones plus `s-stoploop` (2) and `hermes`
(1) under parallel load, both green in isolation and neither related.

### Production call path

- `src/main/index.ts:1465` — constructs `GitHubHarbor`; its registered repos are
  the **active profiles'** `harbor.json` entries (M7.1's schema, M7.2's
  instances).
- `src/main/index.ts:1478` — probes and ingests at boot.
- `src/main/index.ts:1480-1490` — the `harbor-github` cadence, `enabled` only
  while some profile actually watches a repo.
- `src/main/ipc.ts:410` — registers `harbor:repos`.
- `src/preload/index.ts:138` — exposes it.
- **Renderer: no caller yet.** No Harbor panel is built. Recorded, not hidden.

### Proved against the real `gh` and the real GitHub API

The parsers were written against an *assumption* about `gh --json`'s shapes, and
a fixture would have re-tested the assumption rather than the API. So the built
app was run with the driver pointed at `mertefesensoy/Ephesus`:

- `gh 2.92.0`, `unavailable: null`
- **50 items, 0 dropped, `failure: null`**
- **50 `remote` log entries — one per item.** Tagging total (FR-10.3).

Zero rows needed repairing, so the schemas match what GitHub actually returns.
The repository has no open issues or PRs, and that read as `items: 50, failure:
null` rather than as a fault — the distinction `RepoQueue.failure` exists to
make. Incidentally, the two newest runs ingested were this session's own
`feature/m7-1-profile-schema` and `feature/m7-2-activation-autonomy` CI runs,
both `success`.

The temporary `EVIDENCE` block was removed before commit.

### Mutation-checked: 16 of 16 killed

Headed by the invention the risk line names — a malformed row **repaired** into
the queue as `#0 ""`. Also killed: dropped rows uncounted; a running CI job given
a `failure` conclusion; a non-array response read as "no rows"; the `remote`
projection skipping a kind or losing its tag; a cancelled run counted as a
failure; a draft PR reported ready; a `gh` failure yielding an empty queue with
no failure recorded; a failed repo forgetting what it last knew; ingestion
without a probe; an unrecognised `--version` accepted as available; one failing
repo aborting the others; calls unscoped from `--repo`; dropped rows raising no
degradation.

**One survivor found and closed.** Failing only the *first* `gh` call leaves
nothing in flight to leak, so nothing tested whether a *later* failure would
still log the items collected before it — half a repo tagged `remote` in the book
of record that the queue never showed.

## Related Docs

- `docs/srs/SRS.md` — FR-10.1, FR-10.3, UC-09, UC-10.
- `docs/sdd/SDD.md` — §1.1 (`harbor/github.ts`), §4.3 (`remote` kind), §5.
- `docs/implementations/2026-08-31-m7-1-profile-schema-loader.md` — `harbor.json`.
- `docs/implementations/2026-08-31-m7-2-activation-and-autonomy.md` — where the
  registered repos come from.
