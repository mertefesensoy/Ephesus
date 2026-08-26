# ADR-0012 — Mission profiles as declarative, versioned bundles

**Status:** accepted · **Date:** 2026-08-26

## Context
The two headline missions — Skeleton Crew (keep my apps alive) and Front Office (run my
project's outward operations) — are recurring *configurations* of the same primitives:
roles, schedules, playbooks, integrations, budgets, autonomy levels. Hardcoding either
as features would fork the codebase per mission and make the third mission (whatever
the Architect invents next) a feature request instead of a config file.

## Decision
A **mission profile** is a declarative, versioned bundle of files:

```
profiles/<name>/
  profile.json        # name, version, target binding (repo/app), autonomy levels
  hires/*.json        # role templates: engine, prompt, skills, env grants, budget
  triggers/*.json     # schedules (cron-like) + event bindings (webhook, CI, health)
  playbooks/*.md      # runbooks agents follow (incident response, release prep, …)
  memo-policy.json    # which action classes require decision memos (feeds ADR-0008)
  harbor.json         # integration wiring: repos, channels, webhook endpoints
```

- Activation instantiates the hires as agents bound to a **target** (a repo/app); the
  same profile can be activated per-target multiple times; multiple profiles coexist
  on one floor (FR-9.4).
- **Playbooks are prose, policy is data.** Judgment lives in markdown runbooks agents
  read; anything mechanically enforced (autonomy levels, memo triggers, budgets, env
  grants) lives in JSON the harness reads. The same split as ADR-0005.
- Skeleton Crew and Front Office ship **built-in as ordinary profiles** — they exercise
  no private APIs, proving the format is sufficient (dogfood rule; NFR-12).
- Profiles are shareable like hires (export/import; import pre-fills, human confirms
  activation), and diffable in review since they're plain files.

## Options considered
- **Hardcoded mission features.** Faster to first demo, then permanent bifurcation.
- **Full workflow DSL.** Overshoots: the variable part of a mission is judgment
  (playbooks) and wiring (JSON); control flow stays in the agents and the ledger.
- **Profiles as code (TS plugins).** Maximum power, but breaks inspectability ("read
  what this profile may do before activating") and the safety review story.

## Consequences
- The profile schema becomes a public contract; it is versioned (`profile.json:
  schemaVersion`) with a migration path from day one.
- Autonomy levels defined per-profile must compose with global Watch defaults: the
  *stricter* setting always wins (deny-by-default, FR-11.1).
- The org layer (UC-12) edits hire templates *inside* profiles, so profile versioning
  doubles as the performance-review changelog.
