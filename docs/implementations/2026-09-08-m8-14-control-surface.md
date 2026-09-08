# M8.14 — The controls are not buried in the window

**Date:** 2026-09-08 · **Milestone:** M8, the package that unblocks its exit ·
**Branch:** `feature/m8-14-control-surface` from `origin/main` `dfbacfe`

---

## 1. Problem / motivation

The M8 exit run stalled at the last step of setup.

Not on a bug. `docs/EXIT-M8.md` §1 ends with *"the consent banner answered"* and
*"Skeleton Crew activated against a repository you own"*, and both were buttons
in a window. A runner who was not a person at a keyboard could not reach either,
so an hour-long test died at minute two — before any of the clauses it exists to
measure had been reached.

Two workarounds were offered: the Architect clicks the two buttons, or the runner
is given desktop control and clicks them itself. **Both were refused**, in favour
of naming the real defect:

> *"when it says architect activates the crew it can also mean for my verbal
> approvement. So we need to find a way for you to activate everything from CLI
> tools of Ephesus that we need to build. Thus all controls should not be buried
> under the UI of the application."*

[SRS §6.1](../srs/SRS.md#6-acceptance-criteria-system-level)'s **"The Architect
activates Skeleton Crew"** is about AUTHORITY, not about a mouse. Reading it as
*a person clicking* is what left the criterion unrunnable by anybody but a person
at the machine — and that reading, not a missing CLI, is why M7's exit has been
open on the same clause since 2026-09-01.

So this is not a convenience. It is the thing that makes the milestone's own exit
possible, and the sentence it has to earn is:

> A developer who has never seen this repository can run every step of
> `docs/EXIT-M8.md` §1 without touching the mouse — **and is still unable to
> approve a single gate from a script.** If only the first half is true, this is
> worse than what it replaced.

## 2. What changed

| File | What |
|---|---|
| `src/shared/control.ts` | **New.** The pure policy: twelve verbs with their validators, the four refusals with their reasons, `resolveVerbIn` (refusals first), the request envelope, the address-file schema, and every rendered answer |
| `src/main/control.ts` | **New.** `ControlServer` (transport, validation, dispatch, audit), `controlEndpointFor`, `performVerb` (every verb's behaviour, exported so its branches are drivable), `startControlSurface` (construct + start + report, so `index.ts` holds one statement) |
| `scripts/ephctl.cjs` | **New.** The client: resolve the home, read the advertised address, POST one verb, print what came back, exit non-zero when the harness said no. No policy of its own |
| `src/main/index.ts` | Constructs and starts the surface before the consent verdict; stops it beside the hook endpoint; `const ipcDeps = registerIpc({…})` so both callers provably share one object |
| `src/main/ipc.ts` | `registerIpc` returns its deps |
| `src/main/config.ts` | `harnessHomeRoot()` extracted, so the CLI's default home is pinned against the app's by a test |
| `src/main/diagnosis.ts` | `DiagnosisWriter.snapshot()` is public — the control surface reads THAT fold rather than building its own |
| `src/shared/degradation.ts` | New source `control` |
| `src/shared/diagnosis.ts` | New probe row, *the control surface*, proven by `remote:control` |
| `scripts/coverage-floors.json` | Both new modules join the `watch` row; its `is:` extended |
| `docs/adr/ADR-0033-…md` | **New.** The decision and its alternatives |
| `docs/adr/README.md` | ADR-0032 (missing) and ADR-0033 indexed |
| `docs/THREAT-MODEL.md` | §3 trust boundary, two §5 control rows, and §6.8 — the residual risk, stated in this package rather than after it |
| `docs/EXIT-M8.md` | §1's setup is runnable without a mouse, and the refusal is a step |
| `docs/sdd/SDD.md` | Module map, the tier diagram, and the two new files in the harness home |
| `README.md` | Landed list, the prose, and *Doing all of that from a terminal* |
| `test/shared/control.test.ts` | **New.** The tables, the refusal set in both directions, every validator |
| `test/main/control-server.test.ts` | **New.** A real socket, a real home: the wire, the refusals, the audit rows |
| `test/main/control-verbs.test.ts` | **New.** What each verb SAYS, empty and full, plus the real `DiagnosisWriter` seam |
| `test/scripts/ephctl.test.ts` | **New.** The spawned client: exit codes, the no-harness sentence, the pin |
| `test/shared/diagnosis.test.ts` | The new probe, and that it is not satisfied by a Harbor `remote` row |

## 3. Implementation approach

### Three layers, and only one of them knows the policy

**`src/shared/control.ts` is the ONE place that says what is scriptable.** Verbs,
their zod schemas, and — critically — the refusal list with its reasons are data
in a pure module. That shape is the point: a mutation that moves `watch:approve`
from the refused set into the allowed one is this package undone, and the only
way to fail loudly on it is for the sets to be data a unit test can assert over
exhaustively, rather than a run of `if` statements inside a request handler.

**`src/main/control.ts` mirrors `HookServer` exactly.** `<home>/control.sock` at
`0600` on POSIX; on Windows the LOCAL named-pipe namespace — which libuv opens
with remote clients rejected — with a per-home `sha256(path.resolve(home))`
discriminator, because Windows pipe names are a machine-wide namespace where
socket paths are not. No TCP port. The transport was already solved and a second
scheme would only be a second thing to get wrong.

It is a **separate address** from the hook endpoint, not a second path on the
same server. The hook endpoint authenticates a per-spawn token belonging to an
agent, and every agent's own process is handed that address in its spawn plan.
Hanging the Architect's controls off it would put them one forged envelope away
from an agent — precisely the party this surface must not serve.

**`scripts/ephctl.cjs` holds no policy.** No verb table, no validators, no prose.
It resolves the home, reads the address the harness advertised, POSTs
`{schemaVersion, verb, args}`, prints the `text` the harness rendered, and exits
`0`/non-zero on `ok`. A test asserts this by reading its source: a client-side
copy of the refusal list would be advisory, and would be the first thing to
drift.

### One implementation, two callers — enforced by the compiler

```ts
export type ControlDeps = Pick<IpcDeps, 'consent' | 'agents' | 'agora' | …> & {
  readonly diagnosis: { snapshot(): DiagnosisInput }
}
```

`import type` only, so nothing pulls `electron` into a test process. And
`registerIpc` now returns its deps, so `index.ts` reads:

```ts
const ipcDeps = registerIpc({ … })          // src/main/index.ts:2993
…
controlServer = await startControlSurface({ // src/main/index.ts:3422
  deps: { ...ipcDeps, diagnosis: diagnosisWriter },
  home: home.root,
  report: reportDegradation
})
```

The control surface is handed **the same object the window is served from**. A
signature that changes on one side stops the other compiling. The window and a
script cannot drift into disagreeing about what an action does, which is this
repository's most-repeated defect wearing a new hat.

### The scope line, and why the four exclusions are refused rather than absent

**In:** consent (read + grant), profile list / instances / activate / deactivate,
convene a briefing, agents list, status, diagnosis, log tail, help.

**Out, deliberately:** `watch:approve`, `odeon:verdict`, `secrets:set`,
`gym:set-mode`.

Those four are the decisions the Watch exists to put in front of a human. A CLI
that could approve a destructive gate would delete the meaning of §6.1's own last
clause — *"with zero un-gated destructive actions"* — by making the gate
scriptable by the very automation the gate exists to bound. So a run in which a
script could approve gates proves nothing, which is why the exit run does not
want this even though it would be convenient for it.

They are refused **by name, with a reason that teaches the rule**, and named after
the IPC channels the window uses so a caller who knows the app's vocabulary lands
on the lesson rather than on "no such verb". An unknown verb is answered with
*both* lists, for the same reason: the most useful thing a mistyped verb can do is
teach the shape of the surface, including that four things are missing on purpose.

### The audit, and what is deliberately not audited

Every act the table marks `writes` lands in the book of record as:

```json
{ "kind": "remote", "event": "control", "channel": "remote", "verb": "…", "ok": true }
```

`kind: 'remote'` is the tag [FR-10.3](../srs/SRS.md) names; `channel: 'remote'` is
the `SourceChannel` vocabulary `src/shared/gates.ts` already uses and
`watch:approve` already stamps as `local`. `event: 'control'` separates it from
the Harbor's own `remote` rows (`inbound`, `outbound-*`, `company-token-minted`),
which are about the git *remote* rather than about a directive.

**Refusals are always logged**, whether or not the caller could have known: an
attempt to approve a gate from a script is exactly what an audit wants to find.

**Reads are not.** A read changes nothing, and `log.jsonl` is append-only — a
`status` polled once a second would push real events out of a reader's view
permanently, and no later decision can undo it. The exclusion is declarative
(`writes: boolean`, in the same table as the refusal list) so it is a fact a test
asserts rather than a habit a handler might forget.

### Why the harness advertises its address

A running harness writes `control-endpoint.json` into its home, atomically
(invariant §3 — another process reads it), and removes it on a clean quit. The
client reads it.

The alternative is the client re-deriving the sha256 in plain JavaScript, which
is a second implementation of a rule that must agree with the first — the defect
class this repository names by name, and the reason M8.13 refused an offline
`scripts/diagnose.cjs`. It also lets the client answer its most common failure
*without a connection attempt*:

- no file → *"no Ephesus harness is running against `<home>` … start it with
  `npm run dev`"*;
- file but nothing listening → *"points at `<endpoint>`, but nothing is listening
  there … the harness may have stopped without tidying up"*.

Different problems, different fixes, different sentences. `ECONNREFUSED` is not
an answer to either.

## 4. Mathematical / statistical details

Only one piece of arithmetic, and it is borrowed rather than invented: the
Windows pipe discriminator is `sha256(path.resolve(homeRoot))` truncated to its
first 16 hex characters — 64 bits — of a **canonicalised** path. Truncation is
safe here because the property needed is *distinctness between the handful of
`EPH_HOME`s on one machine*, not collision resistance against an adversary who
chooses both inputs; and the resolve matters because two spellings of one home
(`C:\eph` and `C:\eph\`) must produce ONE address, or the CLI and the harness
would sit on different pipes for the same directory. A mutation dropping the
discriminator entirely is killed by a test that starts two homes and asserts two
addresses.

The coverage arithmetic that decided module placement is in §5.

## 5. Design decisions

**The coverage row is `watch`, and it was chosen for the standard it sets.**
v8 counts executable lines, and the candidate rows measured (win32, this tree):

| row | lines | effect of ~220 well-tested lines |
|---|---|---|
| `home` | 82/114 | +10 points → **STALE RECORD** (lag is 5) |
| `shims` | 140/294 | +9 points → **STALE RECORD** |
| `boot` | 421/1511 | +5.6 points → **STALE RECORD** |
| `watch` | 926/963 | flat, *if the new code is ≥ 96 % covered* |

`watch` is also the honest row: the surface's defining artifact is a boundary on
AUTHORITY, `SourceChannel` already lives in `src/shared/gates.ts` there, and its
floor (96.17 lines / 90.2 functions / 87.1 branches) is the highest standard in
the map — the right bar for a new trust boundary. It is what forced the branch
work an easier row would have let through: the first measurement put
`src/main/control.ts` at **65.85 % branches** and dragged `watch` to 83.92, three
points under its floor. That is the ratchet doing its job.

**`performVerb` is a module-level exported function, not a private method.** The
first draft hid every verb's behaviour behind an HTTP round trip, which made its
branches expensive to drive and left the `default` case a comment rather than a
tested answer. Exported, `test/main/control-verbs.test.ts` drives all twelve
directly — including with a verb the table lists and the switch does not
implement, which is the case that says *"listed but not implemented"* rather than
the misleading *"no such verb"*.

**`startControlSurface` exists so `index.ts` holds one statement.** ENGINEERING-
STANDARDS §6.7 says the `boot` row measures how true *"index.ts holds no logic of
its own"* is; the first draft spelled out a `try`/`catch` and two closures there,
and boot's floor caught it. What remains in `index.ts` is a declaration, one call,
and one shutdown step.

**The client lives in `scripts/`, not `shims/`, and that costs something.**
`shims/` is what the harness hands an *agent* process through its spawn plan
(`EPH_AGENT_ID`, `EPH_HOOK_TOKEN`, `EPH_HOOK_ENDPOINT`); this is what a person
runs at the repo root, which is exactly how `docs/EXIT-M8.md` reaches it with no
build step. The cost, stated rather than hidden: `productionFiles()` covers
`src/**` and `shims/**/*.mjs`, so the coverage gate cannot see `scripts/`. It is
paid for by `test/scripts/ephctl.test.ts`, which spawns the real file against a
real `ControlServer`, and by the client holding no policy to be wrong about.

**No token.** It would be a new secret to manage against ADR-0010's write-only
rule, for an attacker who — running as the Architect — could already read
`~/.ephesus`, use the engine CLI's own logged-in session and post to the hook
endpoint. What the surface adds instead is audit. `docs/THREAT-MODEL.md` §6.8
says this plainly rather than leaving it implied.

Alternatives considered and rejected are in
[ADR-0033](../adr/ADR-0033-a-script-may-run-the-company.md).

## 6. Verification

### Gates

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
```

```bash
npm run test:coverage && node scripts/check-coverage.cjs && node scripts/check-readme-current.cjs
```

`npm run test:coverage` exits non-zero on an EPERM tearing down `coverage/.tmp`
*after* every test has passed; read the "Test Files" line before believing the
exit code, and clear `coverage/` from PowerShell (`Remove-Item -Recurse -Force
coverage`) before each run.

### Reproducing the mutation pass

Twenty-seven mutants over every guard this package adds, in both directions: a refused
verb that becomes allowed, an allowed verb that becomes refused, the refusal list
consulted second, a refusal that answers `200 ok`, a refused act that leaves no
trace, an act that lands untagged, reads that get logged, writes that do not, two
homes that collide on one pipe name, an endpoint that answers any path, a body
larger than the limit, two schemas that stop being strict, an address file that
survives the quit, a CLI that exits `0` on a refusal, an English failure that
becomes an error code, a refusal that stops teaching the rule, and a probe that
matches the bare kind `remote`, a company that starts with no row saying so, a
mid-session grant recorded as if it had come up consented, an unconsented boot
that says nothing at all, a usage line free to advertise a flag the schema
refuses, a live endpoint stolen from the harness serving it, an abandoned socket
called live, and a probe that answers `true` for an address nothing serves.

**Twenty-six killed. The twenty-seventh is a planted no-op** — a cosmetic rename inside
`renderHelp` — which survived, as it must: a harness that reports every mutant
killed cannot tell you when it has stopped running your tests. It earned its
keep twice, because the planted mutant also *leaked into the tree* between runs
and the second pass is what found it.

### The survivors, read rather than patched around

All were missing tests. Fourth consecutive package where "equivalent mutant" was
the comfortable and wrong reading.

1. **Consulting the allowed table before the refusal list.** With the shipped
   tables the two orders are indistinguishable — which is exactly the guard's
   justification, since it exists to survive somebody "just adding the verb" that
   is already refused. The fix was to make the order a *rule* rather than an
   accident: `resolveVerbIn(refused, allowed, name)` takes its tables, and a test
   drives it with tables that overlap.
2. **The new `DIAGNOSIS.md` probe matching the bare kind `remote`.** It would have
   read `WORKING` the moment any repository was ingested, because the Harbor
   writes that kind too — a check that cannot fail in the one way that matters,
   inside the report M8.13 built to refuse exactly that.
3. **Two mutations of the endpoint guard, after the platform fix.** Both survived
   *on win32 only*, because the first version of the guard sat inside the
   `process.platform !== 'win32'` branch and nothing local could execute it. The
   answer was not to accept a platform-conditional survivor but to make the rule
   platform-independent, and to assert the SENTENCE a reader gets rather than
   merely that the start failed — which is what makes the guard's absence
   detectable on a platform whose kernel enforces the same thing by accident.

### Production call path (ENGINEERING-STANDARDS §6.7)

| Module | Reached from |
|---|---|
| `src/main/control.ts` | `src/main/index.ts:99` (import), `:3422` (`startControlSurface`), `:3519` (quit step) |
| `src/shared/control.ts` | `src/main/control.ts:5` |
| `scripts/ephctl.cjs` | the operator, per `docs/EXIT-M8.md` §1 and README *Doing all of that from a terminal* |

`check-invariants.cjs` walks the import graph: **184/194 src modules reached**, up
from 182/192, with no new allowlist entry.

### Live proof

`npm run dev` against a fresh short `EPH_HOME`, evidence taken from
`agora/log.jsonl` rather than stdout. See §7.

## 7. Live proof

`npm run dev` twice against fresh, short homes (`C:\Users\senso\ephctl`,
`…\ephctl2` — a deep home breaks the Agora's git commits on Windows), with every
claim taken from `agora/log.jsonl` rather than from stdout.

| Step | Evidence |
|---|---|
| the app boots and refuses to hire | `{"kind":"orchestrator","event":"awaiting-consent","state":"never-asked",…,"seq":6}`, `consent/not-granted` degradation at seq 5, **no `triggers.json`** |
| the CLI grants consent, and the company starts | `{"event":"consented","state":"granted","from":"grant","seq":9}` → `orchestrator/spawned agent.artemis seq 13` → `triggers.json` written **13:33:29** against a grant at **13:32:29** |
| the CLI activates against a real checkout | `{"kind":"profile","event":"activated","instanceId":"skeleton-crew@repo:ephdemo","repos":["mertefesensoy/aftershock"],…}` — four agents, two triggers — and the answer said *"repositories mertefesensoy/aftershock — read from the target's origin remote"* |
| the four exclusions are refused, by name | four `exit=1` runs, each quoting its own rule and *"only a human may authorise…"* |
| every act carries the `remote` tag | six rows, all `{"kind":"remote","event":"control","channel":"remote",…}`: four refusals `ok:false`, `consent:grant` and `profile:activate` `ok:true` — and **no row for any of the eight reads** |
| `DIAGNOSIS.md` moves to WORKING | `the control surface \| WORKING \| remote/control at seq 11`, alongside `consent`, `orchestrator`, `the crew`, `watching a repository` and `the schedules` |

Both no-harness paths were proved too, because they are the tool's most common
failure and `ECONNREFUSED` is an answer to neither:

```text
ephctl: no Ephesus harness is running against C:\Users\senso\ephnone — there is
no control-endpoint.json in that home.

Start it with `npm run dev` (set EPH_HOME first if you meant a different home),
wait for the window, and try again.
```

```text
ephctl: C:\Users\senso\ephctl\control-endpoint.json points at
\\.\pipe\ephesus-control-24db1d3ba634243d, but nothing is listening there
(connect ENOENT …).

The harness may have stopped without tidying up. Start it with `npm run dev`
and try again.
```

### The three defects it exposed

**(a) A grant given in THIS session wrote no row at all.** Only `boot()` logged
`orchestrator/consented`; the banner's grant and `ephctl`'s alike produced four
spawns with nothing above them saying why, and the row did not appear until the
next restart. M8.13 had already met this and worked *around* it — its consent
probe reads `provenDirectly` from `config.json` precisely because the log row was
not there yet, which fixes the report and not the book of record. The emission
moved INTO `CompanyStart`, where the ordering already lives, so both callers get
it and neither can forget; the row carries `from: 'boot' | 'grant'`, because *"the
company came up already consented"* and *"somebody said go at 03:14"* are
different afternoons to a reader asking why four agents spawned. `index.ts` lost
a statement rather than gaining one, which is the direction the `boot` coverage
row exists to keep true.

**(c) On POSIX, a second harness on one home stole the control endpoint from the
first** — and this one only CI could show. `start()` removes a leftover socket
file so a crashed run does not block the next boot (SDD §10); removing it
unconditionally deletes a LIVE one, and the first harness then answers nobody
while `ephctl` talks to the second. Windows refuses a duplicate pipe name, so
`start()` failed on its own and the test asserting the degradation was green on
the machine it was written on and red on the other platform. A leftover socket is
now probed with a 250 ms connect, **on both platforms**: a served address is
refused with a sentence rather than with `EADDRINUSE`, and only then is a
leftover cleared, on the platform that has one. Running it everywhere is not
tidiness — the first fix put the probe inside the `win32` branch and two
mutations of it survived here, *because no local test could reach them*. A guard
only one platform executes is a guard only one platform's tests can check.
`src/main/hooks.ts` has the identical unconditional `rmSync` and is deliberately
not changed here — a §8 question, recorded rather than fixed.

**(b) `profile:activate`'s usage line advertised `--isolation worktree`**, which
`activationIsolationSchema` does not accept. A help string that sends a stranger
to a flag the harness would refuse is worse than no help string, and it survived
a green suite because the usage text was only ever asserted to *contain the
verb's name*. Fixed, and pinned: a test now parses the values out of that usage
line and puts each through the real schema, and it fails against the original
wording.

## 8. Related docs

- [ADR-0033 — A script may run the company; only a human may authorise](../adr/ADR-0033-a-script-may-run-the-company.md)
- [ADR-0032 — The company asks before it starts](../adr/ADR-0032-the-company-asks-before-it-starts.md)
- [ADR-0010 — Secrets are write-only](../adr/ADR-0010-secret-broker.md)
- [SRS §6.1, as amended 2026-09-08](../srs/SRS.md#6-acceptance-criteria-system-level)
- [SDD §1.1 module map, §2 on-disk layout](../sdd/SDD.md)
- [THREAT-MODEL §3, §5, §6.8](../THREAT-MODEL.md)
- [EXIT-M8 §1](../EXIT-M8.md)
- [M8.13 — the report this surface reads](./2026-09-08-m8-13-diagnosis.md)
