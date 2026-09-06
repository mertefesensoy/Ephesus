# An emptied worktree path retired the agent

**Status: BUILT.** Found by the real one-hour test run on 2026-09-06, not by a test — the fifth
defect in the chain that starts with
[mail lost on a woken agent's death](2026-09-05-mail-is-not-lost-when-a-woken-agent-dies.md).
Two changes ship here: the defect's fix, and one hardening the same run made unavoidable.

## Problem

`agent.skeleton-crew-musahit-ci-babysitter` could not be spawned. Not "spawned and died" —
**refused, every time, permanently**:

```
agents: "agent.skeleton-crew-musahit-ci-babysitter" asked for an isolated worktree
and did not get one — worktree refused:
"C:\Users\senso\.ephesus\worktrees\agent.skeleton-crew-musahit-ci-babysitter" already exists
```

That path was an **empty directory**:

```
$ ls -A C:/Users/senso/.ephesus/worktrees/agent.skeleton-crew-musahit-ci-babysitter
(nothing)
$ git -C … rev-parse --abbrev-ref HEAD
fatal: not a git repository (or any of the parent directories): .git
```

`Worktrees.create` refuses any existing path it cannot prove is the agent's own checkout
(`src/main/git.ts`). The proof is two `git rev-parse` calls inside the directory. An empty
directory is not a repository, so both fail, `owned` is false, and the refusal stands — this
time and every time after, because nothing in the harness ever removes it.

**On Windows this is the ordinary outcome, not an exotic one.** `git worktree remove` deletes
the contents; a held directory handle — OneDrive's sync client, a file watcher, an open shell —
leaves the now-empty directory standing. The unwind reports success. The agent is retired.

The failure mode is the worst shape a failure can have: silent between runs, permanent once it
happens, and curable only by a human deleting a directory they have no reason to look at.

### What this defect was hiding

While it stood, the on-call agent's terminal produced 89 bytes and no session, which was read as
the engine hanging at startup — a reading supported by a real `update_apply_exe_locked` record in
that agent's engine config. Both readings were wrong. With the worktree fixed and the workspace
trusted, the same agent starts in 3250 bytes, opens `session_01PMXM9JzVieD5AXdqr6HyKj`, and picks
up its assigned tasks. The engine was never hanging. Recorded here because the wrong diagnosis
survived three rounds of evidence, and the thing that finally settled it was reporting the
**spawn result** alongside the terminal capture rather than the capture alone — a zero-byte
terminal cannot distinguish "said nothing" from "never started".

## What changed

| File | Change |
|---|---|
| `src/main/git.ts` | `worktreePathIsVacant` — a pure predicate; `create` consults it before refusing, and prunes git's stale entry when it passes |
| `src/main/engines/claude.ts` | `DISABLE_AUTOUPDATER=1` in every agent's spawn environment |
| `test/main/worktrees.test.ts` | 7 cases: the empty path, the stale git entry, the wrong branch, a file, a junction, an unreadable path, a populated directory |
| `test/main/engines/claude.test.ts` | 2 cases: the switch is set, and a grant cannot outrank it |

## Implementation approach

### The question the refusal is actually protecting

The refusal exists so the harness never writes over an agent's uncommitted work. That is the same
rule `remove` enforces by never passing `--force`, and it is worth keeping exactly as strict as it
is. But it was being enforced by proxy: *"is this the agent's checkout?"* stands in for *"is there
work here to lose?"*, and the two answers differ on precisely one input — an empty directory.

So the fix asks the real question instead of a stronger one:

```
owned checkout on the agent's branch  → reuse it          (unchanged, M4 close-out)
empty real directory                  → use it            (new)
anything else                         → refuse            (unchanged)
```

An empty directory holds no work by definition, so accepting it forfeits nothing. Every other path
keeps every tooth the guard had: a populated directory, a file, a link, a checkout on somebody
else's branch, and a path that cannot be listed at all are all still refused, and the refusal names
which.

### Nothing is deleted

The first version of this fix removed the empty directory. Measuring `git worktree add` against
real git showed that to be unnecessary — **git accepts an existing empty directory as the worktree
path** (verified on git 2.53.0, `worktree add -b <branch> <existing-empty-dir>` → exit 0, checkout
populated). Dropping the removal is strictly better on three counts:

- `git.ts` keeps its promise not to destroy anything at a worktree path, on the new route too.
- The predicate becomes pure inspection, so it cannot half-succeed.
- It deletes the one branch — *"the directory was empty but could not be removed"* — that no
  portable test can reach, because there is no root-proof, cross-platform way to make `rmdirSync`
  fail on an empty directory. That branch survived mutation testing as an unkillable mutant. The
  design was wrong, not the test: see
  [an equivalent mutant is a design smell](../../CLAUDE.md) and the mutation table below.

### `lstat`, not `stat`

`worktreePathIsVacant` uses `lstat`. Through `stat`, a junction pointing at somebody else's
directory reads as a perfectly ordinary empty directory, and the checkout would land somewhere
the harness never approved. This is ADR-0021's junction guard applied at a second doorway, and it
is pinned by a test that creates a real junction — `fs.symlinkSync(target, link, 'junction')`
works on Windows without elevation.

### The prune

Clearing the path is not enough on its own. git keeps an administrative entry for a worktree whose
directory has been emptied, and `worktree add` refuses a path it already has registered — so
accepting the directory alone would swap one permanent refusal for another. `create` therefore runs
`git worktree prune` after the vacancy check passes, which is what `remove` already does for the
same reason. A mutation replacing the prune with a harmless command is killed by a test that empties
a live worktree in place.

### Why `DISABLE_AUTOUPDATER` ships alongside

This did **not** cause the defect above, and the doc says so plainly. It ships because the same
investigation turned up this, in the on-call agent's own engine config:

```json
{"timestamp":"2026-09-05T19:10:44.181Z","path":"npm-global","outcome":"failed",
 "status":"install_failed","version_from":"2.1.252","version_to":"2.1.261",
 "error_code":"update_apply_exe_locked"}
```

Up to 30 agents share one engine install. A background self-update is that many processes racing to
replace the binary all of them are executing, and on Windows every loser gets `exe_locked` and
retries at the next startup. The company upgrades its engine deliberately, between runs — an agent
must never decide that for the company.

The switch is `DISABLE_AUTOUPDATER=1`, established against the shipped binary rather than guessed
(`docs/AUTOMATION.md`'s rule, and the standing "never guess the engine" memory). The engine reads
it from `process.env` before consulting any config and short-circuits the updater outright:

```js
function uQ(){ if(a.DISABLE_UPDATES) return {type:"env",envVar:"DISABLE_UPDATES"};
               if(Pe(process.env.DISABLE_AUTOUPDATER)) return {type:"env",envVar:"DISABLE_AUTOUPDATER"};
               … if(t.autoUpdates===!1 && …) return {type:"config"}; return null }
```

**Refuted alternative:** the `autoUpdates: false` settings key. The binary's own text scopes it to
*background* updates only, and it is further conditioned on `installMethod`. It would have left the
startup path live while reading, in our settings file, as though the matter were settled. One
mechanism that is unconditional beats two that half-overlap.

It is spread **after** `cfg.envGrants` in the spawn environment, so a granted variable cannot
outrank it: a grant is a value the Architect chose for one agent, this is a decision the harness
makes for the company. Order in an object literal is a fragile place to keep a rule, so a test pins
it rather than leaving it to be read.

## Design decisions

**Why not relax the ownership probe instead** (e.g. accept any directory whose `git-common-dir`
resolves under the repo)? Because it answers the wrong question. The probe is about identity; the
safety rule is about contents. Loosening identity would start accepting checkouts on other agents'
branches — real work, really destroyed.

**Why not have the unwind delete harder** (`--force`, retry, schedule a later sweep)? Because the
unwind is exactly where this harness has decided not to be forceful, and because a fix there leaves
every directory already stranded on every existing machine still fatal. The recovery has to live at
the point of use.

**Why not let a stopped hire be skipped so activation can proceed?** Considered and rejected during
this run — see *What is not fixed here*. All-or-nothing activation is deliberate and documented
(`profiles.ts`: "a half-activated crew is worse than none, because the Architect was shown a plan
with an on-call agent in it"). Weakening it to unblock a test run would be trading a documented
safety property for convenience.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/main/worktrees.test.ts test/main/engines/
```

Observed: 22 cases in `worktrees.test.ts`, 204 across `worktrees` + `engines`, all green.

### Mutation testing — 10 / 10 killed

Run on Windows against `test/main/worktrees.test.ts` and `test/main/engines/claude.test.ts`
(the condition matters: these exercise real git in temp repositories).

| Mutation | Killed by |
|---|---|
| a NON-empty directory reads as vacant | reports a populated directory as occupied |
| `lstat` → `stat` (follow a link) | REFUSES a link that would silently redirect the checkout |
| drop the shape check entirely | REFUSES a link that would silently redirect the checkout |
| an unreadable path reads as vacant | names an unreadable path as unreadable |
| an unreadable path refuses with the wrong sentence | names an unreadable path as unreadable |
| skip the prune | recovers when git still holds a stale entry |
| stop asking whether the checkout is the agent's own | reuses the agent's own kept checkout |
| refuse even when the path is vacant (the defect, restored) | accepts an EMPTY leftover directory (+1 more) |
| `DISABLE_AUTOUPDATER: '1'` → `'0'` | never lets an agent upgrade the engine (+1 more) |
| let a granted variable outrank the switch | keeps the switch out of a granted variable's reach |

An earlier round of this pass ran 7/10 with three survivors. All three were real: two were the
missing junction case, and the third was the unremovable-directory branch that the redesign above
removed. No mutation was weakened to make it pass.

### Live, against the running app

Driven over CDP through `window.eph.*` — the real contextBridge → IPC → main path.

Before, with the empty directory in place:

```json
{"spawn": {"ok": false, "error": "… worktree refused: \"…ci-babysitter\" already exists"},
 "bytes": 0, "terminal": ""}
```

After, same directory, same agent:

```json
{"spawn": {"ok": true, "lifecycle": "running",
           "cwd": "C:\\Users\\senso\\.ephesus\\worktrees\\agent.skeleton-crew-musahit-ci-babysitter"},
 "bytes": 3250, "terminal": "… session_01PMXM9JzVieD5AXdqr6HyKj … 2 task(s) are assigned to you
 and unfinished: t-inc-musahit-ci-33986883947, t-inc-musahit-ci-33440874791 …"}
```

The nudge in that capture is the task-wake fix from earlier in the chain arriving on a live agent,
which is the first time it has been observed end to end.

## What is not fixed here

**The health-watcher's rung-3 breaker stop.** Activation of the whole profile is still refused
because one hire is halted:

```
hire "health-watcher" could not spawn: … the breaker stopped it at rung 3 (burn-rate);
clear the stop first — nothing was activated
```

The condition behind that stop has expired — it was recorded at 2026-09-05T20:54Z against a daily
token ceiling, and today's ledger reads `state: "ok", spent: 0, remaining: 20,000,000`. Clearing it
is nonetheless a safety override and therefore the Architect's call, not the harness's and not a
session's.

Two observations worth carrying forward rather than acting on now:

1. **A rung-3 stop outlives the condition that produced it, and nothing re-evaluates it.** That is
   consistent with ADR-0023 (a human-cleared halt), but the Architect clearing one today is shown
   `budget: breached` with no indication that the breach has since expired. The stop records what
   was true, not what is.
2. **A single stopped hire retires the whole company**, and the only route back through the UI is
   to override the safety control. All-or-nothing activation is right; leaving the Architect no
   move except "switch off the breaker" is the part worth a decision.

Neither is a defect. Both belong in a Gymnasium proposal, not in this fix.

## Related docs

- [Mail is not lost when a woken agent dies](2026-09-05-mail-is-not-lost-when-a-woken-agent-dies.md)
  — defect #1 of the same run
- [Worktree workspace trust](2026-09-05-worktree-workspace-trust.md) — why the trust record must
  name the worktree, which is what the 89 bytes turned out to be
- [M8.8 — a restart is survivable](2026-09-05-m8-8-restart-survivable.md)
- `docs/adr/ADR-0021` (workspace trust), `ADR-0023` (breaker rungs), `ADR-0026` (engine isolation)
- `docs/sdd/SDD.md` §"Worktree isolation"; `docs/srs/SRS.md` UC-01 alternate 2a

---

# Addendum — a submit key nobody checked (defect #7)

**Status: BUILT**, same day, same run. Found immediately after the worktree fix let the agent
spawn at all.

## Problem

With the worktree fixed the on-call agent started cleanly: 3250 bytes, a live session, auto mode on,
and the task nudge visibly in its prompt box. Then it did nothing for eighteen minutes.

Its transcript, in full:

```
mode | permission-mode | system | bridge-session
```

Four setup lines. **No user message.** The nudge was typed in and never submitted.

The timing says why:

```
23:04:02  spawn
23:04:03  hook | wake     ← one second later
```

The wake fired one second after spawn, while the TUI was still painting its startup notices —
"Keep working from anywhere", the auto-mode explainer, `/rc connecting…`. `CommandQueue.send` writes
the text, then writes `\r` 150 ms later, and **checks nothing**. One of those notices took the key.

This is the same shape as the trust dialog that answered a wake with "No, exit" on 2026-09-05:
something in front of the prompt consumes the keystroke, and the harness records a delivery.

## Implementation approach

**Confirm the outcome rather than enumerate the obstacles.** Listing what can be in front of a
prompt is a losing game — the engine adds notices between releases, and each one is a new silent
failure. But the engine already tells the harness when a prompt becomes a turn: `prompt-submitted`,
the same hook that opens the wake clock (`index.ts`, ADR-0023).

So the submit key is no longer fire-and-forget:

1. Write the text; open a *generation* for this send.
2. After `SUBMIT_KEY_DELAY_MS` (150 ms, unchanged), press `\r`.
3. If `prompt-submitted` has not arrived `SUBMIT_CONFIRM_MS` (2 s) later, press it again.
4. After `SUBMIT_ATTEMPTS` (4) keys, stop and **report** (`commands/unaccepted:<agentId>`).

`accepted(agentId)` — wired at `index.ts`'s `prompt-submitted` branch — ends the chain at once.

**Why a generation.** The first version shared one counter per agent, and a second send while the
first was unconfirmed left two chains pressing at the same time: the budget went at double speed and
the reported attempt count belonged to neither send. Each send now carries a generation, and a
scheduled press whose generation is stale returns without writing. Found by mutation, not by
reading.

**Why retrying is safe.** A key that was not needed lands on an empty prompt and does nothing. The
cost of over-pressing is nil; the cost of under-pressing is an agent that sits idle holding work.

**Why it covers the Architect's text too.** `send` is the shared path. If their words go unrun, that
is the same defect wearing different clothes, and it now reports the same way.

**Why a report and not a retry forever.** An unconfirmed submit has to end in something an Architect
can see. `commands` is its own degradation source rather than `agents`, because the agent is
healthy — process up, session live — and the only thing wrong is that a keystroke went elsewhere.

## Verification

`test/main/commands.test.ts`: 26 cases, all green. One pre-existing case was corrected, not
weakened: *"flushes exactly once when the agent reaches idle"* asserted a total write count of 2,
which conflated "no second flush" with "exactly one submit key". It now counts the **text**, which
is what its name claims and what it was there to protect.

### Mutation testing — 9 / 9 killed

| Mutation | Killed by |
|---|---|
| never re-press (the defect, restored) | presses the key again when the engine does not report the prompt (+6) |
| ignore the engine's confirmation | stops the moment the engine confirms |
| press even after confirmation landed mid-schedule | stops the moment the engine confirms (+2) |
| press forever, never giving up | gives up after a bounded number of keys and REPORTS it (+4) |
| give up silently | gives up after a bounded number of keys and REPORTS it (+4) |
| a superseded chain presses alongside the new one | gives a second send its own budget |
| report once per key rather than once per send | says nothing when the agent dies between the last key and the verdict |
| a dead agent is reported as declining its wake | says nothing about an agent that died before it could answer (+1) |
| carry the previous send's spent budget | gives a second send its own budget |

An earlier round ran 6/8 with two survivors. Both were real: one was the concurrent-chain flaw the
generation now fixes, and one was the "died between the last key and the verdict" case. Neither
mutation was weakened.

---

# Addendum 2 — a vendor name reached somebody else's repository (defect #9)

**Status: BUILT.** Found by reading the commit the run actually produced.

## Problem

With the two fixes above, the crew completed SRS §6 criterion 1: it detected MUSAHIT's CI failure,
diagnosed it, fixed it, ran the suite, and opened
[MUSAHIT #1](https://github.com/mertefesensoy/MUSAHIT/pull/1) — authored, correctly, by
`app/ephesus-crew`.

The commit ends:

```
Co-Authored-By: <the engine’s own model name> <noreply@anthropic.com>
                ^ redacted here on purpose: reproducing it verbatim would put the
                  very authorship line this fix removes back into the tree
```

SRS §6 criterion 10 requires the agent's co-author trailer **and** forbids vendor identity, in one
sentence: *"authored by the company account with the agent's co-author trailer and no Architect or
vendor identity anywhere."* A model name and an `@anthropic.com` address is the second half
violated by the engine's default.

**`scripts/check-attribution.cjs` could never have caught this.** It scans *this* repository's
history. The offending commit is in the target — which is where every commit the company writes for
a customer will be. The guard and the risk are in different repositories.

## Implementation approach

`NO_VENDOR_ATTRIBUTION` in `src/main/engines/claude.ts`, merged into both branches of
`mergeClaudeSettings` — the shared file and the per-agent one an agent actually spawns with:

```json
{ "attribution": { "commit": "", "pr": "", "sessionUrl": false }, "includeCoAuthoredBy": false }
```

Established against the shipped binary, per the standing rule about never guessing the engine.
`attribution.commit` and `attribution.pr` are documented there as *"Attribution text … Empty string
hides attribution"*; `sessionUrl` appends a claude.ai session link, an identity leak of its own and
a live URL in somebody else's repository.

**Why both keys.** `includeCoAuthoredBy` is the same switch under its older name, marked
"Deprecated: Use attribution instead". Normally this codebase refuses two half-overlapping
mechanisms — the `autoUpdates`/`DISABLE_AUTOUPDATER` decision above turns on exactly that argument.
The difference is that these are **one switch across engine versions**, not two mechanisms, and
ADR-0028 removes the agent's ability to change the install without pinning which install the
machine has. Of every rule in this repository this is the one where a redundant belt costs least.

**Why it overrides rather than merges.** Hooks, permissions and the status line all merge, because
each is a surface the Architect may legitimately be using. This is not a preference; it is a rule
about whose name goes on the company's work. Their own `~/.claude/settings.json` is a different
file and is never touched (ADR-0026).

## Verification

`test/main/engines/claude.test.ts` — 4 cases: the three values are set, the deprecated switch is set
too, an attribution already in the file is overridden, and the setting reaches the **per-agent**
file (two branches return from `mergeClaudeSettings`, and only one is what an agent spawns with).

## What this does NOT fix

The commit already on MUSAHIT #1 carries the trailer. Rewriting a pushed branch in somebody else's
repository is the Architect's call, not a session's.

And `check-attribution.cjs` still only scans this repository. A guard that watches what the company
writes into *targets* is owed and is not built here — it needs somewhere to run (the commit path in
`git.ts` is the company's own, not the agent's) and a decision about what happens when it fires
mid-run. Filed as an observation, not silently deferred.

---

# Correction — a defect that was not one

Between the wake cap firing and the PR appearing, the on-call agent's terminal was silent for a
25-second sample and this session concluded that ADR-0023's cap had abandoned it: interrupted at
600 s, idle, with `nudgedTasks` still saying "announced" and no route back. A `forgetTaskNudges`
seam was written for it.

That was wrong, and the log says so:

```
hook stop  ci-babysitter  decision=block  because=pending-work  pendingMail=2  pendingTasks=2
hook wake  ci-babysitter  pendingTasks=2
```

The Stop block re-engages the interrupted agent, and it does so without consulting `nudgedTasks` at
all. The agent ran a further full turn after the interrupt — committing, pushing, and opening the
PR — before stopping. The seam was removed; `hermes.ts` is untouched by this work.

Recorded because the mistake is instructive and repeats one already in this session's history: a
quiet sample is not evidence of a stalled agent, exactly as a zero-byte terminal was not evidence of
a hung engine. In both cases the answer was in a record the harness already keeps — the call's
return value, and the Agora log — and in both cases waiting one more beat would have shown it.
