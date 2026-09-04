# M8.5 — The mission actually watches the repository

## Problem / motivation

Register item **B7**. Three facts that are individually reasonable and together
make the flagship mission inert on first use:

1. Both shipped bundles carry `repos: []` (`profiles/skeleton-crew/harbor.json`,
   `profiles/front-office/harbor.json`).
2. `activationPlan` took `plan.repos` from `bundle.harbor.repos` and nowhere
   else, so an activation's repository list was whatever the bundle said.
3. The ingest cadence disabled itself when no live instance had any repository:
   `enabled: () => instances.some((i) => i.plan.repos.length > 0)`.

So activating the Skeleton Crew against a real repository watched **nothing** —
no CI run, issue or pull request was ingested, therefore no incident could ever
be raised, therefore the whole `ingest → incident → Artemis → ledger` chain that
S-PROFILE proves could not *start*. Nothing failed and nothing said anything.
This machine only worked because `harbor.json` had been hand-edited.

The Architect's decision (2026-09-04): **derive the repository from the target
checkout, show the proposal on the activation screen, and let the Architect
override it.** Not "derive silently" and not "make them type it".

## What changed

| File | Change |
|---|---|
| `src/shared/repo-remote.ts` | New. `githubSlug` (a remote URL → `owner/repo`) and `deriveRepo` (many remotes → one answer, or a sentence). Pure, and the whole of the refusal logic. |
| `src/main/git.ts` | `readRemotes(runner, cwd)` — the one module allowed to run `git`, now reading a target's remotes. Commits nothing; never throws. |
| `src/shared/profile-activation.ts` | The plan carries `reposFrom` and `reposBecause` beside `repos`; `activationPlan` takes the derivation and the Architect's choice; `activationRequestSchema` gained the optional `repos`; `watchedRepos` — one function for the Harbor's ingest list AND the cadence's arming condition. |
| `src/main/profiles.ts` | `preview` is asynchronous, because it READS the remotes rather than remembering them; `onWatchesNothing` fires when an instance comes up with nothing to watch. |
| `src/main/index.ts` | Wires the real resolver (`readRemotes` → `deriveRepo`) and routes `onWatchesNothing` to the degradation channel; both Harbor call sites go through `watchedRepos`. |
| `src/main/ipc.ts` | `profilesPreview` returns a promise. |
| `src/renderer/src/ProfilesPanel.tsx` | "It would watch" says what and from where, or says **nothing — \<why\>** in the warning colour; an input for the override; `parseRepoList` as a tested pure function. |
| `docs/sdd/SDD.md` | The `git.ts` and `profiles.ts` rows. |

## Implementation approach

### The checkout already knows what it is

`git remote -v`, parsed into `{name, url}` pairs, then `deriveRepo`. Four URL
forms are handled because git writes four: `https://`, `ssh://`, `git://`, and
the scp shorthand `git@host:owner/repo.git`, which `new URL()` cannot parse and
which is therefore matched first.

Two details that are not incidental:

- **A Windows drive letter is not a host.** `C:\repos\myapp` matches the naive
  scp pattern with host `c`, and the Architect would have been told the target
  has "no github.com remote (c)" — a sentence that sends them looking for a
  host called `c`. The scp host must be at least two characters, which is git's
  own rule.
- **A remote URL is never echoed.** `gh` itself writes
  `https://x-access-token:<token>@github.com/owner/repo.git`. Every refusal
  names the remote and its **host**, built from parts, never the URL
  (ENGINEERING-STANDARDS §5). A test asserts the token never appears in either
  the answer or the refusal.

### Refusing is a first-class answer

The package's risk line: *deriving the repo from the target guesses a remote —
refuse and say so when the target has no unambiguous remote, rather than
inventing one.* A wrong slug is worse than no slug: the company would watch
somebody else's repository and raise incidents about it.

So `deriveRepo` returns an answer or a sentence, and the ambiguity rule is
deliberately **not** "prefer `origin`":

| Remotes | Answer |
|---|---|
| none | `the target has no git remote` |
| one GitHub remote | that slug, naming the remote it came from |
| several remotes, one distinct slug | that slug — one answer written down twice is not ambiguity |
| several remotes, no GitHub one | `no github.com remote (origin → gitlab.com, backup → not a URL)` |
| several distinct slugs (a fork) | refuses, naming **both**, and says `name the one to watch` |

A fork has `origin` at the Architect's copy and `upstream` at the canonical
repository. Which one a mission should watch is a real decision with different
consequences, and preferring `origin` would make it silently — and be right
often enough that the times it was wrong would be baffling.

### Precedence, and why an empty override is not an override

1. **What the Architect typed** — the most specific and most recent statement.
2. **What the bundle declares** — a profile written for fixed repositories
   means it.
3. **What the target's remotes say** — the step that removes the setup cliff.
4. **Nothing, with the reason** — and the reason names the consequence:
   *"…this instance will watch no repository, so no CI run, issue or pull
   request can reach it."*

`activationRequest` omits `repos` rather than sending `[]`: "the Architect chose
no repositories" and "the Architect did not choose" are different statements,
and only the second may fall through to the bundle.

### The condition can stop being true

Found by the adversarial pass on this package's own code: the first version
fired `onWatchesNothing` and nothing ever cleared it. The Architect fixes the
remote, reactivates, and the health list still says the mission watches nothing
— which is exactly the failure M8.2 was written against, and worse than never
raising it, because they learn to disbelieve the list.

So it is **one** callback carrying both directions —
`onWatching(instanceId, because: string | null)`, null meaning "it has
something" — rather than a raise callback and a clear callback that could be
half-wired. Deactivation clears it too: an instance that is gone is not an
instance watching nothing.

### Watching nothing is said, not refused

An activation whose derivation refused still comes up. Refusing it outright
would put a new cliff exactly where M8 is removing one — a profile also hires a
crew and arms schedules, and none of that depends on the Harbor. What changes is
that the condition is **said**: on the activation screen before, in the warning
colour, and afterwards through `onWatchesNothing` into the degradation channel
(invariant §7). It was the silent outcome of every activation there had ever
been.

### One function for two questions

The Harbor's ingest list and the cadence's arming condition were two inlined
expressions in `index.ts` over the same data. They are now one exported
`watchedRepos`, for the M7.4 reason: an inlined resolver is untestable, so the
only assertion available is a *copy* in a test file, and a copy stays green while
the original rots. That is exactly how the incident path lost its whole
production life — `index.ts` filtered `trigger.when === 'ci'` while the plan
rendered `"on ci"`, every unit test passed bindings in by hand, and every CI
failure on a real repository was dropped.

### `preview` became asynchronous, deliberately

The alternative was a cached derivation refreshed in the background. That is a
setting nobody re-reads, which is the shape of every defect this milestone has
found. The Architect adds a remote to a checkout between two activations like
anybody else, so the remotes are read on every preview, and a test drives that
by changing the answer between two calls.

## Design decisions

**`readRemotes` lives in `git.ts`, not in a new module.** ADR-0004's rule is
about the single *committer*, and this reads. But the invariant that enforces it
is literal — "no file but `git.ts` may invoke git" — and a second file shelling
out to git would defeat the check whatever that file did. Putting the read
there keeps the rule true as written, and `readRemotes` takes a `GitRunner` so
it is injectable.

**`github.com` only.** `www.github.com` too, and nothing else. The Harbor speaks
to `gh`, which is not pointed at an Enterprise host in this build, so a
`github.mycorp.example` remote is refused *by name* rather than accepted and
handed to a CLI that would fail later with a worse message.

**A local path is `not a URL`, not a host.** The refusal for a checkout whose
only remote is `/srv/git/app.git` reads `backup → not a URL`, because reporting
a path fragment as a hostname is how the Windows drive-letter bug would have
read to an Architect.

**The scenario builds its own checkout.** `s-profile`'s new cases `git init` a
temp repository with a known remote rather than using this repository, so the
assertion does not depend on whose fork the suite is running in.

**`activate` re-derives rather than reusing the previewed answer.** It calls
`preview`, which reads the remotes again, so an Architect who edits a remote
between reading the plan and pressing ACTIVATE gets the *current* truth rather
than a stale one. This is the same contract the rest of the plan already had —
`globalAutonomy` and `missingGrants` are re-evaluated there too — and the
activated log row records what the instance actually watches, so the record
never disagrees with the instance.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
npx vitest run test/shared/repo-remote.test.ts test/main/repo-remotes.test.ts \
  test/main/profile-activation.test.ts test/scenarios/s-profile.test.ts
```

The claim the package exists for, executed end to end
(`test/scenarios/s-profile.test.ts`): a real `git init` checkout with one GitHub
remote, the shipped Skeleton Crew bundle (`repos: []`), the shipped
`readRemotes` and `deriveRepo`, and then the same
`ingest → incident → Artemis` chain the older cases prove — this time started
from the plan rather than from a literal. And its opposite: a fork's two
remotes, a refusal, and nobody woken for either side.

## Related docs

- `docs/adr/ADR-0012` — declarative profile bundles, and reading one before trusting it
- `docs/adr/ADR-0004` — one committer, and why `git.ts` is the only module that runs git
- `docs/srs/SRS.md` FR-10.1, FR-10.3, FR-9.4 · SDD §7.5
- `docs/PROGRESS.md` — the M8.5 entry and its evidence
- `docs/implementations/2026-09-04-m8-4-the-setup-cliff.md` — the same shape, one package earlier
