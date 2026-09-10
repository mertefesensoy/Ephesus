# ADR-0035 — An engine's permission prompt is answered in advance, by name

**Status:** accepted · **Date:** 2026-09-10 · **Extends:** ADR-0012, ADR-0026,
ADR-0031 · **Relates to:** ADR-0033 (what a script may not authorise),
ADR-0009 (the adapter contract this reads a new config field through)

## Context

Ephesus gates the company's own actions. An Ephesus gate is a deliberate hold
with a `gateId`, a blast radius and a verdict an Architect settles in the WATCH
tab, and `evaluateGate` **refuses the `tool-permission` kind by construction** —
correctly, because the harness has no action to permit there. The engine does.

So when a hired agent meets its engine's own permission dialog, the harness can
see it and say so, and that is the whole of what it can do. It does say so:
invariant §7 requires every give-up to be visible, and the row is
`gate/ungated · tool-permission · waiting · "Claude is waiting for your input"`.

**What that costs was a worry on 2026-09-09 and is a measurement after
2026-09-09.** The M8 exit run recorded seven such rows in forty minutes and
filed it as *"medium-high: it undercuts the premise of an unattended hour"* —
a worry, because the crew never got far enough for it to bite. Then M8b let the
crew act, and the rehearsal measured what actually happens:

| | M8 exit run | M8b rehearsal |
|---|---|---|
| prompts in the hour | 7 in 40 minutes | **12** |
| agents whose LAST recorded action is a parked prompt | — | **4 of 5** |

`health-watcher` 19:57:55 · `verifier` 19:53:39 · `agent.artemis` 19:53:26 ·
`ci-babysitter` 19:44:37. The Architect saw it from outside before the log did —
*"they opened 3 PRs then stopped."* They had.

**So the hour does not last an hour: it lasts until the first agent reaches a
prompt**, and every number a run reports is bounded by that rather than by the
company's capacity. Five triages and three pull requests is what fits between
activation and the first prompt. This is no longer a premise being undercut; it
is the thing that ends the run.

Two facts bound the solution space, and both are already decided:

- **ADR-0031** maps the composed autonomy level onto `--permission-mode`, and
  stops deliberately short of `bypassPermissions` — *"the case for autonomy
  here was that a standing policy beats a human who has stopped reading
  prompts, which is an argument for a better classifier, not for switching the
  classifier off."* `autonomous` reaches the engine as `auto`, and `auto` still
  asks about some things.
- **ADR-0033** refuses `watch:approve` to a script, because *"a script that
  could approve gates would make the gate scriptable by exactly the automation
  it is there to bound."*

## Options

**1. Pre-authorise per hire, least privilege — CHOSEN.** The hire template
declares, by name, the commands its agents may run unprompted. The adapter
renders them into the settings file the harness already writes. The activation
screen shows them before anything is hired. **Anything undeclared still parks.**

**2. Escalate the engine's prompt as a real Ephesus gate.** The harness detects
the notification, opens a gate with a `gateId`, the Architect clears it in
WATCH, and the harness answers the engine's dialog on their behalf.

Rejected, and not because it is hard — it is buildable, the harness owns the
PTY. It is rejected because of what it *is*: a harness that types into an
engine's permission dialog can approve anything the engine would have asked
about, in advance of knowing what that is. That is a strictly larger power than
declaring beforehand what may happen, and it is the same authority ADR-0033
refuses to a script. It would also require reversing `evaluateGate`'s refusal of
`tool-permission`, which exists because the harness has no action to permit.
**Declaring in advance what may happen is a smaller power than being able to say
yes to whatever comes up**, and it is auditable before the fact rather than
after it.

**3. Raise the ceiling to `bypassPermissions` at `autonomous`.** One line, and
it ends every prompt. Rejected: it reverses ADR-0031 on that ADR's own
reasoning, switching the classifier off rather than deciding it, and it is
exactly the blanket nothing should arrive at by way of a default.

**4. Do nothing and accept that the hour ends at the first prompt.** Rejected by
the acceptance M8c.9's sibling package carries: *"an unattended hour must be
able to end because the work ended."*

## Decision

### 1. A hire declares what it may do unprompted

`hireTemplateSchema` gains an optional `unattended` array
(`src/shared/engine-permissions.ts`). Each entry is a shell command:

```json
"unattended": [
  { "run": "git status", "prefix": true },
  { "run": "git push -u origin HEAD" },
  { "run": "npm test" }
]
```

`prefix` is the whole safety story. Without it the grant matches that command
and nothing else — the form `ghTokenPermissions` has always used for the one
call it grants. With it the grant matches anything **starting** with the
declared text, which is what makes `git status --short` usable off one
declaration while `git push --force` still stops at the prompt.

**Use the exact form wherever an argument could change *where* the command acts
rather than *how*.** The push grant above is exact for that reason, and §5 says
what it cost to learn.

**Optional, and omitting it grants nothing.** Every bundle written before this
ADR keeps the behaviour it had, which is the direction an unknown must fail in.

### 2. The schema refuses what it cannot bound

A grant that could carry a second command is a grant of that second command, so
the declaration is refused when it contains `;`, `&`, `|`, a backtick, `$(`,
`<`, `>`, a newline, a NUL, `..`, or untrimmed whitespace. **A `prefix` grant
must name at least two words** — `{"run": "git", "prefix": true}` is refused,
because it would grant everything git can do. At most twelve per hire, for the
reason `toolGrantsSchema` caps at eight: every entry is something that happens
with nobody watching, and a list too long to read is a list nobody read.

### 3. Commands only, and that is one mechanism rather than two

The prompts an unattended crew meets are shell-shaped: reproduce the failure,
cut a branch, push it, open a pull request. Reads and edits inside its own
worktree are already decided by the composed autonomy level (ADR-0031); its
mailbox and its runbooks are already granted by name. What was left was the
shell. A second vocabulary — web domains, file roots — is a schema change with
its own ADR, not a field somebody slips in. Same argument `engine-tools.ts`
makes for granting directories rather than inline definitions.

### 4. A shared bundle may not arrive holding more of this than the one it replaces

`inspectImport` refuses a bundle that reuses a trusted name and arrives with more
authority — that is the sharpest attack FR-10.4 has to answer, and M7.6 built the
check for it. It covered env grants and autonomy. **It did not know about
`unattended`**, which this ADR creates, so a shared bundle could have arrived
carrying `curl … | sh` as an unprompted command and nothing would have said so.
The manifest now carries every hire's grants, the widening check refuses any that
the installed version does not already hold, and — because the manifest is
recomputed from the payload — a bundle whose manifest *hides* a grant it carries
is refused for the omission rather than passing as an honest export.

**The same pass found that `tools` had never been covered there either**, since
M8.7b: a shared bundle could add a directory an agent reads as instructions
(ADR-0026's whole subject) with no widening refusal. Closed in the same three
lines, because a manifest that disclosed one and not the other would look
complete and not be.

### 5. The shipped bundles declare what their runbooks already say in prose

The Skeleton Crew's `ci-babysitter` brief already states that pushing its own
branch and opening a pull request *"without asking"* is the work rather than an
exception to it. Until now that sentence was true of Ephesus and false of the
engine, and the agent stopped anyway. It is now declared, and — this is the
part worth reading — **declared more narrowly than the prose**:

| Hire | May run unprompted |
|---|---|
| `ci-babysitter`, `dependency-updater` | inspection (`git status/diff/log/show`, `git fetch origin`, `gh run view`) + **its own work only** (`git switch -c agent/…`, `git add`, `git commit`, `gh pr create`, and the two push forms **exactly**: `git push -u origin HEAD`, `git push origin HEAD`) |
| `verifier`, `health-watcher` | inspection only |
| every Front Office hire | inspection only — **no push, no pull request** |

The two push grants are **exact, not prefixed, and the adversarial pass is why.**
The first version of this ADR granted `git push -u origin agent/` as a prefix, on
the reasoning that the agent's own branch namespace bounded it. It does not:
git's refspec is `<src>:<dst>`, so `git push -u origin agent/x:main` starts with
that prefix and pushes to `main`. An exact grant of the `HEAD` form cannot name a
destination at all, and it is the command the runbook's own flow uses. So the
runbook's *"pushing to a branch someone else builds on … propose it and wait"* is
now mechanical rather than advisory. The Front Office is draft-only by design
(M7.5/M7.6: *"a draft-only profile has no code path that posts"*), so no hire of
it is pre-authorised to push or open a pull request at all.

## Consequences

**An unattended hour can end because the work ended.** That is the point, and
it is the claim a later run has to test rather than one this ADR can assert.

**A pre-authorised command is a command that runs with nobody watching.** That
is true by construction and is the trade being made. Three things bound it: the
grant is declared in a bundle the Architect reads before activating; it is shown
on the activation screen with everything else that activation would do; and
every hire runs in its own worktree on its own engine install (ADR-0026,
M8.6), so the blast radius of a shell command is that checkout.

**What is NOT bounded, stated plainly.** A `prefix` grant permits whatever
follows the declared text, so `{"run": "git commit", "prefix": true}` permits
`git commit --no-verify`, and `{"run": "gh pr create", "prefix": true}` permits
`gh pr create --repo somewhere/else`. The schema refuses declarations that could
chain a second command, and the two-word rule stops the widest grants, but a
prefix is a prefix. **Read a bundle's `unattended` list as "these commands, and
any argument a reasonable person could add to them"** — and where an argument
would change WHERE the command acts rather than how, use the exact form, as the
two push grants do.

**A grant the harness installs cannot be retracted from a settings file it did
not replace.** Nothing distinguishes a `Bash(...)` rule this harness wrote from
one the Architect wrote, so when a bundle narrows its declaration the wider rule
survives in that agent's `settings.local.json` until the file is restored from
the backup the injection takes. It bites hardest in a reused worktree (M8c.9),
where the file outlives the spawn. Pinned by a test named for it rather than
left to be discovered. **A permission that outlives its declaration is the wrong
direction to be wrong in**, and closing it needs a discriminator the settings
format does not offer — a follow-on, not a silent gap.

**The engine's prompt is still not an Ephesus gate, and still cannot be
answered by anyone but a person at that terminal.** This ADR reduces how often
one is met; it does not make one clearable. An agent that reaches a prompt for
something undeclared is still parked for the rest of the run, and the `ungated`
row that says so is still the right report.

**A hire that declares nothing behaves exactly as it did.** Additive and
optional, like `budget`, `isolation`, `onExit` and `tools` before it, so no
existing bundle changes meaning and no persisted activation plan fails to
restore.

## Prior art

The upstream harness answers this by running its agents with permissions
disabled entirely. Ephesus takes the declaration route instead for the reason
ADR-0012 gives for declaring everything else: a mission bundle is a thing the
Architect reads before trusting, and a capability that is readable in advance is
governable in a way that a global switch is not.
