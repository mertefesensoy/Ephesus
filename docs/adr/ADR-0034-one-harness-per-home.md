# ADR-0034 — One harness per home

**Status:** accepted · **Date:** 2026-09-09 · **Relates to:** ADR-0004 (the single
committer, which is what two instances break), ADR-0033 (the control surface, whose CI
run found half of this), ADR-0002 (the event plane), ADR-0032 (the consent gate, whose
shape this borrows), invariant §4 (single committer), §5 (append-only), §7 (every
degradation visible)

## Context

A harness home holds **one book of record and one single committer**. Nothing anywhere
checked that only one harness was using it.

This is not hypothetical. `docs/EXIT-M8.md` §4 already warns a reader that killing the
`npm run dev` wrapper leaves Electron alive, and that a second boot against one home means
"two harness instances, one book of record and two single-committers" — and it says where
the warning came from: **the duplicate `seq` in the Architect's own `log.jsonl`**, on
2026-09-07. The hazard was documented, and unguarded.

M8.14 then found half of it by accident. Its CI run — on linux, against a test written on
Windows — showed that the control endpoint's stale-socket cleanup ran unconditionally:

```ts
if (process.platform !== 'win32' && fs.existsSync(endpoint)) fs.rmSync(endpoint, { force: true })
```

On POSIX a second instance **deleted the first one's live socket** and bound over it. The
first harness then answered nobody while `ephctl` talked to the second. Windows refuses a
duplicate pipe name, so `start()` failed on its own and the hole was invisible on the
machine the code was written on.

`src/main/hooks.ts` — the **event plane**, the one every agent posts to — carried the
identical line. That was recorded as an open question for the Architect at the M8.14
session report rather than fixed in that package.

## Decision

**Three rules, and only the third is new in kind.**

### 1. Both endpoints refuse an address something is already serving

`HookServer.start()` and `ControlServer.start()` probe the address before touching
anything. A served address is refused with a sentence — *"another harness is already
listening on … stop the first one"* — rather than with `EADDRINUSE`. Only then is a
leftover cleared, and only on the platform that has one.

**The probe runs on both platforms deliberately.** The first attempt at this fix put it
inside the `process.platform !== 'win32'` branch, and two mutations of it then survived
the local mutation pass — not because they were equivalent, but because nothing on win32
could execute the code they changed. *A guard only one platform runs is a guard only one
platform's tests can check.*

### 2. The company does not start on a home somebody else is working on

Refusing an endpoint stops that plane being stolen. It does not stop the second instance
**running**: it would still hire agents and still commit through a second single committer,
which is the damage that actually happened.

So `CompanyStart` gains `blockedBy()`, consulted in **`startWork`** — the single funnel
both `boot()` and `grant()` already pass through, so neither path can forget it. On a busy
home the second instance boots, opens its window, **hires nobody, arms no schedule**, and
reports `agora/home-occupied` naming the owning process. This is the consent gate's shape
(ADR-0032) because it is the consent gate's situation: a company that is deliberately not
working, which must not look like one that has finished.

Consent given anyway is still **recorded** — the Architect's answer to the consent question
is their answer — and the outcome says `ok: false` with the reason, so `ephctl
consent:grant` cannot print *"the company is starting"* while nothing starts.

### 3. Liveness is probed, never locked

There is **no lockfile**. A pidfile would need a schema and a validator (invariant §9), a
stale-lock policy, and a release on every exit route — including the ones that do not run,
which is how stale locks are born. Instead the check probes what a live harness is already
serving: its two endpoints, plus the `control-endpoint.json` ADR-0033 already writes, whose
`pid` lets the refusal name the owner.

**The address file is a courtesy, never the authority.** A stale one left by a killed
harness does not make a home occupied — only an endpoint that answers does. Refusing to
start the company over a leftover *file* would turn every crash into an outage.

## Consequences

- Two harnesses on one home is now a refusal with a reason, not a silent corruption.
- A crashed harness leaves nothing to clear by hand: the next boot probes, finds silence,
  and takes the home.
- `DIAGNOSIS.md`'s *book of record* row reads `WAITING FOR YOU` on a busy home — not
  `BROKEN`, because nothing has gone wrong; the harness refused to let it.
- **Residual, stated rather than hidden:** a first harness whose endpoints BOTH failed to
  bind is invisible to the probe, and a second one would find the home free. That first
  harness is already crippled and says so through its own degradations; buying this last
  case would cost the stale-lock problem this design exists to avoid.
- Two instances on **different** homes are unaffected, which is the case that actually
  happens — every test, and every `EPH_HOME`.

## Alternatives considered

**A pidfile lock.** The conventional answer, and it brings a stale-lock policy, a release
path on every exit route, and a schema and validator under invariant §9 — all to answer a
question two live sockets already answer for free.

**Fix `hooks.ts` only.** The narrow reading of the M8.14 must-ask. It stops the event plane
being stolen and leaves the duplicate-`seq` hazard exactly where it was: a second instance
would still boot, hire and commit.

**Quit instead of refusing to work.** Blunt and unambiguous, and it takes away
`DIAGNOSIS.md` and the Watch panel at the moment they are most wanted. There is also no
precedent for it in the quit path.

**Carry on with a visible degradation** (what a bind failure does today). Smallest change,
and it leaves a second instance hiring agents and committing to a shared Agora — the
failure this ADR exists to prevent.
