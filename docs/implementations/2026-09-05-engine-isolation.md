# M8.7a — Engine isolation, and whose autonomy hinge it is

**Date:** 2026-09-05 · **Package:** B13 (M8.7, first half) · **ADR:**
[ADR-0026](../adr/ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md)

## Problem / motivation

A hired agent ran the Architect's personal engine install. The spawn named no
config directory, so the engine resolved its own — `~/.claude` and
`~/.claude.json` — and everything in there came with the agent: the Architect's
global `CLAUDE.md`, fifteen enabled plugins with their skills, their MCP
servers, and their hooks.

The token cost of that (a measured 64.8–67.4k at session start, ~5% of it
Ephesus's own) is **machine-specific** and is not the argument. The argument is
that it makes an existing claim false.

[ADR-0013](../adr/ADR-0013-stop-hook-autonomy.md) names the engine's Stop hook
as *the* autonomy hinge: the agent finishes a turn, the hook asks the harness,
the harness decides. On the measured run **six Stop hooks fired per turn and
five were not the harness's.** Any of them can answer
`{"decision":"block","reason":…}`, which the engine treats as new input — a
continuation that is uncounted by the block cap, invisible to the breaker's
stop-loop signal, and unaffected by pacing.

This is not a hypothetical about hostile repositories. **This repository** ships
`.claude/settings.json` with a `Stop` hook that blocks on a red typecheck. It is
a good hook. It also continues an agent the harness believed it had stopped, and
the company's primary standing mission points crews at this repository first.

## What changed

| File | Change |
|---|---|
| `src/main/engines/engine-home.ts` | **New.** The one function that names an engine's private per-agent directory. Engine-agnostic (NFR-12); refuses an id that could escape or collide rather than sanitising it. |
| `src/main/home.ts` | `engines/` joins the harness home's directories. |
| `src/main/engines/types.ts` | `AgentSpawnConfig.engineConfigDir`; `trustWorkspace` takes the config directory first; new `prepareConfigDir` and `probeEnv` on the adapter. |
| `src/main/engines/claude.ts` | `claudeCredentialsDir`, `prepareClaudeConfigDir`, `harnessSettingsPath`, `engineEnv`; the lockdown flags; transcripts and trust now hang off the config directory; the settings file leaves the checkout. |
| `src/main/agents.ts` | Required `engineConfigDirFor` option; the config directory is resolved once onto the spawn config; the directory is prepared (or the spawn refused) before hooks are installed; the auth probe runs in the agent's environment. |
| `src/main/index.ts` | One `engineConfigDirFor`, beside `worktreePathFor`; `beforeHires` walks `plannedTrustGrants`. |
| `src/shared/profile-activation.ts` | `PlannedWorkspace.kind`; new pure `plannedTrustGrants`. |
| `test/main/engines/engine-isolation.test.ts` | **New**, 14 cases: the directory, the credentials, the lockdown, the seeding, and the four producer/consumer pairs. |
| `test/conformance/adapter-conformance.ts`, `engine-adapters.test.ts` | `settingsRoot` — the hygiene contract now distinguishes "a gitignored variant in somebody else's repository" from "our own per-agent directory", and checks the stronger claim for the latter. |
| `test/main/agents.test.ts`, `profile-activation.test.ts`, and six fixtures | Assertions moved to the new contract, upgraded where it is stronger. |

## Implementation approach

**The engine config directory is a value carried on the spawn config, not a
computation repeated at each use.** `engineConfigDir(root, engineId, agentId)`
is the only expression that names it; `AgentSpawnConfig.engineConfigDir` carries
the result. That matters because moving the directory moves four things at once,
and each is a producer/consumer pair that would otherwise agree only until one
half was edited:

1. **The spawn environment** — `CLAUDE_CONFIG_DIR` (the agent's own install) and
   `CLAUDE_SECURESTORAGE_CONFIG_DIR` (the Architect's credentials, borrowed).
2. **The transcript reader** — the engine puts `projects/` inside whichever
   config directory it was given. A reader still computing
   `$HOME/.claude/projects` finds nothing, folds a permanent zero, and
   `budgets.foldOne` still reports the `engine` tier: silent spend
   under-reporting, the class ADR-0011 exists to close.
3. **The workspace trust record** — it lives in `<configDir>/.claude.json`, so
   writing it to the Architect's home records consent in a file no isolated
   agent opens. The only symptom would be the trust dialog reappearing: a hung
   agent, again, which is what ADR-0025 has just finished fixing from the other
   side.
4. **The auth probe** — run in the agent's environment via `probeEnv`, which
   returns the *same expression* the spawn environment uses.

Pair 4 is equivalent to the old behaviour **today**, because the company borrows
the Architect's credentials. It is written this way because the equivalence is a
coincidence of one Architect decision, and the failure it would hide — an agent
spawning `running` onto a login prompt — is exactly what M8.4's probe was added
to prevent.

**The lockdown is two flags on the harness's own argv.** `--setting-sources=`
loads no user, project or local settings; `--settings <file>` supplies the
harness's. The attached empty value (`--setting-sources=`, one token) is
deliberate: a bare `''` argv element is one that Windows command-line
composition may drop on the way to conpty, and a dropped lockdown flag is a
check that cannot fail. A test asserts the rule over the whole vector — no argv
element the harness produces is the empty string — so a later flag cannot
reintroduce the hazard.

**The settings file left the checkout.** It is
`<configDir>/eph-settings.json`. The backup, the restore and the reference
counting in `settings-install.ts` existed because the file used to be
`<cwd>/.claude/settings.local.json` — a file inside somebody else's repository,
shared by every agent working there. That machinery still runs, and now it
protects a per-agent file the harness owns, so its hardest case simply cannot
arise. The conformance suite records the upgrade rather than dropping the old
rule: an adapter declaring `settingsRoot: 'cwd'` must still write only
gitignored variants; one declaring `engineConfigDir` must leave the checkout
byte-identical **throughout**, not merely restore it afterwards.

**A fresh config directory is prepared before it is used.** The engine's startup
branches on `hasCompletedOnboarding`, and onboarding is interactive and runs
before any session — so no hook fires and nothing here could see an agent parked
on it. `prepareClaudeConfigDir` writes that one key, additively and atomically,
into a directory the harness owns. It records no consent about any workspace, so
ADR-0021's rule that directory consent comes only from an activation is
untouched. A directory that cannot be prepared **refuses the spawn** rather than
producing an agent that looks `running`.

**Trust became a per-(agent, directory) grant.** With one config file per agent,
"trust this path" is half an instruction. `plannedTrustGrants` supplies the
other half, derived from `plannedWorkspaces` rather than from the plan a second
time. The target is granted to *every* hire — that is ADR-0021's decision
unchanged, which used to happen for free because one file served everyone;
narrowing it to "only the hires that land there" would have been a new decision
taken silently in the commit that split the file.

## Verification

Every claim below was produced by running something.

**Ground truth, established before any code was written** (the engine's own
answers, not documentation):

```bash
CLAUDE_CONFIG_DIR=<fresh> claude auth status
#   loggedIn: false        <- isolation alone parks every hire on a login prompt
CLAUDE_CONFIG_DIR=<fresh> CLAUDE_SECURESTORAGE_CONFIG_DIR=~/.claude claude auth status
#   loggedIn: true, subscriptionType: max, projectsDirectory inside <fresh>
```

`CLAUDE_CODE_MANAGED_SETTINGS_PATH` with `allowManagedHooksOnly: true` — the
obvious mechanism, and the one the engine's own strings describe — was tested in
both its directory and file forms and is **inert in this host mode**: foreign
hooks still fired. That is why the decision rests on the CLI flags.

**End-to-end, against the adapter's real composed spawn plan.** A scratch
harness bundled `ClaudeAdapter` with esbuild, composed a spawn for
`agent.mason` into a repository carrying its own `Stop` hook, installed the
plan's settings, and executed the resulting argv and environment:

```
harness hook fired?  true
repo    hook fired?  false
```

**The refutation control** — the identical plan with exactly one flag removed:

```
harness hook fired?  true
repo    hook fired?  true      <- the defect, reproduced
```

The gate, on `feature/m8-7-engine-isolation`:

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage -- --coverage.reportsDirectory=coverage/m87
node scripts/check-coverage.cjs --summary coverage/m87/coverage-summary.json
```

- typecheck: green across all four projects
- lint: zero warnings, prettier clean
- invariants: ok — reachability **168/176** (`engine-home.ts` is reached)
- tests: **3678 passed / 8 skipped** across 193 files
- coverage floors: ok, none lowered (several subsystems now sit *above* their
  floor; ratcheting them is deliberately left for a separate three-run window,
  since a `src/**` change resets it)

## Design decisions

Four were the Architect's, taken 2026-09-05 with the options and their costs on
the table. They are recorded in ADR-0026 §Options considered with the reasoning;
in brief: **one config directory per agent** (not per company — the engine
rewrites its config file wholesale and a crew is the concurrent case);
**lockdown** (not isolation-only, which would have sounded like it closed the
correctness hole); **shared credentials** (an agent runs as the same OS user and
can read the credentials file regardless, so a separate one buys accounting, not
containment); and **the harness re-supplies a curated tool set per profile**
rather than leaving repository skills hidden.

## Owed, and stated rather than discovered

- **M8.7b is not built.** Repository skills and subagents are invisible to a
  hired agent — measured, not assumed. The Architect chose that the harness
  re-supply a curated set per profile via `--agents` and `--plugin-dir`, named
  in the hire template and shown at activation. Until it lands, a crew working
  in this repository cannot reach `doc-guardian`, `spec-verifier`, or the
  `/build-package` family.
- **This repository's own hooks no longer run for hired agents** —
  `on-stop-check.sh` and `post-edit.sh`. If the company still wants those
  checks, the company must own them.
- **Noticed in passing, since fixed:** the engine warned that the mailbox grant's
  `Write(<dir>/**)` allow-rule "is not matched by file permission checks — only
  `Edit(...)`". Closed in
  [2026-09-05-mailbox-grant-rule-shape.md](2026-09-05-mailbox-grant-rule-shape.md):
  the engine matches file rules by exact tool name and only ever looks up `Edit`
  and `Read`, so five of the grant's seven rules were inert. The outbox write
  itself was never broken — `Edit` was already in the list — but the grant is now
  the two rules that carry it, and a test refuses any rule the matcher ignores.
- `~/.ephesus/engines/` grows one directory per agent, holding that agent's
  transcripts. Reaping it belongs with decommissioning.

## Related docs

- [ADR-0026](../adr/ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md) — the decision and its evidence
- [ADR-0013](../adr/ADR-0013-stop-hook-autonomy.md) — the claim this restores
- [ADR-0021](../adr/ADR-0021-workspace-trust-at-activation.md) · [ADR-0025](../adr/ADR-0025-workspace-trust-covers-the-worktrees-an-activation-creates.md) — workspace trust
- [ADR-0009](../adr/ADR-0009-engine-adapters.md) — adapters own engine specifics; settings hygiene
- [`docs/PROGRESS.md`](../PROGRESS.md) — M8.7
