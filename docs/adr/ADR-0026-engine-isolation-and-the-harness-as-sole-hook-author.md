# ADR-0026 — Engine isolation, and the harness as the only hook author

**Status:** accepted · **Date:** 2026-09-05 · **Extends:** ADR-0013, ADR-0009 ·
**Narrows:** ADR-0009's settings-file hygiene

## Context

Through M8.6 a hired agent ran **the Architect's personal engine install**. The
harness spawned `claude` with an environment that named no config directory, so
the engine resolved its own: the Architect's `~/.claude` and `~/.claude.json`.
Everything in there came with it — their global `CLAUDE.md`, fifteen enabled
plugins and the skills those carry, their MCP servers, and their hooks.

The cost half of that is real but **machine-specific**: a measured 64.8–67.4k
tokens at session start, of which Ephesus itself owned about 5%. That figure was
taken on a machine with an unusually large personal config and it must not be
the argument.

The control half is not machine-specific, and it falsifies a claim this system
already makes. [ADR-0013](ADR-0013-stop-hook-autonomy.md) names the engine's
Stop hook as **the** autonomy hinge: the agent finishes a turn, the hook asks
the harness, and the harness decides whether there is more work. On the measured
run **six Stop hooks fired per turn and five were not the harness's** — the
Architect's own, and the target repository's. Any of them may answer
`{"decision":"block","reason":…}`, which the engine treats as new input and the
agent keeps working. Such a continuation is:

- **uncounted** by the per-session block cap that exists to stop a runaway loop;
- **invisible** to the circuit breaker's stop-loop signal ([ADR-0011](ADR-0011-watch-breaker-budgets.md));
- **unaffected** by usage-aware pacing ([ADR-0023](ADR-0023-usage-aware-pacing.md)).

This is not hypothetical and it is not somebody else's repository. **This
repository** ships `.claude/settings.json` with a `Stop` hook that returns
`{"decision":"block"}` when typecheck is red — a good hook, written on purpose,
which nonetheless continues an agent the harness believed it had stopped. The
company's primary standing mission is to improve itself, so the first target any
crew is pointed at is the one that demonstrates the defect.

Two further first-run gates come with an inherited install, both of the class
[ADR-0021](ADR-0021-workspace-trust-at-activation.md) exists to close — an
interactive prompt that appears **before any session** and therefore fires no
hook, so nothing in the harness can see the agent parked on it:

- a repository's `.mcp.json` arrives as `⏸ Pending approval`;
- a config directory the engine has never seen starts at **onboarding**.

## Decision

Every hire runs its own engine install, and the harness is the only author of
the hooks that install runs.

1. **One engine config directory per agent**, at
   `~/.ephesus/engines/<engineId>/<agentId>/`, named by exactly one function
   (`engineConfigDir`) and carried on `AgentSpawnConfig.engineConfigDir` so
   every consumer reads it rather than recomputing it.
2. **The Architect's credentials are borrowed, not copied.**
   `CLAUDE_SECURESTORAGE_CONFIG_DIR` points at the Architect's real config
   directory while `CLAUDE_CONFIG_DIR` points at the agent's own.
3. **The harness is the only hook author.** The spawn carries
   `--setting-sources=` (no user, project or local settings are loaded at all)
   and `--settings <the harness's own file>`.
4. **The harness's settings file leaves the checkout.** It is written into the
   agent's own config directory, never into the Architect's repository or the
   agent's worktree.
5. **A fresh config directory is prepared before use** — `prepareConfigDir`
   records the onboarding the Architect has already completed on this machine.
   It writes one key in a directory the harness owns and records no consent
   about any workspace; ADR-0021's rule that consent to a *directory* is
   recorded only from an activation is untouched.
6. **Trust is recorded per (agent, directory).** With one config file per agent,
   "trust this path" is half an instruction; `plannedTrustGrants` supplies the
   other half. The target is granted to **every** hire, which is what ADR-0021
   decided and what used to happen for free when one file served everyone.

## Evidence

Established by execution on a real install, not by reading documentation:

| Experiment | Result |
|---|---|
| `CLAUDE_CONFIG_DIR=<fresh> claude auth status` | `loggedIn: false` — isolation alone parks every hire on a login prompt |
| the same, plus `CLAUDE_SECURESTORAGE_CONFIG_DIR=<architect's>` | `loggedIn: true`, `subscriptionType: max`, config still isolated |
| either | `projectsDirectory` reported **inside** the isolated directory |
| `CLAUDE_CODE_MANAGED_SETTINGS_PATH` + `allowManagedHooksOnly` (directory and file forms) | **ignored** in this host mode; foreign hooks still fired |
| `--settings <file>` alone | ours fires — and so do the user's and the repository's |
| `--setting-sources= --settings <file>` | **only ours fires** |
| repository `.mcp.json` under the lockdown | not loaded (without it: `⏸ Pending approval`) |
| the harness's **real composed spawn plan**, executed | harness hook fired; repository hook did not |
| the same plan with `--setting-sources=` removed | **repository hook fired** — the defect, reproduced |

The last two rows matter most. The claim is checked against the plan the adapter
actually produces, and removing exactly one flag from that plan brings the defect
back — so the check can fail, which is the property this codebase most often
lacks.

## Options considered

- **Managed settings with `allowManagedHooksOnly`.** The mechanism exists in the
  engine and is the obvious answer. It is gated to host modes this is not one
  of: pointing `CLAUDE_CODE_MANAGED_SETTINGS_PATH` at both a directory and a
  file left the setting inert and foreign hooks firing. Rejected on measurement.
- **Isolate the config directory and accept the repository's hooks.** Cheaper,
  and it fixes the cost half and the Architect's-personal-hooks half honestly.
  Rejected because it leaves the stated correctness hole open while sounding
  like it closed it.
- **A single company-wide config directory.** One directory to seed and audit.
  Rejected: the engine rewrites its config file wholesale from an in-memory
  copy — ADR-0021 already records that as a known limitation with one writer —
  and a crew is exactly the concurrent case.
- **The company holds its own login.** Cleaner spend accounting and a path to
  pointing the company at another account. Rejected for the MVP: an agent runs
  as the same OS user and can read the credentials file with a shell command
  whatever this sets, so it buys separability rather than containment, at the
  cost of one more setup cliff in the milestone about setup cliffs.
- **Keep writing `<cwd>/.claude/settings.local.json`.** Rejected: once the file
  is per-agent and outside every checkout, the backup, the restore and the
  reference counting between agents sharing a repository all become risk with
  nothing left to protect.

## Consequences

Stated here rather than discovered on a live run:

- **A target repository's hooks no longer run for hired agents.** In this
  repository that is `on-stop-check.sh` (the red-typecheck block) and
  `post-edit.sh`. If the company still wants those checks, the company must own
  them.
- **A repository's `.mcp.json` no longer reaches an agent** — and neither does
  the approval prompt that came with it.
- **A repository's skills and subagents are invisible to a hired agent**
  (measured). The Architect's decision is that the harness re-supplies a curated
  set per profile, through `--agents` and `--plugin-dir`, named in the hire
  template and shown at activation. **That is owed, not built** — it is M8.7b,
  and until it lands a crew working on this repository cannot reach
  `doc-guardian`, `spec-verifier`, or the `/build-package` family.
- Agents no longer inherit the Architect's global `CLAUDE.md`, plugins or
  skills. The token reduction is real on this machine and is **not** the reason
  for the change.
- `~/.ephesus/engines/` grows one directory per agent, holding that agent's
  transcripts. Reaping it belongs with decommissioning.

## Prior art

The engine's own evaluation harness seeds a config directory with
`hasCompletedOnboarding` before running unattended sessions, which is the
mechanism §5 uses and where its shape was read from.
