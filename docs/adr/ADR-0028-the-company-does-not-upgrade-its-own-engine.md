# ADR-0028 — The company does not upgrade its own engine

**Status:** accepted · **Date:** 2026-09-06 · **Extends:** ADR-0026 (engine isolation) ·
**Relates to:** ADR-0024 (Claude only for the MVP)

## Context

[ADR-0026](ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md) gave every agent its
own `CLAUDE_CONFIG_DIR`, so an agent's memory file, plugins, skills, MCP servers, hooks and
transcripts are its own. What it did **not** separate — because it cannot be separated — is the
engine **binary**. Every agent in the company executes the same install.

The engine ships with a background self-updater, on by default, that replaces that binary in place.
This was found in the on-call agent's own engine config during the 2026-09-06 run:

```json
{"timestamp":"2026-09-05T19:10:44.181Z","path":"npm-global","outcome":"failed",
 "status":"install_failed","version_from":"2.1.252","version_to":"2.1.261",
 "error_code":"update_apply_exe_locked"}
```

`update_apply_exe_locked` is what it says. On Windows a running executable cannot be replaced, and
this company runs up to 30 of them. The update is therefore not a rare race but the expected
outcome under load: one agent wins, every other agent's attempt fails, each failure is recorded,
and each records a retry at its next startup. A version change also lands **mid-run**, so agents
hired by one activation can end up split across two engine versions with nothing in the book of
record saying so.

The concrete costs, in the order they bite:

1. **A failed update is durable.** The record sits in the agent's config directory and the attempt
   repeats. Nothing in the harness reads it, so a company can carry a permanently failing update
   across restarts and no degradation is raised.
2. **A successful update is worse in one respect than a failed one.** It changes, without a
   decision, the argv contract, hook protocol, settings schema and TUI behaviour that
   `src/main/engines/claude.ts` is written against — the surfaces this repository has a standing
   rule about never guessing.
3. **Neither is visible.** The company that changed underneath the harness looks identical to the
   one that did not.

The general principle this is an instance of: **the harness owns the environment its agents run
in.** Prompts live in `prompts/`, settings are written by the harness alone (ADR-0026), tools are
granted by name (M8.7b), secrets are injected and never inherited (ADR-0010). An agent process
rewriting the binary that every agent executes is the one remaining hole in that.

## Decision

**Harness-spawned agents never auto-update the engine.** `DISABLE_AUTOUPDATER=1` is exported into
every agent's spawn environment by the adapter's `engineEnv`, which is the same expression the auth
probe reads — so the probe and the spawn cannot disagree about the environment they are describing.

Engine upgrades are the Architect's, performed deliberately between runs, against a version this
repository's adapter has been read against.

Three details carry weight:

- **The env var, not the settings key.** Established from the shipped binary rather than assumed:
  the engine reads `DISABLE_AUTOUPDATER` straight from `process.env`, before any config is
  consulted, and short-circuits the updater outright. The `autoUpdates: false` settings key was
  refuted — the binary's own text scopes it to *background* updates only and further conditions it
  on `installMethod`, so it would have left the startup path live while reading, in our settings
  file, as though the matter were settled. One unconditional mechanism beats two that half-overlap.
- **It outranks a grant.** `engineEnv` is spread *after* `cfg.envGrants` in the spawn environment.
  A grant is a value the Architect chose for one agent; this is a decision the harness makes for
  the whole company, and one agent's grant must not be able to reopen it. Object-literal order is a
  fragile place to keep a rule, so a test pins the precedence rather than leaving it to be read.
- **It is not a version pin.** The company runs whatever install is on the machine. This decision
  only removes the agent's ability to change it.

## Consequences

**An agent can now be running an engine older than the newest release, indefinitely.** That is the
intended trade: a known version the adapter was written against beats an unknown one that arrived
without a decision. Nothing in the harness nags about it, and nothing should — an upgrade prompt
that fires during a run is the beginning of the same problem.

**A stale `.last-update-result.json` in an agent's config directory is now inert.** The updater
never runs, so the record is history rather than a pending retry. It is left in place; deleting
another process's bookkeeping buys nothing and loses evidence.

**Nothing tells the Architect the engine is behind.** Deliberately not solved here. A version-drift
report belongs with the other health surfaces, raised where degradations are raised, and is a
Gymnasium proposal rather than a spawn-path change.

**This decision did not fix a hang.** The run that produced it initially read a 89-byte agent
terminal as an engine hanging at startup, and the failed-update record as its cause. Both readings
were wrong — the agent was refused a worktree and, once spawned, was waiting at the workspace-trust
dialog. The decision stands on its own argument, not on that evidence, and is recorded that way so
a later reader does not inherit the wrong reason for a right rule.

## Alternatives considered

**Let each agent update itself (the default).** Rejected: it is many processes racing over one
file, it changes the adapter's contract mid-run, and it is invisible either way.

**Pin an exact engine version and install it per agent.** Rejected for the MVP. It would make the
version explicit, which is the right long-run answer, but it multiplies a ~220 MB install by the
number of agents and contradicts ADR-0026's decision to isolate configuration while sharing the
install. Revisit if engine version drift ever causes a real incident.

**Let the harness perform the update itself, between runs, when no agent is up.** The likely
successor to this decision, and out of scope now: it needs a place to decide *when*, a way to
verify the adapter still matches, and somewhere to report the result. Recorded as the direction
rather than deferred silently.

**Read `.last-update-result.json` and raise a degradation.** Rejected as a fix — it reports the
symptom while leaving every agent still racing. It remains reasonable as a *diagnostic* once the
harness owns upgrades.
