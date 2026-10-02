# ADR-0036 — Two engine kinds: a wrapped CLI, and a native agent the harness owns

**Status:** accepted · **Date:** 2026-10-02 · **Supersedes:** one sentence of
[ADR-0009](ADR-0009-engine-adapters.md) — *"wrap CLIs, never reimplement an agent
runtime"* — and nothing else in it · **Extends:** ADR-0002, ADR-0013, ADR-0014,
ADR-0031 · **Relates to:** ADR-0024 (the MVP's one engine), ADR-0035 (the prompt
that cannot be answered)

**Accepted 2026-10-02** on the Architect's verdict on DD-M9-2 of the M9 plan
([`../M9-PLAN.md`](../M9-PLAN.md)): "Own loop, own CLI in TS". DD-M9-5 (a third
TypeScript build target) settled the build shape the same day. **The decision is
recorded; the engine is not built** — the Architect approved the planning and
documentation of M9 and asked that the build not start yet (DECISIONS-LOG
2026-10-02).

## Context

ADR-0009 decided in August that Ephesus wraps the agent CLIs the Architect already
pays for, and its reasoning was sound: those runtimes "own tool use, permissions,
context management, transcripts, and their own auth/limits", and rebuilding them
would make Ephesus "an agent framework — a different, worse product with a permanent
maintenance war". The same record kept the alternative open — *"SDK embedding …
kept open as a future adapter* kind *behind the same interface"* — and ADR-0024 said
when to reopen the question: when a second engine is wanted as a product.

Six weeks of running the company have produced a list of limits that are all the
same limit. Each is recorded, each was closed as far as a wrapper can close it, and
each leaves a residual that only the owner of the loop could remove:

| Record | What the wrapper could not do |
|---|---|
| ADR-0035 | answer the engine's own permission prompt; "an agent that reaches a prompt for something undeclared is still parked for the rest of the run" |
| ADR-0026 | stop the engine loading hooks the harness did not write, except by switching every settings source off |
| ADR-0028 | stop the engine replacing its own binary mid-run, except by an environment variable the engine happens to honour |
| ADR-0031 | carry a composed autonomy level into two of three engines at all |
| `evaluateGate` | permit a `tool-permission` — the harness "has no action to permit there, the engine does" |
| `TranscriptReader` | know the engine's cost when the engine chooses not to say |

And one thing no wrapper can do at all: run a model the vendor does not ship a CLI
for — a local model, which is what the Architect's direction of 2026-10-02 names as
the capability whose absence "cripples" the project.

The three harnesses the Architect pointed at (M9-PLAN §3) each own their loop, and
owning it is what lets them instrument, bound and evaluate it. None wraps a
third-party CLI.

## Decision

**Ephesus has two engine kinds, behind one adapter surface.**

1. **`wrapped`** — a third-party CLI in a PTY, with hooks installed by the harness
   (today: `claude`; the unregistered `codex` and `gemini`). Everything ADR-0009
   says about these stays in force.
2. **`native`** — Ephesus's own agent program, `eph-agent`, which the harness
   spawns in a PTY like any engine, and which talks to a model through a provider
   seam (ADR-0038, proposed). It owns its loop, its tool dispatch, its context
   management and its transcript.

**The adapter surface does not change.** `EngineAdapter` keeps every member it
has; `native.ts` is a fourth implementation that passes the same conformance table
on the same rows — hook grade both directions, autonomy both directions, settings
hygiene, transcript honesty. The native adapter declares `hooks: 'native'` because
the program emits the harness's own hook envelopes at every lifecycle point, and
`autonomySupport: 'enforced'` because it has no permission prompt of its own: the
Watch's gate *is* its prompt (ADR-0039, proposed). Both declarations are claims the
existing conformance suite checks against reality; a native adapter that could not
back them would fail the table like any other.

**Both planes stay** (ADR-0002). The native program prints a readable transcript to
its PTY, so the terminal never lies, and the floor still projects only events. Owned
spawn (ADR-0014) and the Stop-hook loop (ADR-0013) stay: at the end of a turn the
native program asks the harness the same Stop question over the same endpoint and
obeys the same reply, block cap and `stop_hook_active` guard.

**What a native agent may touch is exactly what a wrapped one may.** Its worktree,
its granted tool directories, its mailbox and its runbooks — the `tool-grants.ts`
containment rule at every path. It writes files in its own worktree and mails
through its outbox; the Agora's single committer is unchanged (ADR-0004).

**The sentence superseded.** ADR-0009's rule becomes: *wrap CLIs where a vendor
ships one worth wrapping, and own the loop where the harness must be able to
measure, bound and permit what happens inside it.* The rest of ADR-0009 — the
reference adapter, the conformance surface, hook grades, settings hygiene,
self-healing installs, adapters never leaking into core — is unchanged and now
governs four implementations instead of three.

## Options considered

- **Keep wrapping only, and finish the `codex` and `gemini` adapters.** Closes
  ADR-0031's gap and nothing else in the table above; cannot reach a local model
  at all. Rejected because it does not address the direction given.
- **Embed a vendor agent SDK as the loop.** Attractive for headless workers and
  the shape ADR-0009 named. Rejected as the *primary* native kind because it keeps
  the vendor's permission model, loop and context policy — the constraint being
  removed — and binds "native" to one vendor's models. It remains a legitimate
  future provider *behind* the seam, not a kind of its own.
- **Own the loop as a plain `.mjs` shim like `eph-hook`.** Zero build change.
  Rejected: an agent loop is not a shim, and invariant §1 says strict TypeScript
  everywhere; the shims' ABI discipline (no native imports, system `node`) is kept
  for `eph-agent` by construction instead (DD-M9-5).
- **Drop the PTY for native agents and run them in-process.** Simpler. Rejected:
  it collapses the two planes, removes the authentic terminal FR-1.1 promises, and
  puts a model loop inside the harness process that NFR-5 says no agent crash may
  take down.

## Consequences

- **Ephesus inherits the hard problems ADR-0009 declined** — for one engine kind,
  and bounded by everything the harness already owns. The native program owns the
  loop, tool dispatch and context; hooks, mail, memory, the ledger, gates and
  grants are the harness's already and are reused unchanged. M9-PLAN §6 sizes this
  as the largest package since M3 and says so.
- **The permission prompt becomes a gate** for native hires (ADR-0039): a hold
  with a `gateId`, settled in WATCH, refused to a script by ADR-0033, counted by
  the bench. For wrapped hires nothing changes — ADR-0035's residual stands for
  them and the record must keep saying so.
- **A second kind of money.** A provider key is a broker secret (ADR-0010), and a
  local endpoint reports `costUsd: null`, shown as *not reported*, never as free
  (ADR-0011). Consent (ADR-0032) names which a hire spends before anything starts.
- **A new trust boundary** — the native agent's tool dispatcher — enters the threat
  model (§3, §5), and §6.7's "not hardened against a malicious agent" moves one
  layer closer, with no OS sandbox in M9. The record must say what is and is not
  bounded, in that section, before the first native hire runs against a real
  repository.
- **R17 (M9-PLAN §11):** the risk NFR-12 and ADR-0024 both warn of — engine
  knowledge leaking into core — now has a fourth adapter to leak from. The
  containment is the one that has worked: the import-boundary lint, and a
  conformance suite with four subjects rather than one special case.
- **ADR-0024 is not reopened by this record.** The MVP still ships `claude`; a
  native engine becomes a *product* engine on ADR-0024's own bar — the conformance
  table on autonomy, notification and trust — and the M9 exit requires exactly that.

## Prior art

ADR-0009's "Options considered", which named this kind and kept it open. The three
harnesses studied in M9-PLAN §3 (Odysseus `src/agent_loop.py`; Hermes Agent
`run_agent.py`), each of which owns its loop behind a provider seam and treats the
sandbox as a backend — read as data, at no pin, to be re-read by the Stoa at one.
