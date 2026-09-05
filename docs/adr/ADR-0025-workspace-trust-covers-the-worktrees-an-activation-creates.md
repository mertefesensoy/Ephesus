# ADR-0025 — Workspace trust covers the worktrees an activation creates

**Status:** accepted · **Date:** 2026-09-05 · **Extends:** ADR-0021

## Context

[ADR-0021](ADR-0021-workspace-trust-at-activation.md) made the Architect's
activation the answer to Claude Code's first-run trust prompt, and drew the
scope deliberately tight:

> `trustWorkspace(cwd)` is called from a profile activation the Architect
> performed, **with that activation's own target**, and from nowhere else. It is
> never called from spawn, respawn, or a wake.

It also rejected an option by name:

> **Pre-trust at spawn rather than activation.** Simpler to wire, and wrong: it
> would trust a directory on every respawn and wake, long after the Architect
> had left, and would cover cwds no activation ever named.

M8.6 then made worktree isolation the default for profile hires (B10). Every
hire an activation creates now works in `<home>/worktrees/<agentId>`, not in the
target. Claude Code keys its trust record on the **exact** directory
(`claudeProjectKey` is a resolved path, matched literally), so trusting the
target grants nothing to any of them.

The consequence is the failure ADR-0021 exists to prevent, re-entered from the
other side: every isolated hire meets the first-run dialog, whose highlighted
default is `No, exit`; the dialog appears *before* a session exists, so no hook
fires and nothing in the harness can see it; the floor shows the agent as
spawned while it sits there for its whole life. That is the live MUSAHIT
outcome, exactly.

This was found by an adversarial audit of M8.6 rather than by a test, and it is
worth recording why the tests could not have found it: nothing related the
directory the trust record names to the directory the agent is spawned into.
`claude-trust.test.ts` only ever passed a bare directory, and no activation test
looked at `.claude.json` at all.

## Decision

**An activation trusts every directory its own hires will work in — the target,
and the worktrees that same activation is about to create.**

- **Still activation-time only.** `trustWorkspace` is called from
  `ProfileActivations`' `beforeHires` seam: after the plan is fixed, before the
  first process exists, and from nowhere else. ADR-0021's prohibition on
  calling it from spawn, respawn or a wake **stands unchanged** — a respawn
  re-uses a worktree an activation already trusted, and needs no grant of its
  own.
- **Derived from the plan, never re-derived.** `plannedWorkspaces(plan,
  worktreePathFor)` reads the same `ActivationPlan` object the hires are spawned
  from, and asks the same `worktreePathFor` the lifecycle spawns with. A second
  computation of "which directories will these agents use" is the drift that
  makes a trust record point at a path nothing reads — and the only symptom of
  that is a parked agent, which is precisely the invisible failure here.
- **The junction guard is kept where it can matter.** A worktree cannot be
  resolved through `realpath` before git creates it, so `will-be-created`
  resolves the **parent** and appends the leaf. The parent is
  `<home>/worktrees`, which the harness creates and owns; the leaf is a name the
  harness derives from an agent id. Neither is a path a target repository or a
  third party can influence, so nothing an attacker controls is left unresolved.
  The target keeps full `must-exist` resolution, unchanged.
- **The default is unchanged.** `trustWorkspace(cwd)` without an existence
  argument still means `must-exist`, so every caller and test written against
  ADR-0021 behaves exactly as before.
- **Still never silent.** Each grant appends its own `profile /
  workspace-trusted` event, now carrying the agents the directory is for and
  whether it existed yet. A failure is still a visible degradation, and it now
  names the agents that will park because of it.

## Options considered

- **Trust the worktree from `AgentManager.isolate`, where it certainly exists.**
  The obvious wiring, and it is the option ADR-0021 rejected by name: it fires on
  every respawn and wake, long after the Architect has gone, and would cover any
  cwd a bare `agents:spawn` names. Rejected on ADR-0021's own reasoning.
- **Create the worktree earlier so the target can be resolved in full.**
  `Worktrees.create` refuses a path that already exists, so pre-creating the
  directory would break isolation itself. Rejected.
- **Trust `<home>/worktrees` once and let it cover the children.** It does not:
  the engine matches the exact key, established by experiment in ADR-0021.
- **Narrow the target grant to activations that actually put a hire there.**
  Least-privilege, and tempting now that most hires are isolated — but it
  changes ADR-0021's decision rather than extending it, and it is not needed to
  fix this. Left alone deliberately; the target is still trusted. Recorded here
  as the obvious next narrowing if someone wants it.

## Consequences

- ADR-0021's accepted exposure is **widened in one specific way**: the engine's
  trust prompt is the only component that reviews a repo-committed
  `.claude/settings.json`, and it is now skipped for the worktree as well as for
  the target. Since a worktree is a checkout of the same commit, this grants
  nothing the target's own grant did not already grant. It is stated rather than
  left implicit.
- A grant is now written per isolated hire rather than once per activation, so
  `~/.claude.json` grows with the crew. The keys are stable across respawns
  (`worktreePathFor` is deterministic), so re-activating writes nothing new and
  the log says `alreadyTrusted`.
- A worktree removed at unwind leaves its key behind. Harmless — the key is
  re-used when the agent comes back on the same id — but it means the file
  accumulates entries for agents that no longer exist. No cleanup is defined
  here; ADR-0021's rule that this is the engine's file, not ours to prune,
  applies unchanged.
- Engines other than Claude are unaffected: `trustWorkspace` remains optional and
  unimplemented for codex and gemini, and the M4 verdicts for them still stand.

## Prior art

ADR-0021 (the decision this extends); ADR-0004 (the single committer, which is
why worktrees exist at all); ADR-0009 (adapters own engine-specific facts —
`WorkspaceExistence` is an adapter concern, and core never learns what a project
key looks like); ADR-0012 (declarative bundles: the plan is the disclosure, and
this reads the plan).
