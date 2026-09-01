# The attribution tripwire learns the second rule: where the company may author

**Date:** 2026-09-01 · **Branch:** `claude/suspicious-jepsen-d9120f` (from `main` at
`bd91ca9`) · **Closes:** ADR-0020's "Enforcement follows the rule", recorded by
ADR-0022 as still owed.

## Problem / motivation

ADR-0020 §Decision, *Enforcement follows the rule*, promised a code change:

> `scripts/check-attribution.cjs` today asserts "no Claude/Anthropic identity" and
> "Architect authors everything"; the first clause is unchanged and the second gains
> one carve-out — company-account authorship is legal **only** on `agent/*` branches.
> A company-account commit on `main` that did not arrive by an Architect-merged PR
> fails the job.

ADR-0022 then corrected the identity (a GitHub App bot, not a machine user) and
recorded the enforcement as *"Still owed, and not delivered here… It cannot fire until
agents commit, so it is recorded as owed rather than half-built."*

The gap that leaves is precise, and it is not the one the script's name suggests. The
check bans **Claude and Anthropic** identities — `CLAUDE_NAME`, `ANTHROPIC_EMAIL`, and
the `Claude-Session:` trailer — and asserts **nothing whatever about who else may
author**. A commit authored `ephesus-crew[bot]
<2140077+ephesus-crew[bot]@users.noreply.github.com>`, pushed straight onto `main`,
passed the job silently, anywhere in history. The prose in ENGINEERING-STANDARDS §2
said the company "never authors on `main` except through an Architect-merged PR" and
nothing in the repository could tell whether that was true.

That gap is wider than it looks right now, because of what the M6 close-out found and
recorded on 2026-08-30: **`main` is not actually branch-protected** (`gh api
…/branches/main/protection` → `404 Branch not protected`). The server-side control that
was supposed to make the company *unable* to push to `main` is off. So this check is
not a belt beside a brace — today it is the only mechanism of the two that exists.

## What changed

| File | Change |
|---|---|
| `scripts/check-attribution.cjs` | Second rule added: a company (`[bot]`) identity is refused on `main`'s first-parent chain (history mode) and on any non-`agent/*` branch (pending mode). Header rewritten to state what the rule catches and what it provably cannot. Pure predicates and `main(argv)` exported; the CLI tail is guarded by `require.main === module`. Claude/Anthropic clauses byte-for-byte unchanged in behaviour. |
| `test/scripts/check-attribution.test.ts` | **New.** 28 cases — the predicates called directly, the rules exercised against real git in temp repositories through a spawned process. |
| `docs/ENGINEERING-STANDARDS.md` | §2's "the attribution check gains exactly this carve-out when FR-10.5 lands (M7) — until then the original rule is the enforced one" replaced with what is now enforced, and its two named limits. |
| `docs/DECISIONS-LOG.md` | Two rows: the first-parent proxy, and the decision to match the bot by form rather than by configured slug. |

## Implementation approach

### The honest problem: git does not record branches

ADR-0020's rule is stated in terms of branches — legal on `agent/*`, illegal on
`main`. A commit object holds author, committer, message, tree and parents. **It holds
no branch name.** A branch is a moving pointer; by the time CI reads a history, the
name the commit was made under is not merely unavailable, it may never have existed as
a durable fact at all (the branch can be deleted, renamed, or created after the fact).

So a check that claims to enforce "authored on `agent/*`" over a history would be
claiming to read something that is not written down. The design had to start by
deciding what *is* detectable, and then say so out loud rather than implying the rule
it could not reach.

### What is detectable: the first-parent chain

`main`'s **first-parent chain** — `git rev-list --first-parent main` — contains exactly
two kinds of commit:

1. commits made directly on `main`, and
2. merge commits.

Work merged from a branch hangs off the **second** parent and is therefore *not* on the
chain. That gives an observable proposition standing in for the unobservable one:

> A company identity on `main`'s first-parent chain was **put on the trunk**, not
> merged into it.

which is the fault ADR-0020 names. A bot-authored *merge* commit fails the same test,
and that is the right answer too: it is the company merging its own pull request.

On this repository the proxy is not approximate — it is exact — because every landing
so far is a real merge commit: 88 commits on `main`'s first-parent chain out of 150
reachable.

### What pending mode can do that history mode cannot

The `.githooks/` pre-commit path runs at the one moment a branch name genuinely exists:
`git symbolic-ref --quiet --short HEAD`. So pending mode enforces the **literal** rule —
a company identity on anything but `agent/<name>/<topic>` is refused — while history
mode enforces the proxy. The two clauses are deliberately not the same clause, and the
header says which is which.

A detached HEAD has no branch to vouch for it, so it **fails closed**. This costs the
Architect nothing: the clause only fires for a `[bot]` identity, and the Architect is
never one.

### Recognising the company by form, not by name

`botIdentity(slug, userId)` in `src/shared/github-app.ts` mints
`<slug>[bot]` / `<numeric id>+<slug>[bot]@users.noreply.github.com`. The slug lives in
`<harness home>/github-app.json` — harness state this repository cannot read, and which
CI certainly does not have. Two options:

- **Read a configured slug** (env var, checked-in constant). Rejected: CI would not set
  it, so the clause would be *strongest on the developer's laptop and absent in the one
  place it is a gate*. A check that silently does nothing in CI is worse than no check.
- **Match the form.** `/\[bot\]$/` on the name, or the noreply address GitHub actually
  resolves. Chosen.

Matching the form makes the rule a superset: `dependabot[bot]` on the trunk chain fails
too. That is deliberate and it is the correct generalisation — no automated identity has
business landing on `main` outside review. In practice bots arrive by PR merge, so they
sit off the first-parent chain and pass.

The email pattern is anchored on purpose: `^\d+\+…\[bot\]@users\.noreply\.github\.com$`.
ADR-0022 records that ADR-0020's original address, `ephesus-crew+agent.mason@…`, credits
nobody, because GitHub resolves only `<numeric id>+<login>@…`. The check declines to
recognise the broken form as a company identity — it is not one, and treating it as one
would put a fault on a commit that credits no account at all.

## Design decisions

| Decision | Alternative | Why |
|---|---|---|
| Fault on the **first-parent chain of `main`** | Fault on *every* bot commit reachable from HEAD | That bans the carve-out ADR-0020 exists to grant. Agent work on `agent/*` is legal; it becomes reachable from `main` the moment it merges. |
| Author **and** committer both checked | Author only | ADR-0020's concern is the company landing work on the trunk. A harness that pushed "the Architect's patch" with the bot as committer would be doing exactly that, and an author-only check waves it through. |
| Trailers **not** checked for bot addresses | Extend the co-author scan | ADR-0022 makes `Co-authored-by: mason <…[bot]@…>` the *sanctioned* per-agent signature. Faulting it would break the design it enforces. The Claude/Anthropic trailer scan is untouched. |
| Skip the clause when no `main` ref resolves, and **print the skip** | Fail, or pass silently | Failing breaks legitimate single-branch checkouts. Passing silently is invariant §7's exact prohibition — a degradation nobody can see. The success line names it: `company-on-main NOT checked`. |
| `refs/heads/main`, then `refs/remotes/origin/main` | `refs/heads/main` only | `actions/checkout@v4` with `fetch-depth: 0` fetches all branches into `refs/remotes/origin/*` and may leave HEAD detached on a PR merge ref. Without the fallback the CI job would skip its own clause on every pull request. Covered by a test. |

### What this check does NOT verify — and the header says so

The script's header states each of these in the file itself, so that the next reader
learns the limits from the code rather than from this document:

- **It does not verify that any human reviewed the merge.** It reads the *shape* of the
  history, not the authority behind it. Review is branch protection's job — currently
  off, per the 2026-08-30 log entry.
- **It does not know the source branch of merged work.** History mode cannot tell an
  `agent/*` branch from a `feature/*` one, only that the work arrived by a merge.
- **It does not survive a squash or rebase merge.** Both replay the bot's authorship
  directly onto the first-parent chain, so a properly reviewed agent PR merged either
  way *would* be flagged — a false positive. This repository merges with merge commits,
  which is what makes the proxy exact here; **change the merge policy and this clause
  must change with it.** That coupling is the single most important thing to know
  before touching either.

## Verification

```bash
node scripts/check-attribution.cjs && npm run lint && npx vitest run
```

Observed on this branch:

| Gate | Result |
|---|---|
| `node scripts/check-attribution.cjs` | `attribution ok (150 commit(s) reachable from HEAD; 88 on refs/heads/main's first-parent chain)` |
| `node scripts/check-attribution.cjs --pending` | `attribution ok (pending identity on branch claude/suspicious-jepsen-d9120f)` |
| `node scripts/check-invariants.cjs` | `invariants ok (src, shims, scripts, test)` |
| `npm run lint` | clean — eslint 0 warnings, prettier "All matched files use Prettier code style!" |
| `npm run typecheck` | clean, all four projects |
| `npx vitest run test/scripts/check-attribution.test.ts` | **28 passed**, stable over 5 consecutive runs |

### The suite was mutation-checked, because a green suite proves nothing on its own

The M6 close-out's lesson (eighteen of twenty-two mutations survived) is that a passing
suite looks identical whether or not it can fail. Four mutations, each killed:

| Mutation | Killed |
|---|---|
| Trunk clause never contributes a failure (`[...failures, ...trunk.failures]` → `[...failures]`) | 4 cases |
| Pending mode accepts any named branch (`AGENT_BRANCH.test(branch)` dropped) | 3 cases |
| Bot-email anchor dropped (`^\d+\+…$` → `@users.noreply.github.com$`) | 1 case |
| Bot-name suffix anchor dropped (`/\[bot\]$/` → `/\[bot\]/`) | 1 case |

### Full-suite impact

The repository has a long-standing set of Windows-local flaky failures (process-spawn
heavy git and scenario suites), recorded at the M6 close-out as "the recorded
Windows-local baseline". Four full runs on the same tree, measured to check this
change adds none:

| Run | Failures | Files | New file present? |
|---|---|---|---|
| Full suite **excluding** `test/scripts/**` (baseline) | 19 | 11 | no |
| Full suite, run 1 | 15 | 9 | yes — passed |
| Full suite, run 2 | 20 | 11 | yes — passed |
| Full suite, run 3 | 21 | 11 | yes — passed |

The count moves between 15 and 21 across identical trees, and the *set* of failing
files moves with it (`s-mode`, `library`, `hermes`, `agora` each appear in one run and
not another). That scatter is the signature of load-dependent flakiness, not of a
regression, and it is why a single run of this suite is not evidence of anything.

What is stable across all three: **`test/scripts/check-attribution.test.ts` appears in
no failure set**, and none of the pre-existing failing files imports or executes
`scripts/check-attribution.cjs`.

This is the recorded Windows-local baseline, not a green suite. It was already red
before this change and it is still red; closing it is not in this change's scope, and
claiming otherwise would misreport the state of the tree.

An earlier draft of the test file *was* flaky (7–8s cases against vitest's 5s default,
different cases failing each run). Two fixes, both in the test, none in the script:
per-repository `git config` calls folded into `-c` flags on every invocation (four
fewer process spawns per fixture), and an explicit `GIT_CASE_MS = 30_000` on the three
integration groups. A real-git integration test that flakes is worse than no test.

## Related docs

- `docs/adr/ADR-0020-company-github-identity.md` — §Decision, *Enforcement follows the
  rule*: the specification this implements.
- `docs/adr/ADR-0022-company-identity-is-a-github-app.md` — the corrected identity, and
  the §Consequences entry recording this as owed.
- `docs/ENGINEERING-STANDARDS.md` §2 — the attribution clause and its run-phase
  exception.
- `docs/gymnasium/proposals/GYM-004-company-identity-attribution.md` — the ledger row
  for the standards amendment; its success metric is "the amendment and its enforcement
  land together or not at all".
- `src/shared/github-app.ts` — `botIdentity`, the identity form this recognises. Note
  that it lives on `fix/workspace-trust-and-remembered-targets` and has not yet reached
  `main`; the check depends on the *form*, not on the module, and so is independent of
  that branch's landing.
- `docs/DECISIONS-LOG.md`, 2026-08-30 — `main` is not branch-protected.
