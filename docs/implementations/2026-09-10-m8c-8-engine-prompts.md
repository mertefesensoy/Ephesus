# What an engine-level permission prompt is, and what a hire may do without one

**Date:** 2026-09-10 · **Milestone:** M8c.8 · **Branch:**
`fix/m8c-8-engine-prompts` from `origin/main` `11cc60a` ·
**Deliverable:** [ADR-0035](../adr/ADR-0035-an-engine-prompt-is-declared-in-advance.md)

---

## 1. Problem / motivation

Finding 10 of [the M8 exit run](../demo/m8-onehour-aftershock.md), **upgraded by**
[the M8b rehearsal](../demo/m8b-rehearsal-m8b-rehearsal.md)'s Finding D.

The harness records `gate/ungated · tool-permission · waiting · "Claude is
waiting for your input"` whenever an agent meets its engine's own permission
dialog. It is right to: invariant §7 requires every give-up to be visible. But
it is not an Ephesus gate — no `gateId`, no blast radius, no verdict — and
`evaluateGate` refuses the kind by construction, correctly, because **the
harness has no action to permit there. The engine does.** So nobody can clear
one: not the Architect, not `ephctl`, and the exit script forbids the runner
answering it.

On 2026-09-09 that was filed as a worry — *"medium-high: it undercuts the
premise of an unattended hour"* — because the crew never got far enough for it
to bite. M8b let the crew act, and the rehearsal measured it:

| | M8 exit run | M8b rehearsal |
|---|---|---|
| prompts in the hour | 7 in 40 minutes | **12** |
| agents whose LAST recorded action is a parked prompt | — | **4 of 5** |

The Architect saw it from outside before the log did — *"they opened 3 PRs then
stopped."* **The hour does not last an hour: it lasts until the first agent
reaches a prompt**, and five triages and three pull requests is what fits in
between. The package's acceptance is therefore not a feature but a sentence:
*an unattended hour must be able to end because the work ended.*

---

## 2. What changed

| File | What |
|---|---|
| `docs/adr/ADR-0035-…md` | **The deliverable.** The decision, the three options it beat, and the residuals stated rather than hidden. |
| `src/shared/engine-permissions.ts` | **new.** The `unattended` vocabulary, its refusals, and the one renderer both the screen and the log use. |
| `src/shared/org.ts` | `hireTemplateSchema` gains optional `unattended`. |
| `src/shared/agents.ts` | `spawnRequestSchema` carries it to the spawn path, beside `envGrants`. |
| `src/shared/profile-activation.ts` | The plan puts a hire's declaration on its spawn request. |
| `src/main/engines/types.ts`, `src/main/agents.ts` | `AgentSpawnConfig.unattended`, read from the request. |
| `src/main/engines/claude.ts` | Renders each grant as a Claude permission rule, exact or prefixed, into the settings file the harness already writes — and into the dedupe set, so a respawn does not accumulate. |
| `src/main/profiles.ts`, `src/renderer/src/ProfilesPanel.tsx` | The activation row and the activation screen say what was granted. |
| `src/shared/share.ts`, `src/main/harbor/hires.ts` | The sharing manifest discloses it, and the widening check refuses an import that adds one — **and the same for `tools`, which had never been covered.** |
| `profiles/*/hires/*.json` | The seven shipped hires declare what their runbooks already say in prose, and more narrowly. |
| `scripts/coverage-floors.json` | The new module joins the `engines` row, beside `engine-tools.ts`. |
| `test/shared/engine-permissions.test.ts`, `test/shared/share.test.ts`, `test/main/engines/claude.test.ts`, `test/main/profile-activation.test.ts` | The schema's refusals, the seam, the join, the bundles' own grants, and four escalation regressions. |

---

## 3. Implementation approach

**The declaration travels on the spawn request, not through a seam.** The first
version added an `unattendedFor(agentId)` option to `AgentManager` and wired it
in `index.ts`, mirroring `toolsFor`. The coverage floors refused it — one more
uncovered arrow in `index.ts`, which is the `boot` row's whole subject — and the
refusal was right about the design, not just the number. `toolsFor` exists
because tool directories must be **resolved** against a target and checked for
containment, which is a filesystem concern that can fail and must be reported.
An `unattended` grant is text a bundle wrote and the adapter renders. It needs no
resolution, so it rides beside `envGrants` on the request that already carries
the rest of the hire's declaration — one fewer seam, one fewer place to disagree.

**One renderer, two readers.** `describeUnattendedGrants` is what the activation
screen prints, what the `activated` row records, and what the sharing manifest
compares. It takes `undefined` as well as a list, deliberately: the field is
optional on a spawn request, so every caller would otherwise carry its own
`?? []` — a branch per caller, of which exactly one could ever reach the right
half, which is a branch that exists to be uncovered.

**Prefix versus exact is the whole safety story.** `Bash(cmd)` matches that
command and nothing else — the form `ghTokenPermissions` has always used.
`Bash(cmd:*)` matches anything starting with it. The schema refuses a
single-word prefix grant, because `{"run": "git", "prefix": true}` would grant
everything git can do.

---

## 4. Mathematical / statistical details

None — no formula, statistical test or numeric algorithm. The two quantitative
claims are counts from the rehearsal's own log, quoted in §1: twelve prompts in
the hour, and four of five agents' last recorded action being one.

The only "algorithm" is string matching, and it is the engine's, not this
repository's: a Claude permission rule of the form `Bash(x)` matches the command
`x` exactly, and `Bash(x:*)` matches any command whose text begins with `x`.
Everything this package decides follows from which of those two it emits.

---

## 5. Design decisions

**Pre-authorise, rather than let the harness answer the prompt.** The Architect's
call, and ADR-0035 §Options records the reasoning: a harness that types into an
engine's permission dialog can approve anything the engine would have asked
about, in advance of knowing what that is. That is a strictly larger power than
declaring beforehand what may happen, and it is the authority ADR-0033 refuses to
a script. Declaring is also auditable *before* the fact.

**Commands only.** One mechanism rather than two — the argument
`engine-tools.ts` makes for granting directories. The prompts an unattended crew
meets are shell-shaped; reads and edits inside its own worktree are already
decided by ADR-0031's autonomy mapping, and its mailbox and runbooks are already
granted by name.

**The Front Office gets no push and no pull-request grant.** It is draft-only by
design (M7.5/M7.6: *"a draft-only profile has no code path that posts"*), and a
pre-authorised `gh pr create` there would be that posting path arriving through
a side door. Asserted, not remembered.

**What the adversarial pass changed, and it changed two things.** Both are in §6.

---

## 6. Verification

Full gate, this branch:

```
typecheck   green (node, preload, web, web-test)
lint        All matched files use Prettier code style!
invariants  ok — reachability 188/198 src modules reached, 10 by recorded decision, 6 type-only
tests       Test Files 235 passed (235) · Tests 4508 passed | 8 skipped (4516)
coverage    floors ok (17 subsystems on win32; 20 untested modules, all recorded)
```

**Mutation round, with a control** — fourteen real mutants and a planted no-op,
over `engine-permissions.ts`, `claude.ts`, `profile-activation.ts`, `profiles.ts`,
`share.ts` and two shipped bundles.

```
test files: engine-permissions · claude · profile-activation · share
baseline: GREEN
  M1  the chaining guard accepts everything              KILLED
  M2  a single-word prefix grant is allowed              KILLED
  M3  the traversal guard is dropped                     KILLED
  M4  the per-hire cap is lifted                         KILLED
  M5  every grant is rendered as a PREFIX rule           KILLED
  M6  no grant reaches the settings file at all          KILLED
  M7  the grants accumulate across a respawn             KILLED
  M8  the plan drops the declaration en route            KILLED
  M9  the activation row says nothing about the grant    KILLED
  M10 the on-call push grant becomes a prefix            KILLED
  M11 a Front Office hire may open a pull request        KILLED
  M12 the widening check ignores unprompted commands     KILLED
  M13 the widening check ignores tool directories        KILLED
  M14 the manifest need not disclose what it carries     KILLED
  CONTROL a no-op comment reword                         SURVIVED — CERTIFIED

mutants: 14 real, 1 control · killed: 14 of 14 real · ROUND OK
```

M7 is worth reading twice: its **first** version inserted a line without removing
the one it meant to, so it was a no-op and survived. The round reported that as a
MISMATCH rather than as a finding about the code, which is what a control-carrying
harness is for — an unearned kill and an unearned survival are the same error.

**Adversarial refutation pass — it broke this package twice.**

| Attempt | Result |
|---|---|
| Can an imported bundle grant itself commands nobody approved? | **BROKE IT.** `inspectImport`'s widening check — the thing that exists to stop a shared bundle escalating — did not know the field existed. A bundle reusing a trusted name could have arrived carrying anything. Manifest, widening check and three regressions added. |
| …and does the same hole exist for `tools`? | **YES, since M8.7b.** Directories an agent reads as *instructions* (ADR-0026's whole subject) were never covered there either. Closed in the same three lines: a manifest that disclosed one and not the other would look complete and not be. |
| Is `git push -u origin agent/` really bounded by the branch namespace? | **BROKE IT.** git's refspec is `<src>:<dst>`, so `git push -u origin agent/x:main` starts with that prefix and pushes to `main`. Both push grants are now the exact `HEAD` forms, which cannot name a destination. |
| Can a manifest *hide* a grant its payload carries? | Held — the manifest is recomputed from the payload, so an omission is refused as a mismatch. Asserted. |
| Can a declaration smuggle a second command? | Held — `;`, `&`, `|`, backtick, `$(`, `<`, `>`, newline, NUL and `..` are all refused, each with its own case. |
| Does a re-import of the same bundle get refused as an escalation? | No — a grant the installed version already holds passes. A check that refused an update would be unusable for the update it guards. |
| Does a respawn accumulate duplicate rules in a reused worktree? | Held — the grants are in the dedupe set, asserted by a test. |
| Can a bundle *narrow* a grant and have the wider rule retracted? | **No, and it is pinned rather than hidden.** Nothing distinguishes a rule this harness wrote from one the Architect wrote, so the wider rule survives in that agent's settings until the file is restored from its backup. A test named for it says so, and ADR-0035 states it under Consequences. |

**What this package cannot claim.** That an unattended hour now ends because the
work ended. Nothing here proves that; only a run does, and the M8c rehearsal is
where it gets tested. What it does claim is that the shipped crew's runbook flow
— inspect, reproduce, branch, commit, push its own work, open a pull request —
no longer stops at a prompt for any step the runbook itself instructs.

---

## 7. Related docs

- [`docs/adr/ADR-0035-…md`](../adr/ADR-0035-an-engine-prompt-is-declared-in-advance.md) — the decision
- [`docs/adr/ADR-0031-…md`](../adr/ADR-0031-an-engine-declares-whether-it-can-enforce-autonomy.md) — why `autonomous` is `auto` and not `bypassPermissions`
- [`docs/adr/ADR-0033-…md`](../adr/ADR-0033-a-script-may-run-the-company.md) — the authority a script is refused, and why option 2 shares it
- [`docs/adr/ADR-0026-…md`](../adr/ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md) — the "by name" precedent, and the `tools` hole this pass closed
- [`docs/demo/m8b-rehearsal-m8b-rehearsal.md`](../demo/m8b-rehearsal-m8b-rehearsal.md) — Finding D, the measurement
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8c.8 and its acceptance
