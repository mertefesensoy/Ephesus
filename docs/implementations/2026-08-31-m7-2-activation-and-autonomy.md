# 2026-08-31 — M7.2: activation, targets, and autonomy composition

## Problem / Motivation

M7.1 made a profile bundle a thing you can read and refuse. M7.2 is where reading
it starts to cost something: agents get spawned, secret grants get handed out,
triggers get armed, and the crew acquires a licence to act.

The package's own risk line names the failure mode exactly: *an autonomy level
that composes by "profile wins" is a silent privilege escalation — assert the
direction of composition, not merely its presence.* FR-11.1 and SDD §9 are
unambiguous — "profile autonomy levels can only *loosen* up to global maxima —
stricter wins" — but a system can compute that correctly and still never apply
it, which is what was actually true here.

**What we found on arrival:** `effectivePolicy` in `src/main/watch/gates.ts` and
`GateRequest.profileAutonomy` in `src/shared/gates.ts` both shipped at M3 and had
**no production caller at all**. The composition was correct arithmetic that
nothing could invoke — the M6 close-out finding, one subsystem over. This package
is the one that wires it.

## What Changed

| File | Change |
|---|---|
| `src/shared/profile-activation.ts` | **New.** `activationPlan` — the pure function that decides what activation would do; `composeAutonomyTable`; deterministic instance and agent ids; the target schema. |
| `src/main/profiles.ts` | **New class** `ProfileActivations`: activate (all-or-nothing), deactivate (triggers first), `instances()`, and `autonomyFor(agentId, kind)` — the Watch's seam. |
| `src/main/watch/gates.ts` | `GateManagerOptions.profileAutonomy` — the manager now **resolves** a profile's grant for every submission instead of trusting call sites to pass it. |
| `src/shared/profile-view.ts` | `ProfileInstanceView`, `ActivationResult`. |
| `src/shared/ipc.ts` · `src/main/ipc.ts` · `src/preload/index.ts` | Four channels: `profiles:preview|activate|deactivate|instances`. |
| `src/main/index.ts` | Constructs `ProfileActivations`; gives `GateManager` its `profileAutonomy` seam; binds the four deps. |
| `docs/sdd/SDD.md` | §5's `profiles:` block rewritten to name all six channels and the request shape (the M3.1 rule). |
| `test/shared/profile-activation.test.ts` | **New.** 16 cases — the composition table in both directions, id disjointness, the plan-as-disclosure. |
| `test/main/profile-activation.test.ts` | **New.** 22 cases over real bundles on disk, four of them a real `GateManager` wired to a real `ProfileActivations`. |

## Implementation Approach

### The plan is the disclosure

`activationPlan(bundle, target, globalAutonomy)` is pure and returns everything
activation would do: each hire's spawn request with its grants and budget, the
composed autonomy per gate class, the triggers, the repos, the memo classes, the
playbook names.

The activation screen reads it through `profiles:preview`; `activate` executes the
same object. That is deliberate. ADR-0012 chose declarative bundles so an
Architect can "read what this profile may do before activating"; if the preview
came from a second code path it would drift, and the one screen that exists to be
trusted would be the one thing nothing checks.

### Composition, and its direction

`composeAutonomyTable(global, profileAutonomy)` returns a row per `GateKind`
carrying `global`, `requested`, `effective`, and `clamped`. `effective` is
`composeAutonomy` — the lower rank, always. `clamped` is true when the profile
asked for more than the company allows and was cut back, and it is surfaced
rather than swallowed: a bundle that *asked* for `autonomous` on destructive
actions is a fact about that bundle worth showing the person about to trust it.

The table is total over `GATE_KINDS`. A kind the profile does not mention takes
its `default` — never a gap some later caller reads as "unrestricted".

### The seam that makes it real

The important design decision in this package is *where* composition is applied.
The obvious move is to pass `profileAutonomy` on each `gates.submit(...)` call.
We did the opposite: `GateManager` takes a `profileAutonomy(agentId, kind)`
lookup and applies it to **every** submission itself.

The reason is that forgetting the field is not fail-safe. A call site that omits
it gives the agent the *global* level — so an agent whose profile **tightened** a
class quietly gets the looser company default, which is an escalation relative to
the plan the Architect approved at activation. When both a caller and a profile
have an opinion, the stricter is taken; composition can only ever narrow.

### All or nothing

If a hire fails to spawn, the agents already up are killed and the instance is
refused. A partially activated crew is worse than none: the Architect approved a
plan containing an on-call agent and has no reason to think that agent is
missing. The refusal names the hire, the engine's error, and how many agents were
killed on the way out.

### Ids

`<profile>@<kind>:<target>` for an instance, `agent.<profile>-<target>-<hire>` for
an agent. Deterministic, which is what makes FR-9.4 work in both directions — two
targets give two ids so the same profile activates twice; one target gives the
same id so a duplicate is *detectable*. Carrying both the profile and the target
keeps two crews out of one inbox (`AgentManager` keys live agents by id and
`agora/agents/<id>/` is a directory). An id over 64 characters returns null and
the activation is refused: truncation is precisely how two agents come to share
one.

### Triggers, and the one that is honestly not armed

Schedule triggers are armed on the scheduler (`Trigger.everyMs`). Event triggers
— `webhook`, `ci`, `health` — are **recorded and not armed**, because nothing
publishes those events yet: the Harbor's `gh` ingestion is M7.3 and the webhook
endpoint is M7.4. They appear on the instance as `pendingEvents` so the
subscriber that arrives can find them, and so the gap is a listed fact rather
than a watcher the Architect believes is on duty.

Deactivation disarms triggers **before** killing agents. The other order leaves a
window in which a trigger fires at an agent that no longer exists.

## Mathematical / Statistical Details

One rule, and it is the package: for autonomy levels ordered
`manual (0) < supervised (1) < autonomous (2)`, the effective level is
`min(rank(global), rank(requested))`. `clamped` is `rank(requested) >
rank(global)`. Every other property in this package follows from that being a
minimum rather than a selection.

## Design Decisions

Eight entries in `docs/DECISIONS-LOG.md` dated 2026-08-31 (M7.2). The two that
would be worth arguing with:

1. **A target is a ref plus a path, and the Architect names the path.** No
   document says how `repo:myapp` resolves to a directory. Rather than invent a
   target registry or infer a checkout, activation takes `{ kind, id, path }` —
   the same posture `agents:spawn` already has, so no new surface and no new
   trust. The alternative, inferring the path from `harbor.json`'s remote, would
   be guessing which of the Architect's checkouts they meant.
2. **`GateManager` resolves the grant itself** (above).

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/shared/profile-activation.test.ts test/main/profile-activation.test.ts
```

38 new cases. Full suite **2489 passed / 6 skipped**. Failures are the recorded 9
Windows-local deterministic ones, unchanged, plus `s-stoploop` (2) and `hermes`
(1) under parallel load — hermes passes 40/40 and s-stoploop 8/8 in isolation,
and neither touches this package.

### Production call path

- `src/main/index.ts:1421` — constructs `ProfileActivations` over the
  `AgentManager`, the scheduler, and the real `gate-policy.json`.
- `src/main/index.ts:641` — gives `GateManager` its `profileAutonomy` seam.
- `src/main/index.ts:1687-1697` — binds the four IPC deps.
- `src/main/ipc.ts:414-434` — registers the four channels.
- `src/preload/index.ts:141-153` — exposes them.
- **Renderer: no caller yet.** The activation *screen* is not built; `preview`
  returns everything it needs and nothing renders it. Recorded, not hidden.

### Proved by running the real app

Booted `npx electron .` against a temp `EPH_HOME` carrying a real
`gate-policy.json` (`autonomy: supervised`, destructive permitted at
`supervised`) and a bundle asking for `autonomous` with `destructive: manual`.
`preview` returned:

| kind | global | requested | effective | clamped |
|---|---|---|---|---|
| destructive | supervised | **manual** | **manual** | false |
| spend | supervised | autonomous | **supervised** | **true** |
| scope-change | supervised | autonomous | **supervised** | **true** |
| prod-facing | supervised | autonomous | **supervised** | **true** |
| tool-permission | supervised | autonomous | **supervised** | **true** |
| needs-human | supervised | autonomous | **supervised** | **true** |

The profile's tightening honoured; its widening refused, and *said so*. The
temporary `EVIDENCE` log was removed before commit.

### Mutation-checked: 18 of 18 killed

Both directions of the composition — "profile wins" (the escalation the risk line
names) and "global wins" (which would silently drop a profile's own tightening) —
plus: `clamped` never reporting; the table skipping unmentioned kinds; id
collisions across targets and across profiles; id truncation; a wrong-kind
target accepted; hires losing their own budget; duplicate activation allowed; the
failed-spawn unwind removed; a failed spawn still recorded; deactivation leaving
triggers armed; a missing target directory accepted; `autonomyFor` answering
after deactivation or defaulting to `autonomous`; and the Watch ceasing to
consult the profile at all.

**One survivor, found and closed.** An event trigger could be *reported* in
`instance.armed` while nothing armed it — no assertion compared what the instance
claimed against what the scheduler was actually given. The UI would have shown a
watcher on duty that no clock and no publisher would ever fire. The assertion now
compares the two directly.

## Related Docs

- `docs/adr/ADR-0012-mission-profiles.md` — normative.
- `docs/srs/SRS.md` — FR-9.4, FR-11.1.
- `docs/sdd/SDD.md` — §5 (`profiles:`), §7.5, §9.
- `docs/implementations/2026-08-31-m7-1-profile-schema-loader.md` — the bundle
  this activates.
