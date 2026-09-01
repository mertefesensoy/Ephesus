# 2026-08-31 — M7.1: the mission-profile schema and its loader

## Problem / Motivation

M7 builds the Harbor and the two outward missions. ADR-0012 decided that Skeleton
Crew and Front Office are not features but **configurations** — declarative,
versioned bundles of files — and staked a specific claim on it: the two built-ins
"exercise no private APIs, proving the format is sufficient" (the dogfood rule,
NFR-12). Everything in M7.4 and M7.5 rests on that claim, and the claim is only
checkable if the format exists first and refuses anything outside it.

The risk the package carries in its own plan line is that **the schema is a public
contract from the day it ships**. A field invented here is a field every future
migration has to carry; a field missing here is one a built-in will quietly reach
past, which falsifies ADR-0012's central claim without anything turning red.

M7.1 is the *load and validate* half of SDD §1.1's `profiles.ts`. Activation and
instantiation are M7.2's, and the split is load-bearing rather than tidy:
**loading is pure**, so the Architect can read what a profile may do before
anything acts on it — which is the safety story ADR-0012 chose profiles for.

## What Changed

| File | Change |
|---|---|
| `src/shared/profile.ts` | **New.** ADR-0012's bundle as zod schemas — `profile.json`, `triggers/*.json`, `memo-policy.json`, `harbor.json` — plus `parseProfile` (pure, every-reason-at-once) and the `migrateProfileDocument` ladder walk. |
| `src/shared/profile-view.ts` | **New.** Type-only projections (`ProfileSummary`, `ProfileLoad`) so `src/shared/ipc.ts` stays free of runtime dependencies (the sandboxed preload cannot `require` zod). |
| `src/shared/org.ts` | `hireTemplateSchema` gains an optional `budget`, which FR-9.1 and ADR-0012 both name and the shipped schema omitted. Additive; no `schemaVersion` bump (see below). |
| `src/main/profiles.ts` | **New.** `ProfileStore`: `list()` and `load(name)` over two roots, home shadowing builtin. Read-only, caches nothing, never throws. |
| `src/shared/ipc.ts` | `profiles:list` / `profiles:inspect` channel names and the typed `profiles` API group. |
| `src/main/ipc.ts` | The two handlers, payload-validated before they reach the store. |
| `src/preload/index.ts` | `window.eph.profiles`. |
| `src/main/index.ts` | Constructs the `ProfileStore` and binds it to the IPC deps — the production call path. |
| `test/shared/profile.test.ts` | **New.** 35 cases: the refusal table, the playbook-is-not-policy claim, purity, the migration walk. |
| `test/main/profiles.test.ts` | **New.** 12 cases over real temp directories: refusal by name, purity by census, home-shadows-builtin, listing invalid bundles. |
| `test/main/ipc-handlers.test.ts` | The rig now accepts a **real** `ProfileStore`; three cases walk the whole seam, channel to disk. |
| `test/scenarios/s-secrets.test.ts` | The API-surface rig gains the two new deps (its "exactly four `secrets:` channels" assertion is untouched and still passes). |

## Implementation Approach

### The bundle, transcribed

`profile.json` carries exactly what ADR-0012 lists — name, version, target
binding, autonomy levels — plus the `schemaVersion` the ADR requires and
ENGINEERING-STANDARDS §3 makes mandatory. There is deliberately **no**
description, title or icon: the activation UI's "what this profile MAY do" is
computed from the hires, grants, triggers and autonomy the bundle actually
carries, and a prose blurb beside those facts is a second place for the bundle to
describe itself — the one a reader would believe over the mechanism.

`hires/*.json` reuses the **shipped** `hireTemplateSchema` from M5.6 rather than
inventing a profile-local one. That schema had only test callers; M7.1 gives it
its first production caller. ADR-0012's word "skills" maps to the registry's own
field name `capabilities` (SDD §4.1) — one word for one concept beats a faithful
transcription that needs translating at every activation.

`playbooks/*.md` are carried as **text and nothing else**. `Playbook` has no
`sections`, `steps` or `severity` field, because once a playbook has
machine-readable parts a later package will read a policy out of one and the
bundle will have two places that say what is allowed. This is ADR-0012's
"playbooks are prose, policy is data" made structural rather than aspirational.

### Autonomy: levels, never rules

SDD §9 is exact — "profile autonomy levels can only *loosen* up to global maxima
— stricter wins" — so `profile.json` gets a `default` plus per-`GateKind`
overrides and nothing else. It cannot carry `gateRuleSchema`'s `channels`,
`maxSpendTokens` or `requireRepeatBack`: a bundle able to name its own approval
channels could grant itself *remote* approval of a destructive act, and since
profiles are shareable (FR-10.4) that field would eventually arrive from someone
else's file. `byKind` is `.strict()` over the six known kinds, so a typo'd
`"destructve": "manual"` is refused rather than silently falling through to a
laxer default.

The composition itself is M7.2's. `requestedAutonomy()` is named for what it
returns — a *request*, not an entitlement — so a caller cannot mistake it for the
answer.

### Refusal, not degradation

`parseProfile` returns either a whole bundle or **every** reason it was refused,
under the profile's name. Three properties, each a deliberate choice:

- **By name.** A refused profile still gets a row in `list()`, marked
  `valid: false`. One that vanished when its JSON broke would look uninstalled,
  and the Architect would go looking for a missing directory instead of a missing
  comma.
- **Every reason at once.** Whack-a-mole is the failure mode: an Architect fixing
  a bundle by hand should get one list, not one refusal per save. Same reasoning
  `parseWatchlist` gives.
- **Never a default.** A loader that supplied a missing `memo-policy.json` would
  make ADR-0012's "read it before you trust it" false in exactly the field that
  decides what is held for a memo.

Trigger bindings are resolved at load: a trigger naming a hire or a playbook the
bundle does not contain is refused, not dropped. SDD §7.5 makes the binding the
thing that turns an incident into a task, so a binding that resolves to nothing is
a watcher the Architect believes is on duty and is not.

### The migration ladder

ADR-0012 requires "a migration path from day one". At v1 there is no older
document to migrate, so a ladder with one fake entry would be a lie and a `// TODO`
comment would be untested machinery.

`migrateProfileDocument(raw, ladder, target)` takes its ladder and target version
as parameters. Production passes the empty `PROFILE_MIGRATIONS` and the current
version; a test walks a synthetic two-step ladder and asserts the steps ran in
order and stamped the version. The walk is total, and every refusal is named:

| Condition | Result |
|---|---|
| not an object | refused — nothing to migrate *from* |
| no integer `schemaVersion` ≥ 1 | refused, distinctly from a malformed file |
| version **>** target | refused — downgrading means dropping fields this build cannot see, which is data loss wearing compatibility's clothes |
| a gap in the ladder | refused, **naming the step** so the missing migration is something somebody can go and write |

### Two roots, and no seeding

`ProfileStore` reads `<harness home>/profiles/<name>/` first (SDD §2) and the app's
bundled `profiles/` second (ENGINEERING-STANDARDS §2). Unlike `PromptStore`, it
does **not** seed the home copy on read. Seeding is a write, and beyond the purity
requirement a silently seeded copy would shadow the built-in forever — so the next
Ephesus shipping a corrected Skeleton Crew would not be the one running. Copying a
built-in is the Architect's explicit act, and `list()` reports `source: "home"`
once it has happened.

## Mathematical / Statistical Details

None — this package is schema and I/O. The one ordering rule worth stating is the
migration walk's: for a document at version `v` and a target `t ≥ v`, the ladder is
applied as `step[v]`, `step[v+1]`, …, `step[t-1]`, each stamping `schemaVersion =
i + 1`, and any missing `step[i]` aborts the walk rather than skipping it.

## Design Decisions

Recorded in full in `docs/DECISIONS-LOG.md` (eight entries dated 2026-08-31). In
brief, with the alternatives that were rejected:

1. **Reuse `hireTemplateSchema`** vs. a profile-local hire schema. A second schema
   would have created two ways to say what a role is, and one registry row that
   could descend from either.
2. **Add an optional `budget` to `hireTemplateSchema`**, no version bump. FR-9.1
   lists "budgets" among what a profile declares and ADR-0012 spells the hire file
   out as "…env grants, budget"; the shipped schema had neither. The alternative —
   carrying budgets in `profile.json` — puts the number somewhere the org layer
   (UC-12) does not version. Additive, optional, and no hire-template file existed
   anywhere on disk, so every prior document still validates. Recorded explicitly
   rather than assumed, because "additive, so it is free" is how an unversioned
   schema change ships.
3. **Levels, not rules**, for profile autonomy (above).
4. **"Cron-like" means an interval.** `scheduler.ts` ships `Trigger.everyMs`; a
   cron parser is a new dependency — a BUILD-PROMPT §8.3 must-ask — bought for a
   precision nothing in the SRS asks for. Floored at one minute *in the schema*,
   where the number is written, not in the loop that would absorb it.
5. **`harbor.json` has nowhere to put a credential.** Channels and webhooks are
   schema'd as ids, names and event kinds only, and a webhook names the *event* it
   carries rather than an address — the endpoint is one the harness exposes
   (FR-10.2's inbound webhooks), so an outbound URL would be a profile telling the
   company where to send its data.
6. **Read-only loading, no seeding** (above).

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/shared/profile.test.ts test/main/profiles.test.ts test/main/ipc-handlers.test.ts
```

All green: 50 new cases (35 + 12 + 3 seam). Full suite **2453 passed / 6
skipped**. The failures are the recorded 9 Windows-local deterministic ones
(agent-worktree 4, s-crash 3, claude-transcripts 1, cost 1) plus `s-stoploop`,
which fails 1–2 cases under parallel load and passes 8/8 in isolation — so two
consecutive runs reported 10 failures and 11. Both numbers are given rather than
the kinder one.

### The production call path, stated

The M6 close-out audit's first standing lesson is that a green suite is not a
wired feature — M6 shipped 1 406 lines nothing could reach. So:

- `src/main/index.ts:580` — constructs the `ProfileStore` over `<home>/profiles`
  and the bundled `profiles/`.
- `src/main/index.ts:1631-1632` — binds it to `profilesList` / `profilesInspect`.
- `src/main/ipc.ts:409-413` — registers `profiles:list` and `profiles:inspect`.
- `src/preload/index.ts:138-142` — exposes them as `window.eph.profiles`.
- **Renderer: no caller yet.** The panel is M7.2's activation UI. Recorded here
  rather than left to be discovered.

### Proved by running the real app

`npm run build`, then `npx electron .` against a temp `EPH_HOME` holding one valid
bundle and one broken one:

- `profiles.list()` → `[{broken-crew, home, valid: false, version: null},
  {skeleton-crew, home, valid: true, version: 3}]` — the broken bundle **listed**,
  not hidden.
- `inspect("skeleton-crew")` → the whole bundle, including the hire's
  `budget: {dailyTokens: 500000}` and the playbook's text.
- `inspect("broken-crew")` → refused by name with *both* reasons:
  `memo-policy.json: missing from the bundle`, `harbor.json: missing from the
  bundle`.
- After the boot, the profiles tree was **byte-for-byte unchanged** — loading
  wrote nothing, so purity holds in the application and not only in the test rig.

The temporary `EVIDENCE` console log was removed before commit (BUILD-PROMPT
§10.7).

### Mutation-checked: 21 of 21 killed

The audit's third standing lesson is that an assertion which cannot fail is not
evidence. Every regression here was mutation-checked — break it, confirm red,
revert:

the refusal table · the name/directory match · `byKind`'s strictness · all four
migration refusals and the ladder walk · both trigger-binding checks · the
playbook-is-not-policy claim · the every-reason-at-once claim · the list's invalid
rows · home-shadows-builtin · the no-seeding claim · a missing required file ·
an illegal profile name · the empty-hires refusal · and three IPC-seam mutations
(the handler stops calling the store; the handler stops validating; the list
answers empty).

Two of the first draft's mutations — "memo policy degrades to a default" and "the
playbook is parsed as policy" — reported as SURVIVED and were **duds**: the first
filled a default but still pushed the reason, so the bundle was refused anyway;
the second added a dead field instead of reading the prose. Both were rewritten
until they genuinely changed behaviour, and both then died. Recorded because a dud
mutation proves nothing about the test and reports as a success.

## Related Docs

- `docs/adr/ADR-0012-mission-profiles.md` — normative for this package.
- `docs/srs/SRS.md` — FR-9.1, FR-9.4, FR-11.1.
- `docs/sdd/SDD.md` — §1.1 (`profiles.ts`), §2, §4.1, §5, §7.5, §9.
- `docs/PROGRESS.md` — the M7 plan and this package's evidence.
- `docs/DECISIONS-LOG.md` — the eight decisions above, in full.
