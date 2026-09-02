# The crew's own runbook forbade the thing §6.1 asks it to do

## Problem / motivation

SRS §6.1 requires a crew that detects a broken test and **"fixes it or opens a
fix PR"**, unattended, inside an hour. The Skeleton Crew's incident runbook said:

> These require approval before you do them, every time:
> - opening a pull request
> …
> Propose the action and wait.

Unattended, nobody answers. The agent patches locally, proposes, and waits out
the hour — which is close to what the 2026-09-01 live run did. No amount of
harness work fixes that, because the prose is what the agent obeys.

**The Architect ruled on 2026-09-02: the crew may open pull requests without
per-action approval.** This implements that ruling and nothing wider.

## What changed

Six files — three shipped, three in the harness home, because
`src/main/profiles.ts:32` designates `<harness home>/profiles/` as "what the
Architect edits" and lists it FIRST. A home bundle **permanently shadows** the
built-in (`profiles.ts:70-77`, `if (seen.has(name)) continue`), so a repo-only
edit would have changed nothing for a live run on this machine.

| File | Change |
|---|---|
| `profiles/skeleton-crew/playbooks/incident.md` | §5 Gates: PR-opening released; the other five bans kept, with the principle that separates them. |
| `profiles/skeleton-crew/hires/ci-babysitter.json` | The `brief` carried its own copy of the gate. |
| `profiles/skeleton-crew/playbooks/dependency-update.md` | The one bullet gating the PR; the memo bullets around it untouched. |
| `~/.ephesus/profiles/skeleton-crew/…` | The same three, edited in place rather than overwritten. |

**The `brief` is the one that mattered most.** `src/main/agents.ts:660-661`
appends it to `identity.md`, and `prompts/engines/identity-appendix.md:11`
injects that as `--append-system-prompt`. Editing only the playbook would have
left the old rule in the **system prompt**, contradicting the runbook the agent
reads off disk — and the system prompt is the one that wins. That file was not
in the original problem report; it was found by searching for the rule rather
than for the file.

## Implementation approach

### What was released, and what was not

Released: pushing the agent's own `agent/*` branch, and opening a PR from it.
Both are required — an agent that cannot push its branch cannot open a PR at all.

Kept, verbatim: pushing to a branch someone else builds on, force-pushing,
deleting a branch, anything touching production, adding a dependency.

The runbook now states the line rather than listing it, because a list invites
an agent to reason by analogy about the next case:

> The line between the two is whether the Architect can still change their mind
> afterwards. A PR they can close costs them a moment; a force-push over history
> they have not read costs them work they cannot get back.

### Deliberately NOT changed

- `profiles/skeleton-crew/playbooks/health-check.md:38-39` — "do not open a pull
  request" there is a **role boundary**, not an approval gate: the health-watcher
  is a read-only sweep with `envGrants: []` and no credential to push with.
  Removing it would widen the ruling from "the crew may open PRs" to "every hire
  may". §6.1 is satisfied by the ci-babysitter alone.
- `profiles/skeleton-crew/hires/dependency-updater.json` — gates *adding a
  dependency*, which the ruling does not cover.
- `profiles/front-office/**` — a different profile that ships `supervised` with
  five kinds at `manual`, deliberately cautious. The ruling named the crew. This
  is the pair of files a careless grep across `profiles/**` would have swept up.
- `prompts/agora/PROTOCOL.md:121-123` — the company-wide catch-all for spend and
  destruction. It does not name PR-opening, so it needed no edit, and it is the
  last prose backstop across every profile.

## Design decisions

### The prose is the only enforcement, and that is a finding

Before removing a guard it is worth knowing what remains. **Nothing does.**
Verified three ways rather than assumed:

1. **Nothing classifies the acts.** The only classifier on the agent tool stream
   is `matchMemoTrigger` (`src/main/watch/gates.ts:526`), and the crew's memo
   policy declares `new-dependency`, `api-or-schema-change`, `security-posture`,
   `spend` — no kind a `git push --force` or a branch deletion could match.
2. **The `destructive` gate kind has no production submit site.** One
   non-comment occurrence in `src/main`, in `herald/policy.ts`, which is the
   DEFERRED Herald.
3. **An opened trigger would not stop the call anyway.** `recordSpan`
   (`src/main/index.ts:540-556`) calls `submitMemoTrigger` and discards the
   result, returning `void` on the `pre-tool` branch.

So the five remaining bans rest on the agent reading its runbook and complying.
That was equally true before this change — releasing one line neither adds nor
removes machine enforcement — but it means **the gate ladder does not currently
back the runbook for git actions**, and an unattended run relies on prose. That
is recorded here and raised to the Architect; it is not fixed in this change,
because building a classifier for the tool stream is a work package, not a
paragraph.

### A stale home bundle is the second half of the same problem

The home copy of `incident.md` was an older seed than the repo's — missing the
`rootCause` block and the verifier-refutation prose. The bundles never re-seed
by design, so the crew has been running an **older runbook than the repository
contains**. The same shape already bit `PROTOCOL.md`, whose materialized copy
lacks the `$EPH_GH_TOKEN` paragraph — so a crew agent newly permitted to open a
PR will hit a 401 an hour in and, per its own protocol, conclude it lacks
permission. That would look exactly like this ruling failing to take effect.
Both are raised separately; only the gate clauses were touched here.

## Verification

```bash
npx vitest run --no-file-parallelism test/scenarios/s-profile.test.ts test/scenarios/s-onehour.test.ts
```

- Profile and scenario suites: **67 passed**. Full suite green.
- No PR gate survives anywhere in the crew, repo or home — checked by grep over
  both trees.
- The three home copies are byte-identical to the repo copies for every clause
  changed, checked field-by-field rather than by eye. (The first attempt at the
  home edit silently lost a backtick-quoted `agent/*` to shell substitution; the
  diff caught it, which is why the check is a diff and not a success message.)
- Front-office still carries its two gates, deliberately.

No test asserts on this prose, so nothing needed updating — that is itself worth
noting: the runbook that decides what an agent may do is not covered by anything.

## Related docs

- `docs/srs/SRS.md` §6.1 — the run this unblocks
- `docs/adr/ADR-0012-mission-profiles.md` — profile bundles and autonomy composition
- `docs/PROGRESS.md` — the M7 exit gaps
