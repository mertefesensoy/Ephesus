# M8.4 — The setup cliff

## Problem / motivation

Four files the harness requires, creates itself, and never mentions; one probe
it never ran; and a README that documented none of it. Each absence was silent,
and together they are why a stranger's first afternoon could not work.

- **`gate-policy.json` missing returned deny-all with `warning: null`.** Autonomy
  composes stricter-wins (ADR-0012), so that `manual` ceiling clamped every
  profile: the Skeleton Crew ships `autonomous` with its irreversible classes at
  `supervised` and ran at `manual` for everything, on every install that has ever
  existed. Each agent sat at a permission prompt nobody was there to answer,
  unattended running was impossible out of the box, and nothing anywhere said so.
- **`authority.json` has never existed**, so Artemis held no delegated authority
  at all and every routine decision queued for the Architect. FR-5.5 was not
  switched off; it was unreachable.
- **A missing `github-app.json` was silent** while the activation preview
  affirmatively promised `GH_TOKEN`.
- **Nothing probed engine AUTHENTICATION.** A logged-out CLI spawned, printed its
  own login prompt, sat there for the rest of the day, and reported `running`
  with a confidently idle avatar on the floor.
- **The README had no setup section** and a status two milestones stale.

## What changed

| File | Change |
|---|---|
| `src/shared/gates.ts` | `shippedGatePolicy` — the DD-1 ceiling, as a schema-validated value rather than a JSON literal that could drift. |
| `src/shared/authority.ts` | `shippedAuthority` — FR-5.5's own example, same treatment. |
| `src/main/home.ts` | Seeds both files when absent, never over an existing one, and reports which it created. |
| `src/main/watch/gates.ts` | A missing policy names its consequence instead of falling back in silence. |
| `src/shared/agents.ts` | The `needs-login` lifecycle and the card's `fixCommand`. |
| `src/main/engines/types.ts` | `authProbe` on the adapter surface, three-valued by contract. |
| `src/main/engines/claude.ts` | The reference adapter's probe: denial read first, positives that a denial cannot match. |
| `src/main/agents.ts` | Runs the probe after the version probe; a logged-out engine is not started. |
| `src/main/index.ts` | One grant resolver shared by the spawn and the preview; the real auth probe; seeded files reported. |
| `src/shared/profile-activation.ts`, `src/main/profiles.ts` | The plan carries `grantsUnavailable`, answered by that resolver. |
| `src/renderer/src/ProfilesPanel.tsx`, `AgentDock.tsx` | The screen says which grants cannot be supplied, and why an agent cannot work. |
| `README.md` | A setup section, and a status that is not two milestones old. |
| `docs/sdd/SDD.md` | The `home.ts` row. |

## Implementation approach

### A permissive ceiling is the safe choice, not the loose one (DD-1)

Autonomy composes stricter-wins, so a ceiling of `manual` does not make the
company careful — it makes every profile decorative. The shipped ceiling is
`autonomous` so a profile's declaration governs, with every irreversible class
held at `supervised` and `needs-human` at `manual`. "The Watch held every gated
action" stays true for every class that can hurt you; what changes is that
routine work is no longer stopped for a prompt nobody will answer. This is the
same reasoning the Architect applied on 2026-09-01 when the crew's `destructive`
and `prod-facing` classes moved to `supervised`: a posture that asks permission
for everything gets switched off wholesale rather than tuned.

`tool-permission` is deliberately absent from the shipped rules: `evaluateGate`
refuses that kind by construction, because it is the engine's own prompt and the
harness has no action to permit there.

### Shipped config is a value, not a JSON literal

The package's own risk line is "example configs that drift from the schemas they
illustrate". Both defaults are `schema.parse(...)` constants, so a drift is a
module-load failure rather than a file nobody validates, and `home.ts` writes
them out. Tests assert the round trip: what is seeded is what the real loader
reads back.

`~/.ephesus/` is the Architect's copy. A file is written only when absent and an
existing one is never touched, whatever it says — overwriting one would be the
harness silently reverting a decision they made. The files it did create are
reported through the M8.2 channel, because a config file that appears without
being mentioned is one nobody learns they can edit.

### The preview asks what the spawn asks

`declaredEnvGrants` returned what a profile declares and stopped there, so the
activation screen promised `GH_TOKEN` on an install with no `github-app.json`
and no such secret. The plan now carries `grantsUnavailable`, answered by the
*same* resolver the spawn path uses — one function, so the screen and the
outcome cannot disagree. A second opinion here would be a copy, and a copy
drifts. The parameter is required rather than optional: a default of "assume
they are all available" is exactly the silent assertion it exists to remove.

### An engine that is installed but logged out

The probe belongs to the adapter, because only the adapter knows what "logged
in" means for its own CLI (ADR-0009). It is **three-valued** by contract —
yes, no, or cannot-tell — and cannot-tell is trusted, not refused: reading "I
could not tell" as "logged out" would refuse to start a healthy company the
first time an engine rephrased its status line. That is `test/pin.ts`'s rule
applied in the other direction, and the manager honours it for a probe that is
absent, that throws, or that answers null.

The predicate reads the **denial first**, and its positive patterns demand
`logged in as` rather than `logged in`. `Not logged in` contains `logged in`,
so a bare substring test sends a company to work with no session — the same
trap that made `reproduce` match `prod` in the M7.4 scorer and made a spoken
refusal confirm a gate in M6. Both halves are load-bearing and both are tested:
order catches the wordings we know, and the pattern catches one we do not.

A logged-out engine is **not started**, so nothing can sit at a login prompt
while its card claims to be working, and the dock says why rather than "no
signal yet" — a process that never started has no phase to report, and "no
signal yet" reads as "any moment now".

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
npx vitest run test/main/setup-cliff.test.ts test/main/agents.test.ts test/main/engines/claude.test.ts
```

**Production call path** (ENGINEERING-STANDARDS §6.7): `ensureHarnessHome` seeds
and returns `seeded`, which `boot()` reports; `loadGatePolicy(gatePolicyPath)`
feeds both the `GateManager` and `ProfileActivations.globalAutonomy`;
`resolveDeclaredGrants` is passed to the `AgentManager` as `resolveGrants` and to
`ProfileActivations` as `missingGrants`; `AgentManager.spawn` calls `checkAuth`
between the version probe and `start`.

**Five mutations, each killed by a named test and reverted:**

| Mutation | Killed by |
|---|---|
| seeding overwrites the Architect's file | "never overwrites a file the Architect already has" |
| a missing policy is silent again | "names the consequence instead of falling back in silence" |
| the shipped ceiling clamps everything again | "lets a profile's own declaration govern, which is what B5 broke" |
| the substring trap returns | "does not read a negation this adapter has never seen as a session" |
| cannot-tell read as logged out | "TRUSTS a probe that cannot answer, rather than refusing to start" |

The substring mutation survived its first pass: the denial-first ordering caught
it, so the pattern itself was untested. The case that makes the pattern
load-bearing was added and the mutation then died — which is the refutation
habit paying for itself inside a single package.

## Related docs

- `docs/adr/ADR-0012-mission-profiles.md` — stricter-wins composition, which is why the ceiling matters
- `docs/adr/ADR-0009-engine-adapters.md` — engine specifics live in the adapter
- `docs/srs/SRS.md` FR-5.5 — the delegated authority the shipped table implements
- `README.md` — the setup section this package owed
