# git runs from a neutral working directory

## Problem / motivation

`ExecGitRunner` ran every git command as `execFile('git', args, { cwd: <repo> })`.
On Windows a process's current directory is an open handle on it, so each git
child was a **lock on the repository directory for as long as it lived**:
`rmdir` fails with `EBUSY` while every file inside deletes normally.

That was the cause of the test suite's teardown flake, closed one layer up in
`2026-09-01-flaky-temp-dir-teardown.md` by waiting the pin out. This closes it
at the source, so nothing has to wait: git is *told* where the repository is
instead of being stood inside it.

It is not only a test concern. The harness removes and moves checkouts —
`GitWorktrees.remove`, respawn onto a surviving worktree, the uninstall path —
and none of that can succeed while a git command it started is still running
there. The old design made a visible refusal out of a race that need not exist.

## What changed

| File | Change |
|---|---|
| `src/main/git.ts` | New `repoLocation()` resolves a directory to `--git-dir`/`--work-tree`; `ExecGitRunner` now spawns with `cwd: NEUTRAL_CWD` (the system temp directory) and passes that location instead. |
| `test/main/git-neutral-cwd.test.ts` | New. Every resolution case, and the property that a repository stays removable while git runs against it. |

No caller changed. `GitRunner.run(cwd, args)` keeps its signature — the `cwd`
argument now means "the repository to work on" rather than "the directory to
stand in", which is what every call site already intended.

## Implementation approach

### Equivalence was measured before anything was changed

The risk in this change is behavioural drift across ~13 distinct git
invocations, so a harness compared `{ cwd: D }` against
`--git-dir/--work-tree` from a neutral cwd, command by command, on a normal
repo, a linked worktree, and a non-repo:

```text
--- normal repo ---
SAME  rev-parse --git-dir / status --porcelain / rev-parse HEAD
SAME  rev-parse --verify branch / --verify missing / worktree list
--- linked worktree (.git is a file) ---
SAME  rev-parse --abbrev-ref HEAD / status --porcelain / rev-parse --git-common-dir
--- not a repo (must FAIL both ways) ---
SAME  rev-parse --git-dir / status --porcelain
--- add -A / commit / init, from the neutral cwd ---
  add -A ok=true; staged: "A  agents/agent.a/f.json"; commit ok=true; status after: ""
  init ok=true .git created=true
ALL EQUIVALENT: true
```

Then the property itself, and the three inputs a naive substitution would
silently regress:

```text
old way pinned its repo: true
new way blocked a delete while 12 git processes ran: no
subdir: old ok=true  naive-new ok=false        <- regression
init nested in a repo: created its OWN .git=true
bare: old ok=true  naive-new ok=false  git-dir-only ok=true
```

Every branch in `repoLocation` exists because one of those measurements
demanded it:

- **A working tree** — `<dir>/.git` is a directory. The ordinary case.
- **A linked worktree** — `<dir>/.git` is a *file* holding `gitdir: <path>`,
  which `--git-dir` will not follow. Resolved by hand. This is the shape every
  agent's isolated checkout is in, so getting it wrong would break worktree
  isolation entirely.
- **A subdirectory of a repository** — git discovers a repo by walking up; a
  `--git-dir` nailed to `<dir>/.git` does not, turning a real repo subdirectory
  into "not a git repository". The walk is reproduced.
- **A bare repository** — `--work-tree` is meaningless for one and broke a bare
  repo that works today; `--git-dir` alone is correct.
- **`init`** — the one command that must *not* discover an enclosing
  repository, because it creates one. Measured: `git init` inside a directory
  nested in a repo makes its own `.git`. Without this exception a `~/.ephesus`
  that happened to sit inside some other checkout would silently join it, and
  the Agora would commit into the user's repository.

### The fallback always names a git dir

When nothing is found, a `--git-dir` that does not exist is still passed. The
alternative — passing nothing — lets git discover a repository by searching up
from `NEUTRAL_CWD`.

This was demonstrated the hard way. Removing the rule as a mutation check did
not merely fail tests: `git init` with no `--git-dir` and a neutral cwd
**created a repository in the system temp directory**, and every later run then
discovered it by walking up, so directories that were not repositories began
reporting that they were. Three tests failed for that reason before the stray
repo was found and removed. Always naming a git dir is what stops git's search
from ever starting.

## Design decisions

**The temp directory as the neutral cwd.** It always exists and the harness
never deletes it. Nothing is written there — the point is only to be somewhere
git is not being asked to hold. Because a `--git-dir` is always passed, git
never searches from it, so what happens to sit around that directory cannot
change any result.

**`repoLocation` inspects `args[0]`.** A runner that reads the command it is
running is a small wart, and the alternative — a separate `init` entry point, or
a flag threaded through `GitRunner` — spreads the same knowledge across the
interface and every caller. One documented exception, in the module that already
knows it is running git, is the cheaper of the two.

**The signature was left alone.** Changing `run(cwd, args)` to
`run(repo, args)` across every call site would have made a large diff out of a
rename, and the argument already meant the repository at every site.

## Verification

```bash
npx vitest run test/main/git-neutral-cwd.test.ts test/main/worktrees.test.ts test/main/agora.test.ts
```

### MUTATION-CHECK

| # | Mutation | Expected red | Observed |
|---|---|---|---|
| M1 | gitfile pointer not followed | linked worktree case | 1 failed |
| M2 | no upward discovery | repo-subdirectory case | 1 failed |
| M3 | `init` allowed to discover | the `init` case | 1 failed |
| M4 | bare repo handed a `--work-tree` | the bare case | 1 failed |
| M5 | fall back to no `--git-dir` | the whole Agora | **22 failed** (and it created the stray repo described above) |

### Effect

`EBUSY` was already at zero after the teardown fix; this removes the condition
that produced it rather than waiting it out. The suite's failure set is
unchanged and remains the pre-existing set confirmed against `cef76e0`
(`agent-worktree` ×4, `s-crash` ×3, `hires-exchange`, `s-profile`,
`renderer/emotes`, `shared/cost`).

`test/main/git-neutral-cwd.test.ts` asserts the property directly: twelve git
processes running against a repository, and a directory inside it still
removable.

## Related docs

- `docs/implementations/2026-09-01-flaky-temp-dir-teardown.md` — the same cause,
  handled one layer up
- `docs/adr/ADR-0004` — only the main process runs git, and only through this
  module
- `docs/srs/SRS.md` UC-01 alternate 2a — worktree isolation, the linked-worktree
  case this had to keep working
