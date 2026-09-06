# An engine declares whether it can enforce the ceiling

**Date:** 2026-09-06
**Found by:** the M8.7 audit, working toward a releasable MVP
**Requirement:** SRS FR-1.10 (new) · FR-11.1 · ADR-0031 (new), extending ADR-0026 and ADR-0012
**Branch:** `fix/mail-lost-when-a-woken-agent-dies`

---

## 1. Problem / Motivation

M8.7 made two claims: every hire runs its own isolated engine install, and the
composed autonomy reaches the process ("whose autonomy hinge it is"). The audit
checked both against every adapter Ephesus registers. Established by execution:

| Adapter | Composed autonomy reaches the process | Config isolation |
|---|---|---|
| `claude` | `--permission-mode` on argv | `CLAUDE_CONFIG_DIR` → the agent's own dir |
| `codex` | **nothing** — no flag, no env | **none** — no `CODEX_HOME` |
| `gemini` | **nothing** | **none** |

`AgentSpawnConfig.autonomy` documents the contract as *"Adapters map it to
whatever their engine calls 'ask me less'"*, and two of three don't. There was no
declaration mechanism — unlike hooks, which have had `HookSupport` and a
conformance honesty check since ADR-0009 — no conformance case, and no
degradation.

**The two halves compound.** With no config isolation, the *operator's* own
engine configuration decides how much the agent asks. A company whose ceiling is
`manual` could therefore run a `codex` hire under an operator config that never
asks, while the activation screen, the agent card and the Ceilings panel all
reported `manual`. That is invariant §7's failure in its worst form — a safety
control displaying as applied — and it lands on the dial the Architect is most
likely to trust.

`ENGINE_IDS` permits it and both adapters are registered in `index.ts`, so a hire
template with `"engine": "codex"` spawned today. Every *shipped* profile uses
`claude`, so this bites the first person who writes their own hire.

## 2. What changed

| File | Change |
|---|---|
| `src/shared/engines.ts` | `AUTONOMY_SUPPORTS`, `autonomySupportSchema`, `AutonomySupport` |
| `src/main/engines/types.ts` | `autonomySupport` on `EngineAdapter` |
| `src/main/engines/claude.ts` | declares `enforced` |
| `src/main/engines/codex.ts`, `gemini.ts` | declare `none`, with the reason and what would change it |
| `src/main/agents.ts` | `assertAutonomyEnforceable`, called in `spawn` before a process exists |
| `test/conformance/adapter-conformance.ts` | grade honesty, checked in both directions |
| `test/fakes/fake-adapter.ts` | declares `enforced` and now carries `--autonomy` into the fake engine |
| `test/main/agents.test.ts` | the rule, the seam, and a probe case corrected |
| `docs/adr/ADR-0031-…md` | **New**, normative; indexed with ADR-0030 |
| `docs/srs/SRS.md`, `docs/THREAT-MODEL.md`, `docs/PROGRESS.md` | FR-1.10; §6.2; the audit note and two repaired sentences |

## 3. Implementation approach

### 3.1 Two grades, and deliberately no third

`enforced` means every level reaches the engine. `none` means the adapter has no
way to say "ask me less", so the engine's own configuration decides.

A middle grade is the dangerous shape — it looks enforced and holds for some
levels — so an integration that cannot map all three declares `none` until it
can. This mirrors `HookSupport` exactly, which is the point: the tree already had
the pattern for "this integration cannot deliver something; say so".

### 3.2 Refuse, and where

`assertAutonomyEnforceable` runs inside `AgentManager.spawn`, before a process
exists. On a `none` engine, `manual` and `supervised` throw with a message naming
the engine and the level.

`autonomous` passes, and the asymmetry is the decision. It is the loosest level
the Architect can ask for, so an engine being *stricter* of its own accord costs
a stalled turn — visible, and not an action anyone refused. Refusing it too would
ban the engine outright rather than protect anything.

### 3.3 Honesty, in both directions

An `enforced` adapter must produce a **different** plan for a different level; a
`none` adapter must produce an **identical** one. Each direction is a different
lie: a `none` adapter that really maps autonomy refuses hires for nothing, and an
`enforced` adapter that does not is the case this exists to prevent.

## 4. Design decisions

Recorded in [ADR-0031](../adr/ADR-0031-an-engine-declares-whether-it-can-enforce-autonomy.md).
The one worth repeating: **mapping Codex and Gemini properly was rejected for
this change**, because the repository's standing rule is that engine behaviour is
established by execution, never guessed — ADR-0026 *ran* `CLAUDE_CONFIG_DIR`,
`--setting-sources=` and the managed-settings path before writing any of them
down. Neither CLI is installed and authenticated here, so a flag written today
would be a guess inside a security control. `none` is the honest declaration
until that work is done, and the grade makes upgrading it a one-line change plus
a conformance run.

## 5. Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
```

**Mutation: 8/8 killed** — the check removed from `spawn`; every engine treated
as enforcing; a `none` engine banned even at `autonomous`; the condition
inverted; only `manual` refused; and each of the three adapters lying about its
own grade in whichever direction it could.

**One test was corrected, not weakened.** `agents.test.ts`'s "starts an engine
whose ADAPTER declares no probe" spawns a `codex` hire and inherited the default
`manual` ceiling, so the new rule refused it. Its subject is the auth probe, so
it now runs at `autonomous` — the level codex is allowed to run at — with a
comment saying why.

**The first draft of the conformance check was wrong in an instructive way.** It
called `conformanceRig()` inside its render helper, so the two plans came from
different temp directories, `--cd` differed, and every adapter looked
autonomy-sensitive. It failed on codex and gemini for the right reason by
accident. One rig, both levels, vary only the variable under test.

## 6. What the audit confirmed about M8.7 itself

The package block recorded that *"the end-to-end claim rests on the key-equality
test rather than observation"*. That is now closed by observation, from runs that
had already happened:

- `~/.ephesus/engines/claude/agent.skeleton-crew-musahit-*/.claude.json` carries
  **two** trusted keys per crew agent — the target repository and that agent's own
  `~/.ephesus/worktrees/<agentId>` — and those worktrees exist.
- `agent.artemis`'s isolated config holds real `lastCost`, token counts and
  durations, so `CLAUDE_CONFIG_DIR` demonstrably took effect.
- The operator's own `~/.claude.json` has 111 project keys and **not one agent
  worktree** among them. Both `trustWorkspace` call sites use per-agent config
  dirs, so nothing writes trust into the shared config any more.

The lockdown flags (`--setting-sources=`, `--settings`) are on the plan, and
`beforeHires` is wired with degradations on both failure paths.

## 7. Owed, recorded not built

**Real config isolation and autonomy mapping for `codex` and `gemini`.** An agent
on either still reads the operator's config directory, including whatever MCP
servers are configured there. This is now stated in the threat model rather than
implied by M8.7's Claude-only evidence, and the grade is the seam it lands on.

## 8. Related docs

- [ADR-0031](../adr/ADR-0031-an-engine-declares-whether-it-can-enforce-autonomy.md) — the decision
- [ADR-0026](../adr/ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md) — the lockdown audited
- `docs/srs/SRS.md` — FR-1.10, FR-11.1
- `docs/THREAT-MODEL.md` — §6.2
