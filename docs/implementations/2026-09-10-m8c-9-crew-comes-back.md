# A crew must be able to come back after a restart

**Date:** 2026-09-10 · **Milestone:** M8c.9 — *the highest-severity item in M8c* ·
**Branch:** `fix/m8c-9-crew-comes-back` from `origin/main` `11cc60a`

---

## 1. Problem / motivation

Finding A of [the M8b rehearsal](../demo/m8b-rehearsal-m8b-rehearsal.md). After
the `EXIT-M8.md` §4 force-kill the instance restored correctly — plan back,
trigger clock back, `seq` contiguous, consent not re-asked — and then **the crew
could not be brought back by any documented surface:**

```
profile:activate  → hire "ci-babysitter" could not spawn: … asked for an isolated
                    worktree and did not get one — worktree refused:
                    "<home>\worktrees\agent.…-ci-babysitter" already exists
                    — nothing was activated
profile:deactivate → the harness failed: agents: no agent "agent.…-ci-babysitter"
```

**A closed loop: activate refuses because the worktrees exist, deactivate
refuses because the agents do not.** The rehearsal continued only because the
runner deleted four worktrees by hand (`git worktree remove --force`, then
`prune`) — a step no README documents and a non-author would not invent. §4's
restart is followed by the rest of the hour, so **this would fail a real exit run
on its own.**

---

## 2. Which of the two observations was stale — the package's first half

The filing required this settled before anything was designed, because the M8
exit run's §6 recorded the opposite outcome: reactivation *"took over the down
instance rather than refusing it as a duplicate — ADR-0027's intent, confirmed
live"*.

**Neither observation is stale, and the contradiction is only apparent.** They
are about two different layers:

| Layer | What it does | Both runs |
|---|---|---|
| `ProfileActivations.activate` | takes over an instance whose `crew` is `down` rather than refusing it as a duplicate | **works** — the exit run saw this correctly |
| `Worktrees.create`, one layer down | decides whether the surviving worktree directory is the agent's | **refuses**, but only under a condition the exit run never produced |

The condition is what the agent left checked out. `create` treated a branch name
as proof of ownership: the checkout had to be sitting on `agent/<id>`, or on
`agent/<id>-<topic>` beneath it. **The exit run's crew never left that branch** —
Finding 8 meant it had no runbook, so it never cut a branch, never opened a pull
request and never reproduced anything. M8b gave the crew its runbook; the
rehearsal's crew did all three, ended the hour somewhere else, and met the
refusal. *The finding was invisible for exactly as long as the crew was unable to
work.*

**Three ways a working hire leaves that namespace, all of them correct
behaviour:**

1. it cuts a topic branch to carry the fix — `incident.md` §5 tells it to;
2. it checks out a commit to reproduce the failure — the rehearsal's triage
   report says it did exactly this — which leaves HEAD **detached**, where
   `git rev-parse --abbrev-ref HEAD` answers the literal string `HEAD`;
3. it follows the branch convention *as written* and cannot.

Point 3 is a defect of its own, found while settling this and verified against
real git: `docs/ENGINEERING-STANDARDS.md` §2, `CLAUDE.md` and the shipped
`profiles/skeleton-crew/playbooks/incident.md` all say to push
`agent/<name>/<topic>` — and git **cannot create that ref** while `agent/<name>`
exists, which it always does for a harness hire:

```
$ git branch agent/mason && git branch agent/mason/fix-geo
fatal: cannot lock ref 'refs/heads/agent/mason/fix-geo':
       'refs/heads/agent/mason' exists; cannot create 'refs/heads/agent/mason/fix-geo'
```

So the runbook asked every hire for a branch name that could not exist, each one
improvised something outside the namespace, and the namespace check then read
that improvisation as somebody else's checkout.

---

## 3. What changed

| File | What |
|---|---|
| `src/main/git.ts` | Ownership of a surviving worktree is the **repository link**, not the branch name. `isAgentsOwnBranch` is removed. A detached HEAD is reported as `detached at <sha>` rather than as a branch called `HEAD`. Every remaining refusal names its recovery, and the two cases get different sentences. |
| `src/main/profiles.ts` | `deactivate` does not ask to kill a crew it already knows is `down`, and finishes when a live agent has died in the meantime — reporting what it could not kill on the `deactivated` row rather than throwing out of the middle of the teardown. |
| `profiles/skeleton-crew/playbooks/incident.md` | Asks for `agent/<your-name>-<topic>`, with the one-clause reason. |
| `docs/ENGINEERING-STANDARDS.md` | §2's branch convention carries the constraint, with git's own error quoted. |
| `test/main/worktrees.test.ts` | Three refusal cases become reuse cases; two new refusal cases assert the recovery sentences; the `isAgentsOwnBranch` block is gone. |
| `test/main/agent-worktree.test.ts` | **The acceptance test** — a restore-then-reactivate against real directories: real git, a real worktree, a real second harness against the home the first one left. |
| `test/main/profile-activation.test.ts` | The other half of the loop, with a `kill` stub that throws the way `AgentManager.kill` actually throws. |

---

## 4. Mathematical / statistical details

None — no formula, statistical test or numeric algorithm. The one exact fact the
change turns on is git's ref-namespace rule: `refs/heads/a/b` cannot be created
while `refs/heads/a` exists, because a ref is a file and its parent must be a
directory. Verified by execution, quoted in §2.

---

## 5. Design decisions

**Reuse, not remove — the Architect's call, taken with the root cause in hand.**
The acceptance allowed either *"reusing or replacing the existing worktree"*. The
question was put with both failure modes named: reuse inherits whatever the
previous agent left in the working tree; replace destroys work in progress that a
restart interrupted. **Reuse, and widen what counts as the agent's own**, was
chosen. It fits what this module has always promised — `--force` appears nowhere
in it, and `remove` refuses a dirty worktree and names the files — and the
rehearsal's crew had unpushed work in exactly this position.

**Ownership is the repository link, and it always was.** The `git-common-dir`
test — does this checkout point back into *this* repository? — is what stops an
agent being handed a stranger's code, and the test suite already said so in as
many words: *"The branch name is not proof of ownership: another repository can
have a branch called anything."* That comment was true while the code beside it
required the branch to match anyway. Removing the branch clause gives up nothing
the refusal was protecting: a checkout of a different repository is still
refused, by the test that was always doing that job; an unreadable directory is
still refused; and nothing is ever deleted.

**`isAgentsOwnBranch` is deleted rather than kept and unused.** After the change
it had no caller. Keeping an exported, tested function nothing calls is the M6
Herald shape this codebase has been paying down for three milestones, and
`check-invariants` walks modules rather than functions, so nothing mechanical
would have caught it. Its two behaviours that still matter are asserted at the
seam instead — reuse on a topic branch beneath the agent's own, and refusal of a
foreign repository — where they are statements about `create` rather than about a
predicate. The 2026-09-06 incident recorded in its doc comment (a dependency
updater left on its own topic branch, refused on the next activation) moved into
`create`'s comment alongside the rehearsal's, because that is where the story is
now.

**A detached HEAD is reported, not corrected.** `git rev-parse --abbrev-ref HEAD`
answers `HEAD` when detached, and putting that on the agent's card as its branch
would be a label true in the producer's vocabulary and false in the reader's —
the class M8c.6 exists for. Switching the worktree back to the agent's branch was
rejected: it can fail, it can carry or block uncommitted changes, and it moves an
agent away from the commit it deliberately checked out.

**Deactivation of a down crew skips the kills rather than catching the throw for
everybody.** The harness already records whether an instance's crew is `live` or
`down`; asking the agent manager for a process it knows is gone is the defect,
not a harmless no-op. The `try`/`catch` is kept for the *live* case only, where an
agent may have died since — and what it catches is **reported on the row**, never
swallowed, so a genuine kill failure stays visible (invariant §7). The old code
threw *after* disarming the triggers and releasing the hires, so its refusal left
the instance half torn down; that is what made it a closed loop rather than an
inconvenience.

**The refusals that remain get two different sentences, and that is deliberate.**
A path git knows as a worktree of another repository is that repository's to
unregister; a directory git knows nothing about is a directory. Telling somebody
to run `git worktree remove` on the second produces a refusal that teaches them
nothing about the actual obstacle — and the first does not claim to know which
repository owns it, because this code cannot know that and a command that fails
is worse than a sentence that admits the gap.

**What is deliberately NOT done.** `docs/srs/SRS.md` §257, `docs/sdd/SDD.md`
§752 and `ADR-0019` describe M7b's Recursive Improvement improver pushing an
`agent/<name>/<topic>` branch, and that improver will be a harness hire with
`agent/<name>` minted — so it will meet this constraint too. ADRs are
append-only and the SRS/SDD are normative documents outside this package's
acceptance, so it is recorded in `docs/DECISIONS-LOG.md` as owed to M7b rather
than edited here.

---

## 6. Verification

Full gate, this branch:

```
npm run typecheck && npm run lint && node scripts/check-invariants.cjs &&
npm run test:coverage && node scripts/check-coverage.cjs
```

*(figures in the pull request)*

**The acceptance test is the one that matters**, and it is written the way the
acceptance demands — *"against real directories rather than a stubbed worktree
seam"*, because a stubbed seam is precisely what let this reach a live run:

```
test/main/agent-worktree.test.ts
  › brings the crew back after a restart, on the branch the agent left (M8c.9)
```

It spawns a real agent into a real worktree of a real repository, moves that
worktree onto `fix/latitude-sign` and leaves an uncommitted file on it, drains
every process without unwinding (which is what a force-kill is), starts a
**second** harness against the home the first one left, and spawns the same agent
id again. It asserts the path is the same, the branch is where the agent left it,
`branchCreated` is false, the uncommitted work is byte-identical, and the agent
actually comes up — with **no filesystem step between the two harnesses.**

**Mutation round, with a control.** Nine real mutants and a planted no-op, over
`src/main/git.ts`, `src/main/profiles.ts` and the shipped runbook.

*(result in the pull request)*

The first mutant is the package's own refutation: it restores the branch-name
ownership test — the code exactly as it shipped — and the acceptance test dies.
A restore-then-reactivate test that passed with the defect in place would have
been worth nothing.

**Adversarial refutation pass.**

| Attempt | Result |
|---|---|
| Is the acceptance test green with the defect restored? | No — mutant M1 kills it. That is the whole point of running it. |
| Is there a SECOND blocker in restart → reactivate that the spawn seam hides? | Walked: `installPlaybooks` replaces (idempotent), `beforeHires` cannot refuse, `targetExists` still holds, `activate` takes over a `down` instance, triggers re-arm from `armed: []`. None refuses. |
| Is the `activate` → worktree join tested? | **No, and deliberately.** The rehearsal IS that test: the refusal it recorded is `create`'s sentence carried verbatim to the CLI. The join worked; the rule it carried was wrong. Recorded in the decisions log rather than papered over. |
| Does a worktree left on `main`, or detached, or on a stranger's branch, still come back? | Yes — all three are asserted, and the detached case reports `detached at <sha>` rather than a branch called `HEAD`. |
| Does a checkout of a DIFFERENT repository still get refused? | Yes, by the test that was always doing that job, and now with a recovery sentence that does not claim to know which repository owns it. |
| Does an empty leftover directory with a stale git entry still recover? | Yes — the 2026-09-06 path is untouched and its test still passes. |
| Could a case-different repository path read as a different repository? | Yes — and it could before, identically. Pre-existing, out of acceptance, recorded. |
| Does deactivating a down crew leak worktrees? | It leaves them, which is the design: the next activation reuses exactly those directories. Recorded as an observation. |

---

## 7. Related docs

- [`docs/demo/m8b-rehearsal-m8b-rehearsal.md`](../demo/m8b-rehearsal-m8b-rehearsal.md) — Finding A, the evidence
- [`docs/demo/m8-onehour-aftershock.md`](../demo/m8-onehour-aftershock.md) §6 — the observation this reconciles with
- [`docs/adr/ADR-0027-what-survives-a-restart.md`](../adr/ADR-0027-what-survives-a-restart.md) — why the crew comes back `down`
- [`docs/adr/ADR-0004-agora-single-committer.md`](../adr/ADR-0004-agora-single-committer.md) — why worktrees exist at all
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8c.9 and its acceptance
- [`docs/ENGINEERING-STANDARDS.md`](../ENGINEERING-STANDARDS.md) §2 — the branch convention, now with its constraint
