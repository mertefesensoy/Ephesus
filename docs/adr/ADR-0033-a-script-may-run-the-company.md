# ADR-0033 — A script may run the company; only a human may authorise

**Status:** accepted · **Date:** 2026-09-08 · **Relates to:** ADR-0032 (the company asks
before it starts — the control this most needs to reach), ADR-0010 (secrets are
write-only, which is why there is no token), ADR-0002 (the hook endpoint, whose
transport this mirrors), FR-10.3 (`remote` tagging), FR-14.2 (the mode is the
Architect's), SRS §6.1 as amended 2026-09-08

## Context

The first attempt at the M8 exit run stalled at the last step of setup.

Not on a bug. On the fact that **consent and profile activation existed only in the
renderer**. `docs/EXIT-M8.md` §1 ends with "the consent banner answered" and "Skeleton
Crew activated against a repository you own", and both are buttons in a window. A runner
who was not a person at a keyboard could not reach either, and the whole hour's test died
at minute two — before any of the clauses it exists to measure had been reached.

Two workarounds were offered. The Architect clicks the two buttons and the runner does the
rest; or the runner is given desktop control and clicks them itself. **Both were refused**,
in favour of naming the real defect:

> *"when it says architect activates the crew it can also mean for my verbal approvement.
> So we need to find a way for you to activate everything from CLI tools of Ephesus that
> we need to build. Thus all controls should not be buried under the UI of the
> application."*

SRS §6.1's **"The Architect activates Skeleton Crew"** is about AUTHORITY, not about a
mouse. Reading it as *a person clicking* is what left the criterion unrunnable by anybody
but a person at the machine — and that reading, not the missing CLI, is what had kept M7's
exit open since 2026-09-01.

So the unblock is a control surface. Not a convenience: the thing that makes the
milestone's own exit possible.

## Decision

**Ephesus ships a local control surface that OPERATES the company and does not AUTHORISE
anything the company is not otherwise allowed to do.**

One sentence carries the whole design:

> **A script may run the company; only a human may authorise what the company is not
> otherwise allowed to do.**

### What is scriptable

Consent (read and grant), profile activation and deactivation, listing profiles and live
instances, convening a briefing, the agent roster, the status and diagnosis reads, and a
tail of the book of record. Twelve verbs, listed in `src/shared/control.ts`.

### What is not, and it is exactly four

`watch:approve` · `odeon:verdict` · `secrets:set` · `gym:set-mode`

Gate approvals, memo verdicts, secrets and mode changes. These are the decisions the Watch
exists to put in front of a human. A CLI that could approve a destructive gate would delete
the meaning of §6.1's own last clause — *"with zero un-gated destructive actions"* — by
making the gate scriptable by the very automation the gate exists to bound. A run in which
a script could approve gates proves nothing, so the exit run does not want this even
though it would be convenient for it.

ADR-0010 (secrets are write-only) and FR-14.2 (the mode is the Architect's) already draw
the same line in their own areas; this states it once, for the whole surface.

### The four are refused BY NAME, with a reason

Not absent. Not 404. A caller who asks for `watch:approve` is told that it is deliberately
not scriptable, why, and where a human does it instead. *"There is no such verb"* is a
worse answer than *"gate approval is deliberately not scriptable; approve it in WATCH, and
here is why"* — a refusal a caller cannot learn from bills you every time, which is a
lesson this repository has already paid for once (the triage refusals of M8.9).

An **unknown** verb is answered with both lists, for the same reason: the most useful thing
a mistyped verb can do is teach the shape of the surface, including that four things are
missing on purpose.

### One implementation, two callers

The endpoint dispatches through the **same `IpcDeps` object** `registerIpc` is handed.
`ControlDeps` is a `Pick<IpcDeps, …>`, so a signature that changes on one side stops the
other compiling. The window and a script cannot drift into disagreeing about what an action
does — which is this repository's most-repeated defect wearing a new hat.

### Trust: guarded like the event plane, auditable beyond it

**Owner-only, local-only, no token.** The transport mirrors `hookEndpointFor`: a `0600`
socket in the home on POSIX, and on Windows the LOCAL named-pipe namespace — which libuv
opens with remote clients rejected — with a per-home sha256 discriminator so two `EPH_HOME`s
cannot collide on a machine-wide name. No TCP port is opened.

A token was considered and rejected: it would be a new secret to manage against ADR-0010's
write-only rule, for a threat this design does not otherwise face. The endpoint already
trusts exactly what `~/.ephesus`, the engine credentials and the hook endpoint all trust —
every process running as the Architect.

**What it adds beyond the hook endpoint's guard is AUDIT.** Every act that changes
something is written to the book of record as `kind: 'remote'`, `event: 'control'`,
`channel: 'remote'` — the tag FR-10.3 names and the `SourceChannel` vocabulary
`src/shared/gates.ts` already uses. After this ships, the log can always answer *"did the
window do that, or did a script?"*. Every refusal is logged too, whether or not the caller
could have known: an attempt to approve a gate from a script is precisely what an audit
wants to find later.

**Reads are not logged.** A read changes nothing, and `log.jsonl` is append-only — a polled
`status` would push real events out of a reader's view permanently, and that cost cannot be
undone. The decision is declarative (`writes: boolean`, in the same table as the refusal
list) so it is a fact a test can assert rather than a habit a handler might forget.

### A separate address from the hook endpoint

Not a second path on the same server. The hook endpoint authenticates a per-spawn token
belonging to an agent, and every agent's own process is handed that address in its spawn
plan. Hanging the Architect's controls off it would put them one forged envelope away from
an agent — which is precisely the party this surface must not serve.

### The harness advertises its address; the client does not compute it

A running harness writes `control-endpoint.json` into its home, atomically, and removes it
on a clean quit. `scripts/ephctl.cjs` reads it.

The alternative — the client re-deriving the sha256 in plain JavaScript — would be a second
implementation of a rule that must agree with the first, which is the defect class this
repository names by name. It also gives the client a good answer to its most common failure
without a connection attempt: **no harness is running**, said in English, naming the home.
`ECONNREFUSED` is not an answer to that.

## Consequences

- `docs/EXIT-M8.md` §1 is runnable end to end without a mouse. That is the point.
- A gate still cannot be approved from a script, and never will be through this surface.
  If that is ever wanted it is a new ADR, not a new verb.
- Anything running as the Architect on this machine can operate the company. That is the
  same standing as `~/.ephesus`, the engine's own credentials and the hook endpoint; it is
  stated in `docs/THREAT-MODEL.md` §3 and §5 rather than left implied.
- `log.jsonl` gains one row per control act. On the shipped verbs that is a handful per
  session, not a stream, because reads are excluded.
- `DIAGNOSIS.md` gains a *the control surface* row, which reads `working` only once a
  script has actually driven the company — never because the endpoint merely came up.
- The client lives in `scripts/`, outside `productionFiles()`, so the coverage gate cannot
  see it. Stated rather than hidden: it is mitigated by `test/scripts/ephctl.test.ts`,
  which spawns the real file against a real server, and by the client holding no verb
  table, no validators and no prose — there is nothing in it to be wrong about except
  argv parsing and socket plumbing, and both are tested.

## Alternatives considered

**Give the runner desktop control, or have the Architect click.** Refused by the Architect.
Both leave the defect in place: the controls stay buried, and the criterion stays
unrunnable by anybody who is not at the machine. The exit run would have passed while
measuring the wrong afternoon.

**A CLI that re-implements the actions.** Two implementations of consent, of activation, of
convening — and the first divergence would be silent. `Pick<IpcDeps>` is what makes that
structurally impossible rather than merely discouraged.

**A token, or a TCP port with auth.** A token is a new secret against ADR-0010; a port is a
larger attack surface than the design needs, on a machine where the socket already gives
exactly the reach every other harness credential gives.

**Reuse the hook endpoint.** Rejected above: agents hold that address.

**Allow gate approval "just for the exit run".** The pressure for this comes from the exit
run itself and it is wrong on the run's own terms — §6.1's last clause is about zero
un-gated destructive actions, so a run where a script could approve gates proves nothing.

**Log every verb, reads included.** Rejected: append-only means the cost is permanent, and
a `status` polled once a second would bury the events an audit is for. The `writes` flag
makes the exclusion a declared fact rather than an omission.
