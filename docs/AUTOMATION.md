# Ephesus — Claude Code automation in this repository

**Status:** installed and active. This document records what automation exists, why
each piece was chosen, and what is deliberately deferred — so future sessions (and the
Gymnasium) can evolve it deliberately instead of rediscovering it.

Methodology: this setup was derived by applying the analysis of Anthropic's
[`claude-automation-recommender`](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-code-setup/skills/claude-automation-recommender)
skill (detect project signals → map to hooks / skills / subagents / plugins / MCP →
install the highest-impact items). Signals detected: a docs-first repo that becomes an
Electron + TypeScript app with npm scripts (`typecheck`/`lint`/`test`), Vitest,
Playwright, a strict standards document, a milestone build plan executed largely by
coding agents, and a GitHub-hosted workflow. Everything installed is **defensive**: it
no-ops cleanly until the M0.1 scaffold lands, then activates automatically.

## Installed

### Project memory
- **`CLAUDE.md`** (root) — loads into every Claude Code session here: subsystem map,
  doc precedence, invariants digest, commands, conventions, and the session-type
  triage (build vs improve vs docs).

### Hooks (`.claude/settings.json` + `.claude/hooks/`)
| Hook | Trigger | What it does |
|---|---|---|
| `post-edit.sh` | PostToolUse on Edit/Write | Auto-runs Prettier (+ ESLint `--fix` for TS) on the edited file. No-ops without `package.json`/`node_modules`. Removes an entire class of lint-fix commits. |
| `on-stop-check.sh` | Stop | If the session modified `.ts/.tsx` files and `npm run typecheck` is red, blocks the stop once with the failure log path — enforcing the standards' "green typecheck at every commit" at the *session* boundary. Respects `stop_hook_active`. |
| `.githooks/pre-commit` + `commit-msg` | Every `git commit` (via `core.hooksPath`, armed by `postinstall`) | Refuses a commit whose author, committer or trailers carry a Claude/Anthropic identity — ENGINEERING-STANDARDS §2. Not a Claude Code hook: it binds any client, including a human typing `git commit`. |

Also in `.claude/settings.json`: `"includeCoAuthoredBy": false` — Claude Code adds no
`Co-Authored-By: Claude` byline to commits or PRs. The trailer half of
ENGINEERING-STANDARDS §2; the hooks above cover the identity half.

### Skills (`.claude/skills/` — invoke as slash commands)
| Skill | Purpose |
|---|---|
| `/goal` | Drives the current milestone's run end-to-end: enforces the Architect's sole git authorship and per-package `feature/m<x>-<n>-<slug>` branches, loops `/build-package` through the milestone's packages, closes with `/milestone-review`. The milestone-run entry point (M3 as of 2026-08-27). |
| `/build-package` | Executes the next BUILD-PROMPT work package end-to-end with the verified loop; resumes from `docs/PROGRESS.md`. The default "keep building" entry point. |
| `/milestone-review` | Gate-keeps milestone completion: runs exit criteria and S-suites *by execution*, sweeps for stubs/debt, records the verdict. |
| `/doc-sync` | Audits code↔docs drift (module map, IPC surface, schemas, invariant tripwires) and fixes mechanical drift; escalates behavioral divergence. |
| `/improve` | Files a governed Gymnasium self-improvement proposal (evidence → single scoped change → success metric → gate). See ADR-0015. |
| `/research` | Runs one Stoa research cycle: studies ONE Architect-registered source from `docs/stoa/WATCHLIST.md` at a pinned commit and files a provenance-cited brief whose candidates feed `/improve`. See ADR-0017. |

### Subagents (`.claude/agents/`)
| Agent | Purpose |
|---|---|
| `doc-guardian` | Reviews diffs against the repo's *own* rules (invariants, prohibitions, SDD fidelity) before commit — a design-conformance reviewer, not a generic linter. |
| `spec-verifier` | Adversarially verifies "done" claims by running them; nothing gets ticked in PROGRESS.md on the implementer's word alone. |

### CI (`.github/workflows/ci.yml`)
- **Docs integrity** (active now): every relative markdown link must resolve; accepted
  ADRs are append-only (a PR touching an existing `ADR-*.md` fails).
- **Code checks** (self-arming): typecheck · lint · invariant tripwires · test (one run,
  under coverage) · coverage floors run automatically the moment `package.json` exists —
  the pipeline is green-by-absence before M0.1, never skipped after.
- **The seam rule** (M8.0, GYM-006; ENGINEERING-STANDARDS §6.7), two gates:
  `scripts/check-invariants.cjs` walks the import graph from the three entry points
  (`scripts/reachability.cjs`) and fails on any `src/**` module the app cannot load
  unless it is allowlisted with the decision that made the gap deliberate; and
  `scripts/check-coverage.cjs` fails on a per-subsystem coverage regression or a
  production module no test reaches, against `scripts/coverage-floors.json` — the one
  place a coverage figure is written, per platform, with its condition. The linux
  measurement is uploaded as an artifact on every run so linux floors are recorded from
  the CI condition (`--seed --from <artifact> --platform linux` for the first record,
  `--update --from` for every ratchet after it; `--update` cannot start a block).
- **Required status checks on `main` — APPLIED 2026-09-04.** `Typecheck · lint ·
  test`, `Docs integrity` and `Commit attribution` are required before a merge
  to `main`, with `strict` (a branch must be up to date first), force-pushes and
  deletions refused, and conversation resolution required.

  *A correction to the record:* the note here previously said the setting could
  not be applied because `gh api repos/.../branches/main/protection` "still
  answers 404". That 404 is GitHub's ordinary answer for **`Branch not
  protected`** — it was the absence of protection, not a refusal to grant it.
  The repository is public and the Architect holds admin, so nothing had been
  blocking it. Reading an API's normal empty answer as an error is the same
  mistake this repository keeps finding in its own matchers, and it cost the
  gates a milestone of teeth: PR #6 merged over a red code job on 2026-09-02,
  and three times during the M8 run a red suite skipped the coverage and
  reachability gates entirely because they run after the tests.

  `enforce_admins` is deliberately **off**: the Architect merges locally and
  pushes to `main`, and turning it on would force every change through a PR.
  What protection buys at this setting is that a *merge* cannot be completed
  over a red check without an explicit, recorded admin override.

  To verify or change it in the web UI: **Settings → Branches → Branch
  protection rules → `main`**. What is ticked:
  - ☑ Require status checks to pass before merging
    - ☑ Require branches to be up to date before merging
    - required checks: `Typecheck · lint · test`, `Docs integrity`,
      `Commit attribution`
  - ☑ Require conversation resolution before merging
  - ☐ Require a pull request before merging *(off — solo repository)*
  - ☐ Do not allow bypassing the above settings *(`enforce_admins`, off)*
  - ☐ Allow force pushes · ☐ Allow deletions

- **Recorded engine output** (`scripts/check-invariants.cjs`): every probe an
  engine adapter declares is backed by a real capture under
  `test/fixtures/engine-output/` with its provenance, or waived there in writing
  (ENGINEERING-STANDARDS §6.8). The waiver list is the visible debt: `codex` and
  `gemini` are unproven against a real CLI and are not shipped (ADR-0024).

- **Commit attribution**: `scripts/check-attribution.cjs` over the full history — no
  commit is authored, committed or co-authored as Claude (ENGINEERING-STANDARDS §2).
  The backstop for the local hooks, which `--no-verify` or an unarmed clone can miss.

## How this maps to the build process

A typical build session becomes: open repo → `/build-package` → hooks keep formatting
invisible → `doc-guardian` reviews the diff → `spec-verifier` confirms the evidence →
Stop hook refuses to end red → CI re-verifies → `/milestone-review` closes milestones →
friction observed along the way feeds `/improve`. The human Architect reviews verdicts
and Gymnasium proposals; everything else is mechanical.

## Deferred (revisit at the noted milestone — via `/improve` proposals)

| Item | When | Why deferred |
|---|---|---|
| GitHub MCP server for issue/PR-driven packages | When work starts flowing through GitHub issues | No issue workflow yet; CLI-driven for now |
| Playwright MCP / browser automation for visual verification of the floor | M0.4+ (floor exists) | Nothing to look at yet |
| PreToolUse protection hook (block edits to `docs/adr/ADR-*.md`, `LICENSE`) | If CI's append-only check proves insufficient | CI already enforces it at merge time; a local hook adds friction before it adds value |
| Packaging/release skill (`/release`: build, sign, changelog) | M7 | No packaging yet |
| Plugin-izing this setup for reuse across the Architect's repos | After the pattern stabilizes | Premature extraction |

## Change policy

This automation layer is itself Gymnasium territory: changes to hooks, skills, agents,
or CI go through `/improve` proposals with a measurable success metric (e.g. "Stop-hook
false-block rate zero across five sessions"), recorded in `docs/gymnasium/LEDGER.md`.
