# ADR-0032 — The company asks before it starts

**Status:** accepted · **Date:** 2026-09-07 · **Relates to:** ADR-0029 (unbudgeted is the
default, which is what makes this urgent), ADR-0024 (the one engine a hire may run on),
ADR-0018 (company modes, the other thing the scheduler gates on), invariant §7 (every
degradation visible)

## Context

Until M8.12, booting Ephesus hired an agent.

`src/main/index.ts` computed the reference engine at the end of boot and called
`void artemis.start(orchestratorEngine)` unconditionally. Forty lines earlier it called
`scheduler.start()`. Nothing anywhere asked anybody first, and a grep of the tree for
`consent`, `firstLaunch`, `first-run` or `onboard` returned three hits, all unrelated
prose in comments. There was no consent machinery of any kind.

What that means concretely, on a machine that has just run `npm install && npm run dev`
for the first time:

- A real `claude` process is spawned under the user's own logged-in account, and its
  turns spend tokens against **their** subscription. Ephesus buys nothing and holds no
  billing relationship, which is precisely why it cannot spend on anybody's behalf
  without being told to.
- ADR-0029 made `unbudgeted` the shipped default, deliberately and for good reasons. So
  the spending that starts unasked also starts uncapped.
- Sixty seconds later the scheduler's first tick fires. On the Architect's own machine
  `~/.ephesus/triggers.json` shows `standup`, `retro` and `gym-metric-check` sharing the
  timestamp `1788631795998`, so the first tick fires all three together.

This was recorded as register item DD-6 and carried for the whole of M8 as "consent on
first launch — open". It is settled here rather than deferred to M7b because M8's exit
criterion is *a developer who is not the author, from a clean clone, following only the
README*, and a stranger's first thirty seconds are exactly what that measures. An exit
review that began with an unasked-for hire would be measuring the wrong afternoon.

## Decision

**Boot does not start the company until the Architect consents, and consent covers the
company starting work — not merely the hire.**

Three properties, and the third is the one that gets skipped:

1. **Persisted.** The answer is written to `~/.ephesus/config.json` and the question is
   asked once, ever.
2. **Specific.** The disclosure names what will happen: which agent is hired on which
   engine, that its turns spend tokens on *your* subscription, what the company-wide
   daily ceiling is (or that there is none), and which cadences start with what
   intervals. It is computed from the live configuration, never written as prose.
3. **Visible while withheld.** A withheld company is reported through the degradation
   channel (`source: consent`, `cause: consent/not-granted`) and shows a banner above
   every panel. Invariant §7 exists because a stopped company and a finished one look
   identical, and this is the case where that is most true: quiet terminals, still
   avatars, no errors, and nothing was ever going to happen.

### What consent covers, and why it is not just the hire

**Both `artemis.start` and `scheduler.start()`.** "The gate guards the hire" and "the
gate guards the company starting work" are different products, and only the second one
answers the register. A gate on the hire alone would still let standup, reflection, retro
and the gym metric check fire on the first tick after boot.

The trigger clock is withheld **whole** rather than per-trigger. `Scheduler` already
supports a per-trigger `enabled()` predicate — it is how ADR-0018's company modes reach
it — and using it here would have been the smaller diff. It was refused for one reason:
a trigger armed later by a restored activation (ADR-0027) would be armed *unguarded*,
because nothing would have added a consent predicate to it. Withholding `start()` covers
every trigger, including the ones that do not exist yet.

What is deliberately **not** covered: the boot-time Harbor probe and its first `gh`
ingest. They read; they spawn nothing, spend no tokens, and raise no incident without the
scheduler. Gating a read-only local command would tell a stranger their consent was
needed for something it was not.

### Absent means ASK

`ensureHarnessHome` seeds a file only when it is **absent** — deliberately, because
`~/.ephesus/` is the Architect's copy and the harness must never overwrite a decision
they made. The consequence bit for real three days before this ADR: the Architect's
`gate-policy.json` predated ADR-0031's shipped policy and had never received it, so it
sat silently looser in three places, including having no `outbound` rule at all.

A consent record has exactly that shape — **every** install that exists today has none.
So `undefined` must read as "ask". It must not read as "assume yes", which would make the
gate a no-op on every machine anybody actually has; and it must not read as a durable
"no", which would be a refusal nobody could lift. A record is written only on a grant. A
decline is simply the absence of one: the withheld state *is* the question, and it stays
on screen until it is answered.

A **corrupt** `config.json` also reads as "ask", and this falls out of the existing design
rather than being added: `configSchema` is strict, so a malformed consent block
invalidates the whole file, `home.ts` runs on `defaultConfig`, and `defaultConfig` carries
no consent. A damaged file must never be the thing that authorises spending.

### The record carries which disclosure was agreed to

`{ grantedAt, terms }`. `terms` is the `CONSENT_TERMS_VERSION` the grant was made
against. If what consent covers ever widens, bumping that constant asks again rather than
silently carrying an old, narrower agreement forward onto new behaviour. A grant made
against a *newer* version than this build asks about is honoured — that is a downgrade,
and re-asking somebody to consent to a subset of what they already allowed is an
interrogation rather than a safeguard.

`grantedAt` is never rewritten by a later grant. It says when consent was *first* given,
and overwriting it would erase how long the company has been authorised.

### It lives in `config.json`, not a file of its own

Invariant §9 asks for a `schemaVersion` and a validator in `src/shared/`. `config.json`
has both. A second durable file would be a second thing to seed, migrate and keep honest,
for one record's worth of state that is exactly the same kind of thing `mode` and
`everEnabledImproving` already are.

### The decision is a pure function, and it does not live in `index.ts`

`decideConsent` is in `src/shared/consent.ts`; the ordering is `CompanyStart` in
`src/main/consent.ts`, with every effect injected. `index.ts` keeps the construction and
one `boot()` call.

This is not style. Boot wiring in `index.ts` has produced three dead-code findings in
this repository — the Herald, M7.2's inert trigger, M7.7's silent standup — every one of
them behind a green suite, because nothing short of a real Electron boot could reach the
code. A refusal that could not be tested *in the direction of refusing* would be the
worst possible member of that set.

## Consequences

- **A grant takes effect in the running process.** `grant()` hires and starts the clock;
  it is not an instruction to restart. A button that required a restart would be a lie.
- **A grant that cannot be written down does not start the company.** Work running under
  a consent the next boot will not find spends tokens against a record that does not
  exist, and asks again with agents already going. The failure is reported
  (`cause: consent/unwritable`) and the banner stays up.
- **Every existing install will be asked once**, including the Architect's. That is the
  intended behaviour of "absent means ask" and not a migration defect.
- **The first tick after consent still fires standup, retro and the gym metric check
  together**, because a disabled trigger is skipped without stamping its clock. That is
  now consented work rather than unasked-for work, which is the whole distinction this
  ADR draws. Whether those three should also be staggered is a separate question and is
  not decided here.
- **Tests must not grant consent in a shared helper.** The shipped default is what a
  stranger meets; a suite that went green because a rig quietly answered the question
  would be testing a product nobody ships. The two IPC-registration rigs that needed the
  new dependency pass `{} as never` and say why.

## Alternatives considered

**Defer to M7b, with onboarding.** The original plan. Refused because M8's exit measures
the first afternoon, and the exit review would otherwise have been conducted against the
behaviour it exists to find.

**Gate only the hire.** Smaller, and it is the version that gets built by accident. It
leaves the second half of the register's complaint entirely intact.

**A per-trigger `enabled()` predicate.** The smaller diff, using a seam that already
exists. Refused because a trigger armed later — by a restored activation — would be armed
without one, and nothing would report the day that started being true.

**A separate `consent.json`.** Refused under invariant §9's own reasoning: `config.json`
already carries durable, schema'd, validated state the app did not compute.

**Persist a decline as well as a grant.** Refused because there is nothing to do with
it. Both a decline and an absence mean "not granted, keep asking", and a stored "no"
would only add a state that has to be cleared before the company could ever start.
