# M8.11 — Engine honesty

**Date:** 2026-09-07
**Branch:** `feature/m8-11-engine-honesty` (cut from `main` at `cb535b3`)
**Register items:** DD-2, C1, C4
**Normative:** [ADR-0024](../adr/ADR-0024-claude-only-for-the-mvp.md) — this
package implements it; it does not decide it.

---

## 1. Problem / motivation

Ephesus registered three engine adapters and advertised five. Two of the five —
`grok`, `opencode` — have never had an adapter in the tree at all. That is not a
missing feature; it is a set of **silent wrong answers**, which is the failure
class invariant §7 exists to forbid:

| The claim | What happened |
|---|---|
| A hire may declare any engine | The hire schema accepted any engine string, and both partial adapters were registered as spawnable. |
| A profile's autonomy reaches the engine | `codex.ts` and `gemini.ts` map autonomy to nothing. The grant was dropped. |
| An agent continues its own work (ADR-0013) | No Stop hook ⇒ no continuation loop ⇒ the agent stopped after one turn. |
| The floor shows what an agent is doing | No hook stream ⇒ the avatar asserted a confident `idle` for it for ever. |
| `README.md:105` sold five engines "as fully-capable agents" | See above. |

A codex agent did not error. It ran once, reported idle, ignored the autonomy it
was granted, and the activation screen printed "on codex" without a word.

**Half of this was closed on 2026-09-06 by [ADR-0031](../adr/ADR-0031-an-engine-declares-whether-it-can-enforce-autonomy.md)**,
and was verified by execution rather than rebuilt (§6.1).
`assertAutonomyEnforceable` refuses a `manual` or `supervised` hire on an adapter
declaring `autonomySupport: 'none'`. But it **returns early on `autonomous`** —
deliberately and correctly, because `autonomous` is the loosest level the
Architect can ask for, so an engine being stricter of its own accord costs a
stalled turn rather than an unpermitted action.

That closed the **safety** half and left the **honesty** half open. An
`autonomous` codex hire still spawned, and for that hire every failure in the
table above was still live. Closing it is what this package is for.

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/engines.ts` | `REFERENCE_ENGINE` + `isReferenceEngine` — the ADR-0024 policy in exactly one place. Hook grade `pty-heuristic` → `none`; `LEGACY_HOOK_SUPPORTS` + `storedHookSupportSchema` carry the read migration. |
| `src/shared/profile-activation.ts` | The refusal: a hire on a non-reference engine pushes a `reasons[]` entry and plans nothing. |
| `src/shared/registry.ts` | `hookFidelity` validates with the READ vocabulary, so a roster written by an older build still parses. |
| `src/shared/breaker.ts` | `protectionFor` keys off `none` and no longer names signals; `BreakerState.blindSignals` deleted. |
| `src/main/watch/breaker.ts` | Stops populating the deleted field. |
| `src/renderer/src/WatchPanel.tsx` | Drops "blind to repetition, error-rate". |
| `src/main/index.ts` | `CodexAdapter`/`GeminiAdapter` no longer imported or registered; Artemis is hired on `REFERENCE_ENGINE` by name. |
| `src/main/engines/{codex,gemini,types}.ts` | Declare and describe the renamed grade. |
| `scripts/reachability.cjs` | Allowlists the two unregistered adapters, citing ADR-0024 §4. |
| `README.md` | One engine, named; the seam described as a seam. |
| `test/main/engine-honesty.test.ts` | **New.** The rename as a schema migration, through the real `Agora` and a real roster file. |
| `test/shared/profile-activation.test.ts` | The refusal, in both directions, including the ADR-0031 hole. |
| `test/shared/engines.test.ts` | The vocabulary, the migration at the schema, and the predicate's near misses. |
| `test/conformance/adapter-conformance.ts` | `CONFORMANCE_SUBJECTS` — the roll-call. |
| `test/conformance/engine-adapters.test.ts` | Asserts all four subjects still run. |
| `test/{shared,main}/breaker.test.ts`, `test/main/engines/{codex,gemini}.test.ts` | Follow the renamed grade and the removed signal list. |

---

## 3. Implementation approach

### 3.1 One constant, and where the refusal lives

`REFERENCE_ENGINE` is a single name, not an allowlist: an allowlist invites an
entry, and ADR-0024's bar for a second entry is the conformance suite passing
for that engine on autonomy, notification and trust — not a commit.

The refusal went into `activationPlan`, beside the refusals already there. The
alternative, `EngineRegistry.get`, was rejected: its question is *does this build
carry an adapter*, and folding *may a hire run on it* into the same lookup would
make the conformance suite — which constructs `CodexAdapter` and `GeminiAdapter`
**directly, on purpose** — either fail or start special-casing Claude. That is
the one reading ADR-0024's "What this decision is NOT" forbids by name.

`activationPlan` is the right home for three reasons:

1. It is **both the preview and the plan activation executes** (its own contract
   says so), so the screen and the outcome cannot disagree about a refusal.
2. It is **pure**, so the refusal is table-testable.
3. It runs **before** agent ids are claimed, worktrees are cut or trust records
   are written — so a refusal is a refusal, not a half-activated company.

`AgentManager.spawn` keeps `EngineRegistry.get`'s "no adapter registered" as the
backstop for the spawn paths that never came through a profile (the
`agents:spawn` IPC).

### 3.2 The refusal teaches the rule

A guard whose message cannot be learned from is billed every time. The sentence
names four things: the engine declared, the decision that refuses it, what would
have gone wrong (`ignore the autonomy it was granted`, `stop after one turn`),
and the one edit that fixes it. Every clause is asserted.

Every offending hire is named, not just the first — an Architect fixing a profile
should need one pass, not one per hire. And the engine check runs **before** the
agent-id check, so a hire that is wrong twice reports the fault that matters;
that ordering is asserted rather than left to the shape of the loop.

### 3.3 The rename is a schema migration, not a find-and-replace

`hookFidelity` is validated on every entry of `agora/registry.json`.
`Agora.registry()` falls back to an **empty roster** on a parse failure, then
refuses to overwrite the file it could not read. So dropping `pty-heuristic` from
the enum without accepting it on read would, at the first boot after an upgrade,
cost a company every seat on its roster — and say so in one warning line.

`storedHookSupportSchema` is a `z.preprocess` over `LEGACY_HOOK_SUPPORTS`, used
**only** where a durable file is read. Deliberately not the same schema the code
writes with: one schema doing both would put `pty-heuristic` back into the
`HookSupport` type and hand every consumer a fourth case forever.

It terminates without a rewrite-in-place, because the value the roster is next
written *from* is the normalized one — one ordinary roster write retires the
string.

### 3.4 The Watch panel's sentence was wrong in both directions

`protectionFor` answered `blind: ['repetition', 'error-rate']` and the panel
printed it.

- It implied **burn-rate** still protects such an engine. It does not: burn-rate
  fires on `budgetState === 'breached'`, and a budget breaches on ledger rows
  compiled from a **transcript** that an adapter with no transcript reader never
  produces.
- It implied **hop-cap** was lost. It is not: hop-cap counts Hermes escalations
  and owes nothing to hooks.

So the blind set is **not a function of the hook grade at all** — it is a
function of two independent adapter properties, and a lookup keyed on the grade
cannot answer it honestly. Naming the signals correctly would need a per-adapter
claim no engine in this build can demonstrate, and a claim this repository cannot
establish by execution does not get written down. The grade now answers the one
question it can (is this breaker weaker), and `blindSignals` is deleted so the
wrong sentence is not one `.join()` away from the panel again.

### 3.5 Not built, deliberately

`AVATAR_STATES` gains no `unknown`. ADR-0024's Context lists the confident `idle`
as a symptom; its Decision has four items and this is not one of them. That is
consistent rather than an oversight: the confident `idle` exists because a
hook-less engine produces no events, and the refusal removes the hook-less engine
rather than giving its silence a nicer pose. SDD §6 names ten states, so an
eleventh is an SDD amendment, not an implementation detail. It becomes owed again
the moment ADR-0024 is revisited.

`ENGINE_IDS` keeps `grok` and `opencode` — see §5.

---

## 4. Mathematical / statistical details

None. This package is a policy predicate, a schema widening on one field, and a
set of deletions; there is no formula, threshold, statistical test or numeric
algorithm in it. The one ordering claim it makes — that the engine check runs
before the agent-id check — is asserted directly rather than derived.

---

## 5. Design decisions

Recorded in full in `docs/DECISIONS-LOG.md` under 2026-09-07 (M8.11, D1–D6).
The three that were genuine forks:

**Where the refusal lives.** §3.1. `EngineRegistry` was the tempting home and
would have collapsed the seam.

**The migration shape.** Bumping `REGISTRY_SCHEMA_VERSION` to 2 was rejected
because it makes the failure *worse*, not better: `z.literal(2)` refuses every
roster version 1 ever wrote, which is all of them. Accept-on-read is smaller and
it is the only option that keeps existing rosters loading.

**Keeping `grok` and `opencode` in `ENGINE_IDS`.** The objection is fair — a
schema accepting a string nothing can spawn is the README's lie in another form.
But the lie is that the string was accepted *silently*, and the refusal closes
it: a `grok` hire is now refused by the same sentence, with the same reason, as a
`codex` one, and that is asserted for all five non-reference ids. Narrowing the
roster was rejected because `EngineId`'s membership is written into ADR-0009's
own interface (so removing two would be an ADR edit, not an implementation),
because ADR-0024 is "deliberately reversible" and deleting the vocabulary makes
reversing it larger, and because the conformance table asserts every adapter's id
is in `ENGINE_IDS` — a check that only means something while that roster is the
*seam's* roster rather than the shipping list.

---

## 6. Verification

### 6.1 What was audited rather than rebuilt

The register's Tests line asks for the conformance table to "gain an autonomy
case". Before writing anything:

```bash
grep -rn "assertAutonomyEnforceable" src/ test/
```

```bash
grep -rn "REFERENCE_ENGINE\|non-reference" src/
```

The first returns the ADR-0031 work — the guard at `src/main/agents.ts:507`,
called from `:631`, and `describe('autonomy grade honesty (ADR-0031)')` at
`test/conformance/adapter-conformance.ts:280` running over all four subjects,
landed 2026-09-06. The second returned nothing: there was no refusal path of any
kind, anywhere, for any engine. Two register items already closed, one open;
nothing rebuilt.

### 6.2 The gate

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs && node scripts/check-readme-current.cjs
```

Observed on 2026-09-07: typecheck and lint clean; invariants ok with
`reachability 177/187 src modules reached, 10 unreachable by recorded decision`;
**219 test files, 4136 passed, 8 skipped, 0 failed**; coverage floors ok across
17 subsystems with no floor lowered and no ratchet taken.

### 6.3 The refusal, in both directions

```bash
npx vitest run test/shared/profile-activation.test.ts test/shared/engines.test.ts
```

- A `claude` hire plans, and the planned spawn carries `engine: 'claude'`. That
  case goes first: a refusal nothing passes could be a typo in the predicate.
- `codex`, `gemini`, `grok`, `opencode` and `custom` are each refused, and the
  sentence is checked clause by clause.
- **An `autonomous` codex hire is refused.** This is the one path ADR-0031
  deliberately lets through, and it is the single most important assertion in the
  package.
- A refused plan carries no hires and no triggers; every offending hire is named;
  the engine fault is reported ahead of a name fault.

### 6.4 The migration, through the real reader

```bash
npx vitest run test/main/engine-honesty.test.ts
```

A roster file carrying `"hookFidelity": "pty-heuristic"` is written to disk and
read back through a real `Agora`: the company survives, the grade normalizes to
`none`, and `fileWarnings()` is empty. The probe case in the same file writes a
grade no build ever wrote and shows what the missing migration would have cost —
`emptyRegistry` and one warning — so the migration test can fail.

### 6.5 The seam is still under test

The failure ADR-0024 warns about is not an argued deletion — it is a
`runAdapterConformance(...)` call quietly going away with the registration it
looked like it belonged to, after which the suite is green, shorter, and proves
less.

```bash
npx vitest run test/conformance/
```

`CONFORMANCE_SUBJECTS` is asserted to be exactly
`['fake engine', 'claude code', 'codex', 'gemini']`, and a second case constructs
both unregistered adapters and holds them to the contract in that same run.
Paired with `scripts/check-invariants.cjs`, which now fails if either adapter
becomes reachable again *or* stays unreachable without the ADR-0024 allowlist
entry, both halves of ADR-0024 §4 are mechanical rather than habitual.

### 6.6 Mutation pass

18 mutations over the guards this package adds — the predicate, the refusal at
its call site, the roster migration, the breaker disclosure and the conformance
roll-call — plus **one deliberate no-op**, because a harness that reports every
mutation killed cannot tell you when it has stopped running your tests. Results
in `docs/PROGRESS.md` under the M8.11 row.

### 6.7 Not proved

The live app was not started. `npm run dev` boots the real harness against the
Architect's own `~/.ephesus`, spawning agents and spending tokens, which is not a
side effect to take unattended. Everything above runs against real filesystems in
temp directories, a real `Agora`, real roster files on disk and the real
activation planner.

The refusal has not been observed against a *live* codex or gemini install,
because neither CLI is installed and authenticated here — the same reason
ADR-0031 declared `none` rather than guessing a flag. Nothing in the refusal path
depends on the engine existing: it is decided from the hire's declared string
before any process is contemplated.

---

## 7. Related docs

- [ADR-0024](../adr/ADR-0024-claude-only-for-the-mvp.md) — normative for this package
- [ADR-0009](../adr/ADR-0009-engine-adapters.md) — the adapter seam this scopes and does not weaken
- [ADR-0031](../adr/ADR-0031-an-engine-declares-whether-it-can-enforce-autonomy.md) — the safety half, landed 2026-09-06
- [ADR-0011](../adr/ADR-0011-watch-breaker-budgets.md) — the breaker consequence §3.4 corrects
- `docs/DECISIONS-LOG.md` — 2026-09-07, M8.11 D1–D6
- `docs/PROGRESS.md` — the M8.11 row and its evidence
