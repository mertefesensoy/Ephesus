# M8.7 — workspace trust follows the agent into its worktree

## Problem / motivation

An adversarial audit of M8.6 (8 lenses, 58 findings) returned one finding that
survived every refuter: **isolation had silently re-opened the exact failure
ADR-0021 was written to close.**

[ADR-0021](../adr/ADR-0021-workspace-trust-at-activation.md) makes the
Architect's activation the answer to Claude Code's first-run trust prompt. The
prompt is a per-workspace gate whose highlighted default is `No, exit`, and it
appears **before any session begins** — so no engine hook fires for it, nothing
in the harness can see it, and an agent that meets it parks for its whole life
while the floor shows it as spawned. On the live MUSAHIT run that cost three
crew agents, five times over.

M8.6 then made worktree isolation the default for profile hires (B10). Every
hire an activation creates now works in `<home>/worktrees/<agentId>`, not in the
target. And the engine keys its trust record on the **exact** resolved path —
`claudeProjectKey` produces one string and the engine matches it literally.

So `index.ts` trusted `request.target.path`, and **not one crew agent's actual
working directory was ever trusted.** Every isolated hire met the dialog, with
no session and therefore no way to report it.

Two ordering facts made it unfixable in place:

- `trustWorkspace` ran *before* `activations.activate`, so at trust time the
  worktree did not exist;
- `fs.realpathSync.native` — ADR-0021's junction guard — throws on a path that
  does not exist, and there is an explicit test pinning that refusal.

**Why no test caught it:** nothing related the directory the trust record *names*
to the directory the agent is spawned *into*. `claude-trust.test.ts` only ever
passed a bare directory; no activation test opened `.claude.json`. This is the
same shape as the two defects the M8.6 mutation pass found — a rule checked only
where something else already satisfies it.

## What changed

| File | What |
|---|---|
| `docs/adr/ADR-0025-…md` | **New.** Extends ADR-0021's scope to the worktrees an activation creates. ADRs are append-only, and this widens an accepted security decision, so it gets its own record |
| `src/main/engines/types.ts` | New `WorkspaceExistence` (`must-exist` \| `will-be-created`); `trustWorkspace` takes it, defaulting to `must-exist` |
| `src/main/engines/claude.ts` | `resolveProjectKey` — full `realpath` for `must-exist`, parent-resolution for `will-be-created` |
| `src/shared/profile-activation.ts` | `plannedWorkspaces(plan, worktreePathFor)` — pure; the target plus one entry per isolated hire |
| `src/main/profiles.ts` | New `beforeHires(plan)` seam, called after the plan is fixed and before the first spawn |
| `src/main/index.ts` | One `worktreesRoot()`/`worktreePathFor` (there were three independent copies); the trust write moved out of `profilesActivate` into `beforeHires` and now covers the worktrees |
| `test/main/engines/claude-trust.test.ts` | +6: the not-yet-created case, key equality across both modes, the parent junction guard, both refusals, the unchanged default |
| `test/main/profile-activation.test.ts` | +7: the workspace set, override directions, per-hire coverage, the path-function identity, ordering before the first spawn, and nothing on a refused plan |

## Implementation approach

### The fix had to stay at activation time

ADR-0021 forbids the obvious wiring **by name**:

> `trustWorkspace(cwd)` is called from a profile activation … and from nowhere
> else. It is never called from spawn, respawn, or a wake.

and lists "pre-trust at spawn rather than activation" as a *rejected* option,
because it would fire on every respawn and wake long after the Architect had
left, and cover cwds no activation ever named. Hooking the trust into
`AgentManager.isolate` — where the worktree certainly exists — is precisely that
rejected option, so it was not available.

Instead `ProfileActivations` gained a `beforeHires(plan)` seam: after the plan is
settled and the activation is going ahead, before any process exists. Still one
activation, still the Architect's own click, still nowhere near spawn.

### One plan, one path function — the anti-drift property

This is the part the fix actually rests on. A trust key that differs by one
character from the key the engine looks up is a record nothing reads, and its
**only** symptom is an agent that hangs with no session and no hook. So:

- `plannedWorkspaces` takes the `ActivationPlan` object the hires are spawned
  from — not the request, and not a second `preview()` call. Deriving the
  directory set separately is the two-code-paths mistake M8.5 already paid for.
- It takes `worktreePathFor` as a parameter, and `index.ts` passes the *same*
  function it gives `AgentManager`'s `worktrees.pathFor`. Before this change
  `index.ts` computed the worktree root in three independent places; it now has
  one.

A test asserts `plannedWorkspaces` asks that function for exactly the isolated
hires, so the injected function is the single source of truth.

### `realpath` cannot guard what does not exist yet, so it guards the parent

`WorkspaceExistence` makes the two cases explicit rather than weakening one:

- `must-exist` (the default) resolves the whole path — ADR-0021's guard,
  bit-identical for every caller written before this change.
- `will-be-created` resolves the **parent** and appends the leaf.

The guard is not lost where it can matter. The parent is `<home>/worktrees`,
which the harness creates and owns; the leaf is a name the harness derives from
an agent id. Nothing a target repository or a third party controls is left
unresolved. A test proves the two modes produce the **same key** for the same
directory once it exists — the property that makes the record findable at all —
and another proves a symlinked parent still resolves through.

## Also fixed: the ladders were disarmed after the unwind, not before

A second audit finding, in the same package and also mine. M8.6 registered
`crew.stop()` among the quit's `steps` with this comment:

> Before the unwind, not after: a ladder still armed treats the shutdown's own
> kills as crashes and respawns the company it is tearing down.

The comment states the intent exactly. The code did the opposite:
`QuitSequence.execute` runs closing → **unwind** → `steps`, so `steps` is the
last phase and every ladder was armed while the unwind killed the agents it was
watching.

Nothing caught it because **no test related the phase a step is registered in to
the phase it actually runs in** — the ordering test asserted
`ask → closing → unwind → stops`, and the crew step was simply one of the stops.

`QuitSequence` gained a `disarm()` seam that runs between closing time and the
unwind, isolated exactly as `steps` is: a ladder that will not disarm is
reported and stepped over, because it must not cost the unwind its settings
restores. It carries its own degradation cause (`shutdown/disarm:<name>`) so a
wedged ladder does not read as a wedged teardown stop.

`Artemis.stop()` went into the same phase. It had **zero production callers** —
FR-5.4's ladder brought the orchestrator back on every exit, including the one
the quit itself performs.

Five mutations; the three semantic ones killed, including the original defect.
The two survivors were deliberate no-op rewrites, included as live-anchor
controls after CRLF/LF drift silently skipped five mutations earlier in the day.

## Design decisions

| Decision | Alternatives rejected |
|---|---|
| Trust at `beforeHires`, from the plan | **From `AgentManager.isolate`** — rejected by ADR-0021 by name; fires on every respawn and wake and covers any cwd a bare `agents:spawn` names |
| `will-be-created` resolves the parent | **Pre-create the worktree so it can be resolved in full** — `Worktrees.create` refuses a path that exists, so this would break isolation itself |
| One entry per isolated hire | **Trust `<home>/worktrees` once** — the engine matches the exact key (established by experiment in ADR-0021), so a parent grant covers no child |
| Target still trusted unconditionally | **Narrow it to activations that put a hire there** — least-privilege and tempting now that most hires are isolated, but that *changes* ADR-0021 rather than extending it, and is not needed to fix this. Recorded in ADR-0025 as the obvious next narrowing |
| `must-exist` stays the default | Flipping the default would silently weaken every pre-M8.7 caller. A mutation that does exactly that is killed by its own test |

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage -- --coverage.reportsDirectory=coverage/m87
node scripts/check-coverage.cjs --summary coverage/m87/coverage-summary.json
```

The separate report directory is Codex's workaround for a Windows/OneDrive lock
on `coverage/`; it changes no threshold and no inclusion.

Typecheck, lint (prettier clean) and invariants green — reachability 167/175, 8
unreachable by recorded decision, 6 type-only.

### Refutation — 13 mutations, 13 killed

Each breaks the fix in one specific way and runs the suites that claim to catch
it. Notable ones:

| Mutation | Killed by |
|---|---|
| **the original blocker** — worktrees never added to the set | `lists the target and one worktree per isolated hire` |
| only the first isolated hire trusted (a *partial* set) | same |
| `beforeHires` never called | `is called before a single hire is spawned` |
| trust written on a plan that was refused | `is not called at all when the plan is refused` |
| worktree marked `must-exist` (would refuse every one) | `lists the target and one worktree…` |
| target marked `will-be-created` (drops the junction guard) | same |
| parent not resolved through `realpath` | `still resolves the parent through realpath…` |
| `will-be-created` requires existence (reverts to the bug) | `writes a key for a directory git has not made yet` |
| default flipped to `will-be-created` | `defaults to must-exist…` |

**Harness note, recorded because it cost two passes:** `src/**` here is CRLF, so a
mutation anchored on a string spanning a line boundary never matches and the
harness prints `NOT-APPLIED` — which reads like a mutation that ran. Five of ten
silently did not run the first time, *including the one reproducing the original
blocker*. Single-line anchors only, and treat `NOT-APPLIED` as a harness failure
rather than a result.

### Not verified here

No profile has been activated against a real repository in the shipped app under
these rules, so the end-to-end claim — that an isolated hire now starts without
meeting the dialog — rests on the key-equality test rather than on observation.
That is M7's still-open exit criterion, and this does not close it.

## Related docs

- `docs/adr/ADR-0025-workspace-trust-covers-the-worktrees-an-activation-creates.md`
- `docs/adr/ADR-0021-workspace-trust-at-activation.md` (extended, not superseded)
- `docs/sdd/SDD.md` §1.1 (`engines/` row) and §3 (the isolation/trust bullet)
- `docs/implementations/2026-09-04-m8-6-crew-isolation-and-survival.md` (the
  change that opened this)
- `docs/DECISIONS-LOG.md` — 2026-09-05 entries
