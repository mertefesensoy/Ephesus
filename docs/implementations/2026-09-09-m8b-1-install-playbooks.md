# The runbooks reach the harness home

**Date:** 2026-09-09 · **Milestone:** M8b.1 — *the crew can act* ·
**Branch:** `fix/m8b-1-install-playbooks` from `origin/main` `a2adfaa`

---

## 1. Problem / motivation

Finding 8 of [the M8 exit run](../demo/m8-onehour-aftershock.md) — *"the single
highest-value fix in the record"*, and the direct cause of **both** failing action
clauses of SRS §6.1.

A profile bundle is read from the **repository** (`<app>/profiles/<name>/`, or the
Architect's own copy under `<home>/profiles/<name>/`). Its agents run in worktrees
under the **harness home**. Nothing carried the bundle across that boundary.

On 2026-09-09 the repository bundle held three runbooks — `incident.md` (7,046
bytes), `health-check.md`, `dependency-update.md`. `$EPH_HOME/profiles/` was
**empty**. `activations.json` named all three. So every party in the system could
name a file none of them could open:

| Who | What they reported |
|---|---|
| the health-watcher | *"health-check.md does not exist on disk … `profiles/` exists and is EMPTY … Expect all three duties to fail identically, not just mine."* |
| the health-watcher, again | *"Second firing, same wall."* |
| Artemis | opened the run's only gate (seq 144, `needs-human`): *"skeleton-crew playbooks were never shipped, and a duty re-fires every 15 min"* |

The measured consequence: **18 incidents raised, `incident-triaged: 0`**, no fix, no
PR, and $11.22 / 40.45M tokens spent by four hires discovering a wall. Clause 1b and
clause 2 both fail for this one reason.

**None of it was visible to 4,392 passing tests**, because nothing had ever asked
whether the set of runbooks an instance *declares* and the set on *disk* were the
same set.

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/profile-playbooks.ts` | **new.** Pure: where an instance's runbooks go (`instanceDirName`), whether they are all there (`comparePlaybooks`, `playbooksAgree`), and the sentence a mismatch earns (`playbooksMissingDetail`). No `node:fs`/`node:path` — reachable from the renderer. |
| `src/main/playbooks.ts` | **new.** The filesystem half: `installPlaybooks` (replace, atomic, escape-guarded), `installedPlaybooks`, `auditPlaybooks`, `playbookDegradations`, and the `playbooksDir`/`playbookPath` resolvers every surface shares. |
| `src/main/profiles.ts` | `installPlaybooks` seam on `ProfileActivationOptions`, called in `activate()` after the plan is fixed and **before the first spawn**; `planWith()` so one bundle load answers both the plan and the bodies; `playbookBodies()`; `TriggerWake.playbookPath`. |
| `src/main/index.ts` | Wires the installer to `home.root`; puts the resolved path on the incident binding and the trigger wake; audits every **restored** instance at boot and reports `profiles/playbooks-missing`. |
| `src/shared/incident.ts` | `Incident.playbookPath` beside `Incident.playbook`. |
| `src/main/incidents.ts` | `IncidentBinding.playbookPath`; the prompt renders the path as `{{playbook}}` and the name as `{{playbookName}}`. |
| `prompts/profiles/trigger-body.md`, `trigger-subject.md`, `prompts/harbor/incident-body.md` | Say the runbook is at a path and to open it there rather than search. |
| `test/shared/profile-playbooks.test.ts` | **new**, 12 cases — the pure half. |
| `test/main/playbooks.test.ts` | **new**, 16 cases — the seam, over the real shipped bundle. |
| `src/main/engines/types.ts`, `src/main/agents.ts`, `src/main/engines/claude.ts` | `AgentSpawnConfig.playbooksDir`, the `playbooksFor` option, and the read-only engine grant — **the adversarial pass's finding, see §6**. |
| `src/main/profiles.ts` | `ProfileActivations.instanceFor` — which instance an agent belongs to, answered during its spawn. |
| `test/main/engines/claude.test.ts` | 3 cases: the grant is read-only, absent for an agent on no profile, and not duplicated on re-install. |
| `test/main/agents.test.ts` | 2 cases: the join — `playbooksFor` → `spawnConfig` → the settings file a real spawn writes. |
| 16 existing test files | `playbookPath` / `playbooksDir` added to fixtures; the compile errors that forced this are the point (see §5). |

---

## 3. Implementation approach

### Where the boundary is crossed, and why there

At **activation**, after the plan is settled and **before any hire spawns**:

```
preview → plan fixed → installPlaybooks(plan) → beforeHires → spawn ×N → armed
                            ↑ refuses here
```

The ordering carries the whole argument. A refusal at this point costs nothing —
no process exists, no token has been spent — and the Architect gets a sentence. The
alternative is exactly what was measured: four hires, eighteen incidents, a duty
re-firing every fifteen minutes, and $11.22 to learn the file was never written.

### Why `<home>/instances/<dir>/playbooks/`, not `<home>/profiles/`

The obvious destination is forbidden by a recorded decision. `ProfileStore` resolves
`<home>/profiles/` **before** the app's built-ins, and its own doc comment
(`src/main/profiles.ts`) says why it must never be seeded:

> a silently seeded copy would shadow the built-in forever, so the next Ephesus that
> shipped a corrected Skeleton Crew would not be the one running.

Copying a built-in bundle there at activation would create precisely that shadow, and
silently. The installed copy therefore lands in an **instance-scoped** directory:
invisible to profile resolution, and keyed on the activation rather than the profile
name, so two targets running one profile cannot overwrite each other's runbooks.

### Why a copy at all

The same rule the activation plan already obeys. A plan is persisted and restored
**verbatim** rather than re-derived, because *"restore exactly" (NFR-5) is a claim
about the approved plan, not about the current contents of `profiles/`*. The runbook
is part of what was approved, so it is frozen with it, and drift is **disclosed**
(`profileVersion` is already compared at boot) rather than silently applied. It also
makes the home self-contained: moving or deleting the Ephesus checkout can no longer
silently disarm a running company.

### The value carries the fix, not a new placeholder

`PromptStore` seeds the home's copy of a prompt on first use and **never re-seeds
it**. So an Ephesus that has already run once keeps its old `trigger-body.md` and
`incident-body.md`, and a fix delivered as a *new* `{{placeholder}}` would reach only
fresh homes — and a fresh home is the only kind an exit run ever uses.

The path is therefore rendered as the **value of `{{playbook}}`**, a placeholder those
files already contain, and the bare file name moved to a new `{{playbookName}}` used
by the subject line. An install that never upgrades its prompts still gets the working
half; only the wording lags.

### The second check, at boot

`activations.json` survives a restart; the home directory it points into might not
have. A restored instance is therefore audited at boot and a mismatch reported as
`profiles/playbooks-missing` — a visible degradation naming the instance, the files,
the directory and the remedy (invariant §7). Without it, an instance cleaned or moved
between runs comes back looking healthy and fails one duty at a time, forty minutes
later, which is how the exit run found it.

---

## 4. Mathematical / statistical details

One claim here is mathematical rather than merely conventional, and the scheme rests
on it.

`instanceDirName` maps an instance id to a directory name. For the directory to be a
safe key, the map must be **injective** over the id grammar: two distinct instances
must never resolve to one directory, or one crew's runbooks silently replace
another's.

The grammar is `instanceIdSchema`:

```
^[a-z0-9][a-z0-9-]*@(repo|app):[a-z0-9][a-z0-9-]*$
```

so every legal id is `P @ K : T` with `P, T ∈ [a-z0-9][a-z0-9-]*` and `K ∈ {repo,
app}`. The map replaces every character outside `[A-Za-z0-9@_-]` with `-`; over this
grammar the only such character is the single `:`, so the image is `P @ K - T`.

*Injectivity.* Take ids `x = P@K:T` and `x' = P'@K':T'` with `f(x) = f(x')`. The
image contains exactly one `@` (neither `P`, `K` nor `T` may contain one), so
splitting on it recovers `P = P'` and `K-T = K'-T'`. `K` and `K'` are drawn from
`{repo, app}`, and neither is a prefix of the other, so the leading token of `K-T`
determines `K` uniquely — hence `K = K'` and therefore `T = T'`. So `x = x'`. ∎

The test does not take this on trust: it enumerates the grammar's shape over 5
profile names × 2 kinds × 4 targets, asserts every generated id validates against
`instanceIdSchema`, and asserts the image has the same cardinality as the domain
(`new Set(ids.map(instanceDirName)).size === ids.length`). The deliberately awkward
member `crew-repo-x` is in that list because it is the case a naive argument misses.

**Totality outside the grammar.** The function also runs on strings the schema cannot
produce, and claims to be total over them. Writing the test found that it was not:
`.` had been left in the safe set, so `'..'` folded to **itself** and would have named
the parent of `instances/`. `.` was removed from the safe set and the empty fold is
mapped to `-`, so the image contains no string the filesystem reads as an instruction.

---

## 5. Design decisions

**A refusal, not a degradation — unlike its neighbour.** `beforeHires` explicitly
*cannot* refuse: ADR-0021 makes a failed engine-trust write a visible degradation
because a company may still work without it. This seam sits beside it and refuses,
because an instance whose hires cannot read the runbook they are told to follow
cannot do the one thing it was activated for. `parseProfile` already refuses a bundle
whose trigger names a playbook it does not carry; this is that same rule, one boundary
further on. *(Architect decision, 2026-09-09.)*

**Two-way equality, not "nothing is missing".** M8b.1's acceptance is that the sets
are *equal*. A leftover runbook from a previous activation still opens when an agent
is pointed at it, and nobody approved it — so `extra` is reported too. It is reported
rather than silently deleted, so the Architect learns their home was edited.

**A widened required field, not an optional one.** `playbookPath` was added to
`IncidentBinding` and `TriggerWake` as **required**, which broke the compile in eight
test files. That was the cheapest way to be sure every construction site was found:
an optional field would have left a caller silently passing `undefined`, which is the
same class of silence this package exists to remove.

**One bundle load, not two.** `activate` needs the playbook *bodies* and the plan
carries only their *names*. Re-loading to get them would let an edit landing between
the two reads install runbooks belonging to a plan the Architect was never shown, so
`planWith()` returns both from a single load — the same argument
`grantsUnavailable` already makes about the resolver the spawn path uses.

**Alternatives considered and rejected:**

| Option | Why not |
|---|---|
| Copy into `<home>/profiles/<name>/` | Shadows the built-in forever — forbidden by `ProfileStore`'s recorded decision. |
| Resolve from the repository at wake time, no copy | Always current, and no staleness — but the home stays not self-describing (a stranger who looks in the home still finds nothing, which is what three parties did on the run), and a moved or deleted checkout silently breaks a live company. |
| Copy into the agent's worktree | The worktree is a git worktree **of the target repository**; this drops untracked files into the Architect's repo that an agent could commit or push. |
| Refuse at activation only, no boot audit | Covers the case the run hit and misses the one it structurally cannot reach: a record that survives a restart into a home that did not. |

---

## 6. The adversarial pass, and what it found

**The fix as first written was incomplete, and no test in this package could have
said so.** Recorded here rather than quietly folded in, because the value of the pass
is the demonstration that green tests and killed mutants do not substitute for it —
the precedent being M8.0, where 40 green tests and 9 killed mutants still hid three
bypasses.

After 27 green tests and 15 killed mutants, the question asked was: *the file is on
disk and the message names it — can the agent actually open it?*

It could not. `mailboxPermissions` in `src/main/engines/claude.ts` says why, about a
different directory in exactly the same position:

> An agent's `agora/agents/<id>/` directory lives in the harness home, **outside the
> working directory it was spawned in — so the engine's own permission model blocks
> writing to it** … which is how this was found: a real agent in the M2 exit demo
> answered *"the write was blocked by permissions"*.

`<home>/instances/<instance>/playbooks/` is in that same position, and had **no grant
at all**. An agent told to open it would either meet a permission prompt — which the
exit run's Finding 10 shows nobody may answer during an unattended hour — or report
that it could not read its runbook. That is Finding 8 again, one step further along,
with the file present this time and the clause still failing.

**The fix.** A read-only grant, minted the same way and at the same moment as the
mailbox grant:

| Piece | What |
|---|---|
| `AgentSpawnConfig.playbooksDir` | the directory, or null for an agent on no profile |
| `AgentManagerOptions.playbooksFor` | answered by the profile layer, asked at spawn — like `toolsFor` and `autonomyFor` |
| `ProfileActivations.instanceFor` | the INSTANCE (not the profile), via `planFor`, so it answers **during** the spawn |
| `playbookPermissions` | `Read(<dir>/**)` and `additionalDirectories: [<dir>]` |

`Read` only, deliberately narrower than the mailbox's `Read`+`Edit`. An agent must
write its own outbox; a runbook is the standard its work is judged against, shared by
several hires, and an agent that could rewrite it could quietly lower the bar it is
being held to.

### The gap the second mutation round then found

Round 2 planted `playbooksDir: null` in `AgentManager.spawnConfig` — and every test
stayed **green**. `playbookPermissions` was tested against a config that carried the
directory, and `instanceFor` was tested for answering during a spawn; nothing tested
the seam *between* them. Two correct halves and no test of the join is the shape this
build keeps rediscovering.

`test/main/agents.test.ts` now spawns through a real `AgentManager` with a real
`ClaudeAdapter` and reads the settings file that spawn actually writes. The mutant
dies.

---

## 7. Verification

### Definition of Done

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs
```

### Mutation — every new test proved able to fail

Two rounds, each reverting the source after every mutant. Full harness:
`scratchpad/mutate.py`, `mutate2.py`.

**Round 1 — the installer, the audit and the messages: 15/15 killed.**

| Mutant | What it breaks | |
|---|---|---|
| M1 | nothing is ever installed — the 2026-09-09 state exactly | killed |
| M2 | a failed install no longer refuses the activation | killed |
| M3 | files appear with the right names and no content | killed |
| M4 | installs the bundle's set rather than the plan's declared set | killed |
| M5 | install merges with a previous one instead of replacing it | killed |
| M6 | a playbook name may escape the instance directory | killed |
| M7 | a failed write reports success | killed |
| M8 | a runbook nobody declared is not reported | killed |
| M9 | a declared runbook that is absent is not reported | killed |
| M10 | `..` folds to itself and names the parent directory | killed |
| M11 | the instance id is used verbatim, colon and all | killed |
| M12 | the degradation stops saying what to do about it | killed |
| M13 | only the first of two conditions survives (Finding 2's shape) | killed |
| M14 | the audit reports agreement whatever is on disk | killed |
| M15 | the duty message names the file again instead of the path | killed |
| **M16** | **CONTROL — changes nothing** | **SURVIVED, as it must** |

**Round 2 — the engine grant: 8/8 killed.**

| Mutant | What it breaks | |
|---|---|---|
| M17 | the runbook directory is never granted — the adversarial finding itself | killed |
| M18 | the grant becomes writable | killed |
| M19 | the grant widens to the whole instance directory | killed |
| M20 | an agent on no profile is granted something anyway | killed |
| M21 | the grant is no longer deduplicated across re-installs | killed |
| M22 | `instanceFor` answers with the PROFILE, so two targets share one directory | killed |
| M23 | `instanceFor` consults only the LIVE set, so it answers null during every spawn | killed |
| M24 | the spawn config never carries the directory | killed *(after the join test; it SURVIVED before)* |
| **M25** | **CONTROL — changes nothing** | **SURVIVED, as it must** |

**23 of 23 real mutants killed. Both planted no-op controls survived**, which is what
proves the harness can report a survivor at all rather than reporting "all killed"
because it cannot tell.

### What a defect found by writing a test looks like

`instanceDirName` left `.` in its safe character set, so `'..'` folded to **itself** —
naming the parent of `instances/`. Unreachable through `instanceIdSchema`, and the
function's whole claim is to be total over strings that never reach it. Found while
writing `never folds to a name the filesystem reads as an instruction`, fixed, and
now killed as M10.

### What this does NOT prove

No live run. The clause this unblocks — `EXIT-M8.md` §5.1's *"a triage report came
back"* — can only be verified against a real repository with a real crew, and that is
the rehearsal owed at the end of M8b. What is proved here is that the runbooks are
installed, that they are where the agent is told to look, that the engine is permitted
to read them, and that the activation refuses rather than hiring a crew that cannot.

---

## 8. Related docs

- [The M8 exit run](../demo/m8-onehour-aftershock.md) — Finding 8, §5.1, §10 clauses 1b and 2.
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8b.1's acceptance criteria.
- [ADR-0012](../adr/ADR-0012-mission-profiles.md) — declarative profile bundles; "playbooks are prose, policy is data".
- [ADR-0021](../adr/ADR-0021-workspace-trust-at-activation.md) — why `beforeHires` may not refuse, and why this seam may.
- [ADR-0027](../adr/ADR-0027-what-survives-a-restart.md) — reactivation takes over a down instance.
- [`docs/EXIT-M8.md`](../EXIT-M8.md) §5.1 — the clause this unblocks.
