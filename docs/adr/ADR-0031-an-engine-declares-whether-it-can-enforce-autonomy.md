# ADR-0031 — An engine declares whether it can enforce autonomy

**Status:** accepted · **Date:** 2026-09-06 · **Extends:** ADR-0026, ADR-0012 ·
**Depends on:** ADR-0009 (the adapter contract this adds a field to)

## Context

An audit of M8.7 on 2026-09-06, working toward a releasable MVP, checked whether
that package's two central claims — engine isolation, and "whose autonomy hinge
it is" — hold for every engine Ephesus ships. They hold for one.

Established by execution against all three registered adapters:

| Adapter | Composed autonomy reaches the process | Config isolation |
|---|---|---|
| `claude` | `--permission-mode` on argv | `CLAUDE_CONFIG_DIR` → the agent's own directory |
| `codex` | **nothing** — no flag, no env, anywhere | **none** — no `CODEX_HOME`, so `~/.codex` is the agent's config |
| `gemini` | **nothing** | **none** |

`AgentSpawnConfig.autonomy` states the contract in its own doc comment —
*"Adapters map it to whatever their engine calls 'ask me less'"* — and two of
three do not. There was no declaration mechanism (unlike `HookSupport`, which
has exactly this shape for hooks), no conformance case, and no degradation.

**The two halves compound, and that is what makes it more than a missing
feature.** Because nothing redirects the config directory either, the
*operator's* own engine configuration decides how much the agent asks. So a
company whose ceiling is `manual` could run a `codex` hire under an operator
config that never asks — while the activation screen, the agent card and the
new Ceilings panel all reported `manual`. A safety control displaying as applied
is invariant §7's failure in its worst form, and it lands on the dial the
Architect is most likely to trust.

Every profile Ephesus *ships* uses `claude`, so this bites the first person who
writes their own hire template — which is precisely the install story an MVP is
for.

## Decision

### 1. `autonomySupport` joins the adapter contract

Two grades, mirroring `HookSupport`:

- **`enforced`** — every level reaches the engine as a flag or setting, so what
  the Watch composed is what the process runs at.
- **`none`** — the adapter has no way to say "ask me less" to this engine, so
  the engine's own configuration decides, and that configuration belongs to the
  operator rather than to the harness.

There is deliberately **no middle grade**. A partial mapping is the dangerous
shape — it looks enforced and holds for some levels — so an integration that
cannot map all three declares `none` until it can.

`claude` declares `enforced`. `codex` and `gemini` declare `none`.

### 2. A hire is refused when the ceiling cannot be enforced

`assertAutonomyEnforceable` runs in `AgentManager.spawn`, before a process
exists. On a `none` engine, `manual` and `supervised` are refused with a message
naming the engine and the level.

`autonomous` is allowed through, and that asymmetry is the decision. It is the
loosest level the Architect can ask for, so an engine being *stricter* of its own
accord costs a stalled turn — visible, and not an action anyone refused.
Refusing it too would ban the engine outright rather than protect anything.
Anything stricter is refused, which is the direction FR-11.1 requires a default
to fail in.

### 3. The declaration is conformance-checked in BOTH directions

An `enforced` adapter must produce a **different** spawn plan for a different
level; a `none` adapter must produce an **identical** one. Each direction is a
different lie with a different victim: a `none` adapter that really does map
autonomy refuses hires for nothing, and an `enforced` adapter that does not map
it is the case this ADR exists to prevent.

Both plans are rendered from **one** rig. The conformance rig mints a fresh temp
directory per call, so two rigs differ in `--cd` and *every* adapter would look
autonomy-sensitive — which is what the first draft of the check did, and it
"passed" for the wrong reason on the two adapters it was written to catch.

## Options considered

- **Map Codex and Gemini properly now.** The complete fix, and where this must
  end up. Rejected *for this change* by the repository's own standing rule:
  engine behaviour is established by execution, never guessed
  (`claude-code-engine-ground-truth`, and ADR-0026's own method — `CLAUDE_CONFIG_DIR`,
  `--setting-sources=` and the inertness of `CLAUDE_CODE_MANAGED_SETTINGS_PATH`
  were each *run* before being written down). Neither CLI is installed and
  authenticated here, so any flag written today would be a guess in a security
  control. `none` is the honest declaration until that work is done, and the
  grade is what makes upgrading it a one-line change plus a conformance pass.
- **Un-register both adapters for the MVP.** Provably safe and smaller.
  Rejected: it removes a capability to fix a disclosure problem, and the
  adapters are still useful at `autonomous` — which is how the harness's own
  probe agents already run.
- **Warn instead of refusing.** Rejected. The whole failure is that the app
  *reported* a ceiling it did not apply; a warning beside a wrong number is
  still a wrong number, and this one is a safety control.
- **Clamp the hire to `autonomous` and say so.** Silently loosening a ceiling
  the Architect set is the one direction ADR-0012 forbids by construction.

## Consequences

- A `manual` or `supervised` hire on `codex` or `gemini` now fails at spawn with
  a message saying why and what to do. Loud, and at the earliest possible point.
- **The Ceilings panel's promise becomes true**: a level shown in the app is a
  level some engine actually applies, or the hire does not run.
- Upgrading an adapter is a declaration change plus a conformance run — the
  check is already written and will fail if the claim is wrong.
- The isolation half is **not** closed by this record. `codex` and `gemini` still
  read the operator's config directory, so an agent on either inherits whatever
  MCP servers and settings are there. That is owed, and it is now visible in the
  threat model rather than implied by M8.7's Claude-only evidence.
- `test/fakes/fake-adapter.ts` declares `enforced` and now carries `--autonomy`
  into the fake engine's argv, because the conformance check applies to it too.
  A fake that lies about a contract is a fake that hides the contract breaking.

## Prior art

[ADR-0026](ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md) — the lockdown this audits, and the
method for establishing engine behaviour.
[ADR-0012](ADR-0012-mission-profiles.md) — stricter-wins composition, which
produces the level being enforced here.
[ADR-0009](ADR-0009-engine-adapters.md) — the adapter contract and `HookSupport`,
the pattern this copies.
