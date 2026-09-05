# M8.7b — The harness re-supplies the tools, by name

**Date:** 2026-09-05 · **Package:** B13 (M8.7, second half) · **ADR:**
[ADR-0026](../adr/ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md)

## Problem / motivation

M8.7a made the harness the only author of an agent's hooks, by loading no
settings source but its own. Measured consequence, recorded in ADR-0026 at the
time rather than discovered later: that also hides a target repository's skills
and subagents from a hired agent.

That default is right — a repository is not the company, and a repository that
can hand a semi-trusted agent a skill can hand it instructions. But it left a
crew working on **this** repository unable to reach `doc-guardian`,
`spec-verifier` or the `/build-package` family, which is the
recursive-improvement profile's own toolbox ([ADR-0019](../adr/ADR-0019-recursive-improvement-profile.md)).

The Architect's decision was that the company decides what its agents run with,
**by name**.

## What changed

| File | Change |
|---|---|
| `src/shared/engine-tools.ts` | **New.** What a bundle may declare: a grant is a named root plus a relative path. Pure and renderer-safe. |
| `src/main/engines/tool-grants.ts` | **New.** Resolution and containment. Refuses on escape, reports on absence. |
| `src/shared/org.ts` | `hireTemplateSchema.tools` — additive and optional, so every hire template written before today still validates. |
| `src/shared/profile-activation.ts` | `PlannedHire.tools`, carried as *declared*. |
| `src/main/profiles.ts` | `toolsFor(agentId)`; the activation log records what each hire was granted; **and the spawn-window fix below.** |
| `src/main/agents.ts` | `toolsFor` option, resolved onto the spawn config. |
| `src/main/engines/types.ts`, `claude.ts` | `AgentSpawnConfig.tools`; one `--plugin-dir` per granted directory. |
| `src/main/index.ts`, `home.ts` | The wiring, the degradation reports, and `~/.ephesus/tools/`. |
| `src/renderer/src/ProfilesPanel.tsx` | The activation screen lists what the crew would be granted. |
| `test/main/engines/tool-grants.test.ts` | **New**, 15 cases. |
| `test/main/profile-activation.test.ts` | `toolsFor`, and three cases pinning the spawn-window defect. |
| `scripts/coverage-floors.json` | `engine-tools.ts` assigned to `engines` — the map is total on purpose. |

## Implementation approach

**A grant is a named root plus a relative path.** `{ root: 'target' | 'home',
path: '.claude' }`. The roots are named rather than free-form because the point
is that the Architect can read the list and know what it reaches; a grant that
could start with an absolute path would make "by name" decorative. `target` is
the repository the profile was activated on — how a crew regains the tooling
that repository ships. `home` is `~/.ephesus/tools/` — how the company ships its
own, once, in an Architect-editable place rather than copied into every bundle,
which is the reasoning invariant §8 already applies to `prompts/`.

**One mechanism, not two.** The engine also accepts inline agent definitions on
the command line. Modelling those as well would give a profile two ways to say
one thing and the harness two code paths to keep in step; a directory already
carries skills, subagents and commands together, so a company that wants its own
subagent writes it into a granted directory.

**Refuses on escape, reports on absence.** They are different failures. A
directory outside its root is a bundle asking for something it may not have, and
honouring seven of eight such grants would be a security decision taken by a
loop — so the whole set is refused and the agent is granted nothing. A directory
that is simply not there is the `envGrants` case, and ADR-0010's answer there is
a visible degradation rather than a refused spawn: an agent missing a skill is
diminished, not dangerous, but it must never be *silently* diminished, because
the symptom is otherwise an agent that does not use a tool and nobody can say
why.

Containment is judged on **realpaths**, and the root is resolved too. A string
prefix test passes every unit test anyone writes for it and then fails on the
first symlink or Windows junction — and the harness home routinely sits under a
OneDrive junction here, where comparing a resolved candidate against an
unresolved root reports "outside" for a directory that is plainly inside. The
candidate may not exist yet, so the deepest existing ancestor is resolved and
the remainder re-joined: a missing directory is judged by where it *would* be
rather than skipped.

## Also fixed: a hire could not be asked about while it was being hired

Writing the wiring surfaced a live defect that is **older than this package**.

`AgentManager.spawnConfig` composes a hire's autonomy — and now its tools — by
asking `ProfileActivations`. It asks **during** the spawn, because the config is
built before the process exists. `ProfileActivations.activate` registered its
instance *after* the spawn loop, so during that whole window both questions
answered `null`, and each `null` has a quiet default behind it: `manual`
autonomy, and no tools.

The autonomy half was shipped and live. `claudePermissionMode` maps `manual` to
`--permission-mode default`, so **every agent that arrived through a profile
spawned with the engine's permission prompt fully armed**, whatever autonomy the
Architect had granted — which is precisely the complaint
`AgentSpawnConfig.autonomy` was added at M7.7 to answer. The suite was green on
both sides of it because no test ever asked the question at spawn time; every
test asked after `activate()` returned, which is a different question with a
different answer.

The fix is one seam. A plan is held in an `activating` set from `beforeHires`
until the instance is registered or rolled back, and one private `planFor`
decides which plan an agent belongs to — live or in flight — for both callers.
It is a `Set` rather than a field because two activations can overlap and a
single slot would answer the second one's questions with the first one's plan,
and it is released in a `finally` because a flag cleared on the happy path alone
leaks on every failure — here, leaking a plan that would answer for agents the
roll-back has already killed.

## Verification

**The mechanism, measured before the schema was designed.** `--plugin-dir` was
checked under the M8.7a lockdown: a granted directory's skills and subagents
appear (namespaced by the directory), and a directory with **no** plugin
manifest works — which is what makes granting a repository's bare `.claude`
possible without asking the Architect to add one.

**End to end, through the harness's own resolution.** A scratch harness bundled
`resolveToolGrants` and `ClaudeAdapter` with esbuild, resolved
`{root:'target', path:'.claude'}` against a repository carrying a
`zebrafish-audit` skill, composed the real spawn plan and executed it:

```
WITH the grant   : Yes.
WITHOUT the grant: No.
```

**The defect, reproduced before it was fixed.** The three new spawn-window cases
failed on the old code with `expected null to be 'autonomous'` and
`expected undefined to deeply equal [ { root: 'target', path: '.claude' } ]`,
and pass on the new.

The gate, on `feature/m8-7-engine-isolation`:

- typecheck green across all four projects; lint zero warnings; prettier clean
- invariants ok — reachability **170/178**
- **3700 passed / 8 skipped** across 194 files
- coverage floors ok, none lowered. The floors caught this package twice: once
  for a module belonging to no subsystem, and once for `profiles.ts` losing
  coverage because `toolsFor` had no test reaching it. Both were fixed at the
  cause.

## Design decisions

- **Named roots over free paths** — see above; "by name" has to be enforceable.
- **`home` rather than a per-bundle directory.** Threading a bundle's own
  directory through the parser would have made `parseProfile` impure, and a tool
  granted by two profiles would be two copies.
- **Refuse the whole set, not the offending grant.** A partial grant is a
  security decision taken by a loop.
- **`toolsFor` returns an empty list, not null, for a hire that declared none.**
  Conflating "granted nothing" with "not ours" would make only one of them a
  reason to look elsewhere, and the caller does look elsewhere.
- **The activation screen renders the declaration, not the resolved path.** The
  declaration is what the Architect is being asked to approve; the absolute path
  is its consequence and means nothing on a screen.

## Owed

- **`--agents` is unused.** It is the second mechanism this package deliberately
  did not build. If a profile ever needs a subagent that belongs to no
  directory, that is where it goes.
- **Nothing reaps `~/.ephesus/engines/<engine>/<agent>/`.** Still owed from
  M8.7a; it belongs with decommissioning.
- **The pre-existing autonomy defect deserves a scenario test**, not only a unit
  one: S-BLACKOUT or its neighbour should activate a profile and assert the
  spawn's `--permission-mode`. The unit case pins the seam; only a scenario
  pins the command line.

## Related docs

- [ADR-0026](../adr/ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md) — the decision; its §Consequences named this package as owed
- [`2026-09-05-engine-isolation.md`](2026-09-05-engine-isolation.md) — M8.7a
- [ADR-0012](../adr/ADR-0012-mission-profiles.md) — declarative bundles, read before activating
- [ADR-0010](../adr/ADR-0010-secret-broker.md) — the precedent for reporting a grant that cannot be supplied
- [`docs/PROGRESS.md`](../PROGRESS.md) — M8.7b
