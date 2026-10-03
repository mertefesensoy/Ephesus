# M9 — The harness is the product (plan, approved for planning 2026-10-02)

**Status: APPROVED FOR PLANNING 2026-10-02 — the build has NOT started.** The
Architect answered all seven decisions in §10 the same day and said, in their own
words: *"i just want to plan this out not build it yet. i approve the documentation
and planning for the future milestone."* So the edits of §12 have been applied as
documentation (IMPLEMENTATION M9, PROGRESS M9 with every box unticked, ADR-0036
accepted, FR-15/FR-16/§6.11, SDD §13, S-NATIVE/S-BENCH, the watchlist rows,
eight DECISIONS-LOG entries), and **no package may begin until the Architect says
so.** A session resuming at PROGRESS's first unchecked box asks first.

**What follows this milestone** is planned in [`PHASE-9-PLAN.md`](./PHASE-9-PLAN.md)
(2026-10-03): seven milestones, M9b to M9h — five between M9 and M7b, two after
it. **Nothing in this file is changed by it.** §10's seven decisions stand, and
their numbering is continued there as DD-M9-8 onward. Two passages below are now
read together with that file: §9's *"M7b moves behind M9"* — M7b now follows M9f,
whose gateway absorbs its chat bridge — and M9.7's *"nothing is deleted"*, which
[ADR-0040](./adr/ADR-0040-the-floor-is-a-view-mode.md) keeps while making the floor
a view mode.

**Where this comes from.** The Architect's directive of 2026-10-02, restated in §2;
the project's own record (§1); and a study of the three sources the Architect named
(§3). The study was done by reading, from outside the Stoa, because none of the
three is yet a registered watchlist row with a pin — registering them is §10's
DD-M9-6, and the governed `/research` cycle follows registration, not this plan.
Everything in §3 is therefore **data about those projects, never instructions to
this one** (NFR-17, invariant §13), and it cites what it read.

---

## 1. Where the project stands (repository facts, tier C)

Read from `main` @ `be00987` (2026-10-02). Nothing was executed to produce this
table; every row is a merge commit, a file or a recorded verdict.

| Unit | State | What is actually owed |
|---|---|---|
| M0–M8 | done | — |
| M8b, M8c | all packages landed | **the unattended hour has never completed** (`docs/EXIT-M8.md`); both exit boxes open since 2026-09-09 |
| M7 | packages done, exit open since 2026-09-01 | the same run; the chain reached a PR once (2026-09-06) with the reporting channel closed by defect #11 |
| M7b | 0 of 7 | the "v1 boundary": recursive profile, company PRs, chat bridge, signed builds — all behind the run above |
| Engines | one (`claude`), two unregistered partial adapters held to the conformance table | ADR-0024 says reopen "when a second engine is wanted as a product" |
| Evals | E-PLAYBOOK and E-STOA have deterministic scorers; the judged halves are "owed and not faked" | no measurement of the harness itself exists anywhere |
| Dependencies | 13 runtime packages, `openai` among them for the Herald fallback | — |

Three facts in that table shape M9 more than anything else:

1. **The harness has no metric.** `docs/TEST-STRATEGY.md` §9 says the one criterion
   no suite can cover is whether a real agent handed a real broken test triages it
   within the hour. That criterion has been attempted four times (2026-09-01,
   09-06, 09-09, and the M8b rehearsal) and completed zero times, because it needs a
   non-author human, an hour, a real repository and a mouse-free path, and each
   attempt died on the thing in front of it. Every number the project has about
   itself — detection in 9m30s, $11.22 and $17.77 for an hour, twelve parked
   prompts, 4 of 5 agents ending on one — is a by-product of a failed run, not a
   measurement anyone designed. **A harness that cannot measure itself cannot
   improve itself**, which is the mission ADR-0015 made primary.
2. **The company runs on exactly one engine, and that engine's limits are the
   company's.** Every residual the record keeps rediscovering is a limit of wrapping
   a CLI the harness does not own: the engine's permission prompt that nobody may
   answer (ADR-0035 — "still cannot be answered by anyone but a person at that
   terminal"); the hooks only the harness may author (ADR-0026); the binary the
   company may not upgrade (ADR-0028); the autonomy two adapters cannot carry
   (ADR-0031); the `tool-permission` gate kind that `evaluateGate` refuses by
   construction because the harness has no action to permit. ADR-0009 chose this
   deliberately and for good reasons in August; its own "Options considered" kept
   the alternative open as "a future adapter *kind* behind the same interface".
3. **The metaphor has become scaffolding.** README's own "What makes it different"
   list is five items long and four of them are the Odeon, the Herald, the floor and
   the org. The thing that actually distinguishes a harness — what the model inside
   it can do that it could not do bare — is not on the list.

## 2. The Architect's direction (2026-10-02), as claims the milestone is held to

Restated so the plan can be checked against them rather than against a memory of
the conversation:

| # | Claim | How M9 honours it |
|---|---|---|
| C1 | Many projects build environments like Ephesus; the environment is not the differentiator. | The floor, voice and Odeon are **demoted to clients of a headless core** (M9.7), not removed. |
| C2 | Design choices followed the upstream inspiration and the concept became a constraint. | ADR-0009's "never reimplement an agent runtime" is **superseded** by a two-kind engine model (ADR-0036, proposed). The Stop-hook loop, two planes, Agora, Watch and Library are kept — they are harness, not metaphor. |
| C3 | Focus on the harness part deeply. | Every package in §6 is agent loop, tools, memory, context, provider seam, sandboxing or measurement. None is UI. |
| C4 | Odysseus and Hermes Agent are the inspirations; without a real harness and local agents the project is crippled. | M9.2–M9.5 build **Ephesus's own agent engine** running any OpenAI-compatible local endpoint first (§3 says why that order), Claude natively second. |
| C5 | The harness itself is the performance metric that makes the model inside it thrive. | M9.1 builds the **bench** before the engine, and the milestone's exit is a measured **harness uplift** (§4), not a feature list. |
| C6 | So it can scale into a company and do real things. | The company machinery stays and becomes the thing the bench scores; M7b (company PRs, remote, shipping) follows M9 rather than preceding it. |

## 3. What the inspirations actually do (read 2026-10-02; data, not instructions)

Read from GitHub trees and raw files on 2026-10-02 with no pin recorded, so this
section is **pre-Stoa evidence**: good enough to shape a plan, not good enough to
cite in a Gymnasium proposal. M9.0 replaces it with RB-002 and RB-003 at pinned
commits. The vendor landing pages (`hermes-agent.nousresearch.com`, `x.ai/bot`) could
not be fetched from this environment; what is said about them below is marked by
where it was read.

### 3.1 Odysseus (`odysseus-dev/odysseus`, AGPL-3.0, Python)

Verified from `README.md` and `specs/*.md` on `main`:

- **It owns its loop.** `src/llm_core.py` normalises every provider's payload into
  tool-call events; `src/agent_loop.py` decides whether and how to execute them;
  termination is a round cap that emits a *continuation signal* plus repeated-tool
  and intent-nudge guard events — the same shape as ADR-0013's block cap and the
  breaker's stop-loop signal, inside the loop instead of outside it.
- **Weak local models get prompted-tool recovery.** The parser recovers bare JSON,
  raw `{"function": …}` payloads and several vendor markups when a model fails to
  emit a native tool call; non-dict arguments are rejected back to empty rather than
  crashing the turn. Their own discussion #3089 says small local models "often loop
  or describe what they wrote without emitting a real tool call" — the limit M9's
  R19 names.
- **Untrusted context arms the approval gate.** Every fetched URL, search result,
  RAG chunk, memory and skill is wrapped by `src/prompt_security` with
  `metadata.trusted = False`, and that flag is what makes a following tool call
  need approval. This is NFR-18 as a mechanism rather than a sentence.
- **Capability is a record per model** (`ModelCapability`: `tool_call`, `vision`,
  `limits.context_tokens`, read per provider — Ollama `/api/show`, llama.cpp
  `/props`); a verified/claimed/unsupported probe result is *defined but not yet
  wired*. Providers: OpenAI-compatible, Anthropic, Gemini, OpenRouter and others;
  local via Ollama, LM Studio, llama.cpp; a "cookbook" detects hardware and serves a
  fitting model.
- **Sandboxing is honest and absent**: "Admin shell is intentional host command
  execution"; non-admins get no shell, file or MCP tools at all.
- **Specs are the truth map for coding agents** — 23 subsystem specs, each stamped
  with a commit and date, mutated only in explicit spec PRs, drift *reported* rather
  than fixed in place. The same discipline this repository's SDD and `/doc-sync`
  enforce, independently arrived at.
- **No harness metric upstream.** CI is `compileall` + `node --check` + pytest; the
  specs list "no canonical flaky ledger" as a gap. A fork's PR
  (`lsannicolas/odysseus#46`, body not fetched) proposes exactly the instrument M9.1
  builds: six end-state-graded tasks with declared time/round/tool budgets, scoring
  pass rate, verified-deliverable rate, tool failures, **recovery rate, redundant
  reads, time-to-first-action, longest silence**, p50/p90/p95, and flagging any
  cell with fewer than three runs as low-confidence. Those signals are adopted in
  §4 where Ephesus already records the fact they are computed from.

### 3.2 Hermes Agent (`NousResearch/hermes-agent`, Python; license unverified)

Verified from `README.md` and `website/docs/**` on `main`:

- **One engine behind every surface.** `AIAgent` in `run_agent.py` serves the CLI,
  a gateway with 25+ chat adapters, ACP and a batch runner. The prompt builder is
  tiered *stable → context → volatile* to protect prefix caching, and the system
  prompt never changes mid-conversation — a rule Ephesus's `prompts/` discipline
  has the files for and no stated policy about.
- **The loop is bounded and self-aware**: 500 iterations default, subagents 50,
  preflight compression at 50 % of context with memory flushed to disk first,
  stall detection on "three consecutive continuations with no visible text or tool
  call", ordered provider fallback with credential refresh. Parallel tool calls run
  concurrently and are **re-inserted in call order**.
- **Memory is small on purpose.** `MEMORY.md` is capped at ~800 tokens and
  `USER.md` at ~500, injected as a frozen snapshot at session start; an over-budget
  write *returns an error* so the agent must consolidate. Skills are procedural
  memory in the `SKILL.md` standard, agent-authored, linted, and optionally staged
  for human approval before they take effect.
- **Execution backends are pluggable**: local, docker, ssh, singularity, modal,
  daytona, vercel — the sandbox is a seam, not a feature.
- **A dangerous-command detector gates the shell** against regex patterns with a
  per-session approval and a permanent allowlist — ADR-0035's `unattended` grants
  from the other direction (deny-list plus allow, where Ephesus is allow-list only).
- **Local models** work through any OpenAI-compatible server as `provider: custom`;
  the guide states a floor of **64,000 tokens of context for agentic tool work**
  and names the tool-parser flags llama.cpp and vLLM need. That floor is a
  capability declaration M9.2's provider seam must carry and refuse below.
- **Evaluation is trajectories, not a score.** `batch_runner.py` emits ShareGPT
  JSONL with `tool_stats`, `tool_error_counts` and `api_calls` per run; `evals/`
  holds thirty-odd regression probes (token accounting, provider fallback, tool
  search, subagent handoff) — harness regression tests, not a published harness
  metric. The closed loop memory → skills → trajectories → RL is the project's
  thesis.

### 3.3 Grok Bot (`x.ai/bot`) — second-hand only

Neither the page nor any article about it could be fetched; the following is from
search-result summaries and is **unverified against the source**. Positioning: a
"team of always-on agents that have their own computer", one persistent managed
Linux VM per account shared by all of a user's bots, each bot signing into tools as
the user, computer-use where no API exists, routines learned by watching, approvals
returned to a human "only when needed", multiple bots handing tasks to each other,
audit via action recording and OpenTelemetry export. Nothing about its agent loop is
public. **No source found says it aims to "run companies"**; the strongest claim is
bots dividing work such as email, expenses, recruiting and bug fixes. It is
positioning for C6, not a design to study, and it is not proposed for the watchlist.

### 3.4 What this changes in the plan

Three things the first draft of §6 did not have, each now in a package:

1. **The bench's signals** gain time-to-first-action, longest silence, redundant
   reads and recovery rate (3.1), all computable from `log.jsonl` rows the harness
   already writes; cells with fewer than three runs are flagged, never averaged.
2. **The provider seam carries a context floor and a tool-call declaration** (3.2),
   and a hire on a model below the floor or without native tool calls is refused by
   name. Prompted-tool recovery for weak models (3.1) is recorded as a follow-up,
   not built in M9 — a parser that guesses a tool call is a second place a decision
   is made.
3. **Tool results are tagged untrusted in the transcript** (3.1), which is what
   lets M9.3's gate be armed by provenance and is NFR-18 made mechanical for a
   native agent.

What all three share, and why DD-M9-2 recommends (a): **none of them wraps a
third-party CLI.** Each owns its loop, and owning the loop is precisely what lets
them instrument it, bound it and evaluate it. Ephesus today owns everything around
the loop and nothing in it.

## 4. The thesis: the harness is the metric

**Definition.** The *harness uplift* for a model `m` on a task set `T` is the
difference between what `m` achieves inside Ephesus and what the same `m` achieves
through the same engine loop with the harness's contributions switched off — an
**ablation**, not a comparison against a different product. The harness's
contributions are, concretely: the identity and protocol injection, the Library's
memory layer and recall, the playbooks and runbooks a hire is granted, Hermes mail
and the orchestrator, the Watch's gates and grants, and the Stop-hook continuation
loop. Each is a switch in the bench configuration, so the bench can say **which**
contribution moved the score, not only that something did.

**What is scored, per task run** (every signal already exists as a durable record):

| Signal | Source | Why it is the harness's to answer |
|---|---|---|
| task outcome (`passed` / `failed` / `abandoned`) | the task's own verifier (a test that must go green, a PR that must exist, a file that must match) | the only signal that is about the work |
| wall-clock, Ephesus-side (SRS §6.1 b) | `log.jsonl` | a harness that is slower than bare has a cost |
| tokens and cost | the cost ledger (invariant §11) — **never** an in-memory count | the harness spends the Architect's money |
| parked prompts | `gate/ungated · tool-permission` rows | the thing that ended every unattended hour |
| un-gated destructive actions | gate rows vs. action rows | must be **0**; a run with one is invalid, whatever else it scored |
| human interventions | `remote`- and window-tagged acts during the run | zero is the point of a harness |
| refusals that taught the rule | `reasons` in `log.jsonl` | a refusal nobody can act on is a cost |
| time-to-first-action, longest silence | first `pre-tool` after spawn; the largest gap between consecutive rows of one agent | §3.1's signals; a harness that leaves an agent silent for twenty minutes has lost it, whatever the end state says |
| redundant reads, recovery rate | `post-tool` rows: the same path read twice with no write between; a failed tool call followed by a successful retry of the same intent | the loop's quality, separable from the model's |

A cell with fewer than three runs is written to the ledger flagged `low-confidence`
and is never averaged with anything.

**What is deliberately not scored in M9:** judged quality (was the severity *right*,
is the summary *faithful*). E-PLAYBOOK and E-STOA already state that their judged
halves are owed and not faked; the bench inherits that stance. A rubric judged by a
model is a later package with its own ADR, because a harness that scores itself with
the model it is scoring is R11's metric-gaming risk by construction.

**The condition travels with the number** (ephesus-engineer §3 rule 8). Every bench
row records machine, OS, engine or provider and version, model, the task set's
content hash, the harness commit, and the ablation switches. Two rows that differ in
any of these are not comparable, and the ledger says so rather than averaging them.

**Why the bench comes before the engine.** If M9.2 landed first, the first
uplift ever measured would be measured against a loop built by the people being
measured, with a scorer written afterwards to fit. Building M9.1 against the
existing `claude` adapter — which M9 does not change — gives a baseline nobody could
have tuned for, and makes every later package a number rather than a claim.

## 5. What changes in the contract, and what does not

### Supersessions and additions (all PROPOSED until approved)

- **ADR-0036 — Two engine kinds: a wrapped CLI and a native agent the harness owns.**
  Supersedes ADR-0009's sentence *"never reimplement an agent runtime"* and nothing
  else in it. The `EngineAdapter` surface, the conformance suite, the hook grades
  and the autonomy grades all stay exactly as they are — the native engine is a
  **fourth adapter that passes the same table**, and that table is what keeps it
  honest. Draft: [`adr/ADR-0036-two-engine-kinds.md`](./adr/ADR-0036-two-engine-kinds.md).
- **ADR-0037 — The harness is measured: the bench, the ablation protocol and the
  bench ledger.** Makes the harness uplift a first-class, append-only record with the
  same total-ledger rule as the Gymnasium (ADR-0015 R2), and makes a bench row the
  evidence a Gymnasium proposal about the harness must cite. Summarised in §6 M9.1;
  written as part of M9.0.
- **ADR-0038 — A model provider is a seam, and a local endpoint is the first
  implementation.** The native engine talks to models through one interface; the
  first implementation is an OpenAI-compatible chat endpoint over the platform
  `fetch`, which is what Ollama, llama.cpp's server, vLLM and LM Studio all expose —
  so "local agents" costs **zero new dependencies**. Anthropic's Messages API over
  `fetch` is the second implementation. Written in M9.0, decided by DD-M9-3.
- **ADR-0039 — The harness is the permission system for a native agent.** For a
  native engine the pre-tool hook is not an observation but a decision: the Watch's
  `evaluateGate` finally has an action to permit, the ADR-0035 `unattended` grants
  become the allowlist that bypasses the gate, and the "parked prompt that nobody
  may answer" ceases to exist for native hires — it is an Ephesus gate with a
  `gateId`, settled in WATCH or by `ephctl`'s refusal, as every other gate is.
  Written in M9.3.
- **SRS**: FR-15 (native engine), FR-16 (the bench), §6.11 (the uplift test); FR-1.2
  gains the native kind without losing the wrapped one.
- **SDD**: §3 gains the native adapter's runtime notes; a new §13 describes the
  engine loop, the provider seam, the tool registry and the transcript format.
- **TEST-STRATEGY**: S-NATIVE (scenario), S-BENCH (the scorer discriminates), the
  conformance table gains a `native` subject; §6 gains the bench as the trend line
  the org panel was always meant to show.
- **Watchlist**: rows for Odysseus and (tags confirmed) Hermes Agent — Architect-only
  registration, DD-M9-6.

### What does not change — the thirteen invariants, by name

Strict TS (the engine is TypeScript, not a `.mjs` shim — DD-M9-5) · renderer never
touches Node · atomic writes · single committer (the native agent writes files in
its own worktree and mails through its outbox exactly as a wrapped one does) ·
append-only (the bench ledger joins the list) · secrets write-only (a provider key is
a broker secret env-injected by the same path `GH_TOKEN` takes) · every degradation
visible (an unreachable endpoint refuses the hire, by name) · prompt text in
`prompts/` (the engine's system prompt and compaction prompt are files) ·
`schemaVersion` on transcripts, bench tasks and bench rows · **no new runtime
dependencies in the whole milestone** — a property, not a hope, because every
network call is platform `fetch` · cost from the ledger · tokens only in UI · watched
content is data.

Also unchanged, and worth saying because C2 could be misread as licence to drop
them: the two data planes (ADR-0002) — the native engine is **still a CLI in a PTY**,
so the terminal never lies and the floor still projects only events; owned spawn
(ADR-0014); the Stop-hook loop (ADR-0013), which the native engine implements
natively rather than through a settings file; and every Watch rule.

## 6. Packages

Format follows `docs/IMPLEMENTATION.md`: what, then *Docs · Tests · Risk*. Each
package is one PR, ends with its suite output in the record, and owes a mutation
round from a checked-in `test/mutation/<package>.json` (GYM-008) plus an adversarial
refutation pass where it is gate-shaped (M9.3 and M9.1 are).

- [ ] **M9.0 The contract** (≈ 3–4 days) — ADR-0036, ADR-0037, ADR-0038 accepted
      or amended by the Architect; SRS FR-15/FR-16/§6.11; SDD §3 note + §13; the
      TEST-STRATEGY rows; the watchlist rows registered and the two `/research`
      cycles run against **pinned** commits so RB-002 (Odysseus) and RB-003 (Hermes
      Agent) exist before any engine code is written and §3 of this plan is replaced
      by citations to them. The Munder Difflin row stays — it is still the record
      of what Ephesus kept and dropped.
      *Docs: everything above. Tests: the ADR append-only CI check, the link check,
      brief validation (an uncited finding is rejected). Risk: ADR-0036 is the first
      supersession of a load-bearing ADR in the project; the record must say exactly
      which sentence it replaces and that the adapter seam is untouched, or every
      later "the native adapter is special" shortcut will cite it.*

- [ ] **M9.1 The bench, v0** (≈ 1 week) — `bench/tasks/<id>.json` (schema'd:
      a fixture repository or a generator for one, the break or goal, the verifier
      command, the time box, the clauses it scores); a runner that drives the company
      through **the control surface and nothing else** (ADR-0033 — the bench is a
      script running the company, so it cannot approve a gate, which is the point);
      a scorer that reads `log.jsonl` and the cost ledger and nothing in memory;
      `docs/bench/LEDGER.md`, append-only, one row per run with its full condition.
      Three tasks ship: **T1** is `docs/EXIT-M8.md` §3–§5 made mechanical — a
      fixture repo with CI-equivalent local checks, one assertion broken on a
      branch, the five §6.1 clauses as score fields; **T2** a dependency bump with a
      failing transitive test; **T3** a documentation drift the crew must detect and
      fix. The deterministic half runs in CI against the fake engine with scripted
      outcomes, and asserts that the **scorer discriminates** — a good run passes
      and each named failure mode fails it (the E-PLAYBOOK stance, which proved its
      worth when a substring match scored "reproduce" as a production action).
      The live half runs **once** in this package, against the existing `claude`
      adapter, and the row it writes is M9's baseline.
      *Docs: ADR-0037, FR-16, TEST-STRATEGY §6. Tests: S-BENCH (scorer
      discrimination, each clause mutated); the runner refused `watch:approve` by
      the control surface; a row with a missing condition field is refused by the
      ledger validator. Risk: the classic check that cannot fail — a bench whose
      tasks the harness's own prompts were written around. T1 is that risk made
      explicit: it IS the exit script. The mitigation is that T2 and T3 were not,
      and that the ablation (M9.6) scores contribution, not absolute.*

- [ ] **M9.2 `eph-agent`: the native engine** (≈ 1.5 weeks) — Ephesus's own agent
      CLI, in TypeScript under `src/engine/`, built to `out/engine/` (DD-M9-5),
      spawned in a PTY like every engine. One loop: system prompt from
      `prompts/engine/`, identity + protocol + memory injected exactly as
      `AgentSpawnConfig` already carries them, a message list, a provider call, tool
      calls dispatched to M9.3's registry, a turn ending → the **Stop decision asked
      of the harness** over the same hook endpoint, with the same reply contract, so
      ADR-0013's loop, block cap and `stop_hook_active` guard apply unchanged. Every
      lifecycle point emits the hook envelope the shim would have — `session-start`,
      `pre-tool`, `post-tool`, `stop`, `notification`, `compacting` — so the adapter
      declares `hooks: 'native'` and the conformance suite's "wires enough events to
      back the grade" case is what proves it. Autonomy is `enforced` by construction
      (the engine has no permission prompt of its own; M9.3 makes the gate the
      prompt). Transcript: JSONL in `engineConfigDir`, `schemaVersion`'d, read by a
      `TranscriptReader` so the ledger folds it; a local model reports tokens and
      **`costUsd: null`, shown as "not reported", never as free** (ADR-0011). The
      adapter `src/main/engines/native.ts` is registered; a hire declares
      `engine: "native"`, `provider`, `model` and `endpoint`; an endpoint that does
      not answer the version/health probe **refuses the hire by name** at spawn,
      which is the M8.4 needs-login rule applied to a URL.
      Provider: the OpenAI-compatible chat-completions seam over `fetch`, streaming,
      with tool calls (ADR-0038). The provider declares what the model can do
      (native tool calls, context length) and the hire is refused when the model
      declares no tool use or a context below the declared floor for agentic work
      (§3.2 names 64k; the figure is a profile field, not a constant) — a company
      that silently runs an agent that cannot call tools is ADR-0024's "one turn
      per wake" failure in new clothes. The loop also carries a stall guard (§3.2:
      N consecutive turns with no text and no tool call end the turn as a visible
      degradation), which complements the breaker rather than replacing it.
      *Docs: ADR-0036, ADR-0038, FR-15, SDD §13. Tests: `native` joins the
      conformance table and passes every row including autonomy both directions and
      settings hygiene (it writes nothing into any cwd); S-NATIVE drives one
      native hire through a scripted provider (a fake OpenAI-compatible server under
      `test/fakes/`) through mail-in → tool → mail-out → Stop → continue → idle;
      the Stop loop's block cap holds; a dead endpoint mid-turn is a visible
      degradation and a `ghost`, never a hang. Risk: this is the largest single
      package since M3 and the one ADR-0009 warned about — "full ownership of the
      hardest problems". The containment is that it owns NOTHING the harness does
      not already own for wrapped engines (hooks, mail, memory, ledger, gates); what
      is new is the loop and the provider call, and both are small.*

- [ ] **M9.3 Tools, and the gate as the permission prompt** (≈ 1 week) — a
      **closed** tool registry in `src/shared/tools/` with zod schemas: `read`,
      `write`, `edit`, `list`, `search`, `shell`, `recall` (wraps `eph-recall`),
      `mail` (writes the outbox). Containment is the `tool-grants.ts` rule applied
      to every path: inside the worktree, the granted tool directories, the mailbox
      and the runbooks, or refused with the root named. `shell` is where ADR-0035's
      `unattended` grants stop being a settings line and become the allowlist: a
      command matching a declared grant runs; anything else becomes a **real
      Ephesus gate** with a `gateId` and a blast radius, which the Architect settles
      in WATCH, `ephctl` refuses to settle (ADR-0033), and the bench counts. The
      `tool-permission` kind `evaluateGate` refuses today stays refused for wrapped
      engines — the refusal was correct for them — and a new kind carries the native
      engine's requests, so the two never share a code path that could blur which
      engine owns the prompt (ADR-0039). Every tool result enters the transcript
      tagged `trusted: false` with its provenance (a path, a command, a URL), which
      is NFR-18 as a record rather than a sentence, and is what a later package can
      arm the gate on (§3.1's mechanism; recorded here as the data, not yet the
      policy).
      *Docs: ADR-0039, FR-11.1, THREAT-MODEL §3/§5 (a new trust boundary: the
      native agent's tool dispatcher). Tests: S-GATE gains the native case — a
      destructive shell call is held, the hold is a row, approval runs it,
      rejection does not, a `prefix` grant runs without a gate and an undeclared
      command does not; path escape attempts (`..`, symlink, junction via `lstat`)
      refused; the API-surface test that no tool reaches outside containment
      without a gate (the S-SECRETS pattern). Risk: gate-shaped, so the adversarial
      pass is budgeted — M8.0's lesson was forty green tests and three bypasses in
      ten minutes. The engine owning tool execution is also THREAT-MODEL §6.7's
      "not hardened against a malicious agent" moving one layer closer; no OS
      sandbox lands in M9 and §6 must say so.*

- [ ] **M9.4 Memory and context for a native agent** (≈ 3–4 days) — the Library's
      composed memory layer reaches the system prompt (already on the config);
      `recall` is a tool rather than a shell invocation; **compaction** is a
      provider call with the prompt in `prompts/engine/compact.md`, emitted as the
      `compacting` hook event the avatar state machine already knows, and recorded
      in the transcript as a boundary so the ledger never double-folds across it;
      the agent appends to its own `memory.md` at Closing Time exactly as a wrapped
      agent does.
      *Docs: ADR-0006, SDD §13. Tests: compaction preserves the identity/protocol
      block byte for byte and drops only turns; the ledger total before and after a
      compaction differs by exactly the compaction call's usage; a provider whose
      context limit is exceeded is a visible degradation naming the model's limit.
      Risk: a compaction that quietly rewrites the agent's instructions is the
      hook-author problem of ADR-0026 in a new place; the byte-for-byte test is
      the containment.*

- [ ] **M9.5 Claude, natively** (≈ 3 days) — the second provider: Anthropic's
      Messages API over `fetch`, key as a broker secret env-injected to roles that
      declare it (ADR-0010; the `openai` SDK stays where it is, in the Herald).
      The point is not a second vendor; it is that the **same loop** now runs the
      reference model, so the bench can put `claude` wrapped and `claude` native on
      one task and the difference is the loop, not the model. Honour ADR-0024's bar
      for a second product engine: the conformance table on autonomy, notification
      and trust — not "it spawns".
      *Docs: ADR-0038. Tests: the provider conformance case (streaming, tool calls,
      usage facts) against a recorded fixture; the key never appears in argv, a
      transcript, or `log.jsonl` (S-SECRETS). Risk: a subscription CLI and an API
      key are different money; the consent screen (ADR-0032) must name which a hire
      spends before the company starts.*

- [ ] **M9.6 The first uplift** (≈ 1 week) — the ablation protocol as bench
      configuration (`switches: { memory, playbooks, mail, gates, stopLoop,
      identity }`); runs of T1–T3 with N ≥ 3 per cell on **one local model** and on
      `claude` native, full harness vs. each switch off; rows in
      `docs/bench/LEDGER.md` with conditions; a README section **"How much does the
      harness add?"** that quotes the ledger and nothing else. The number may be
      small or negative on a given cell, and the exit does not require otherwise —
      the exit requires that it is measured and recorded honestly. The weekly bench
      cadence registers with the scheduler under company-mode governance
      (ADR-0018: autonomous only in `improving`, on demand in `directed`).
      *Docs: ADR-0037, README. Tests: a row whose cells differ in condition cannot
      be averaged (validator); the cadence is mode-gated like the Stoa's. Risk: R11
      — a bench the company can see is a bench the company can game. The ledger is
      total, the tasks' verifiers live outside any agent's worktree, and the
      proposals the bench seeds go through the same Architect gate as any other.*

- [ ] **M9.7 Headless-first** (≈ 3–4 days) — `npm run headless` boots the harness
      with no window: every subsystem that today needs the renderer to *exist*
      (not merely to display) is listed by the reachability walk and made
      optional; the control surface is the complete operator interface for a
      headless run; `DIAGNOSIS.md` says `headless` as a condition. The window
      becomes a client of the same `IpcDeps` the control surface already serves
      (the M8.14 shape), which is what makes this a wiring package and not a
      rewrite. **Nothing is deleted**: the floor, the Herald and the Odeon keep
      working when a window exists.
      *Docs: ADR-0001 (clause note, not supersession — the shell is still
      Electron), README "Setting it up". Tests: the headless boot runs T1 end to
      end with zero renderer code reached (reachability from the headless entry);
      the shutdown sequence (M8.1) completes without a window. Risk: this is where
      C1 ("the environment is not the differentiator") becomes code, and the
      temptation is to delete; the Architect decided the floor's standard in
      ADR-0014 and that decision stands unless superseded.*

- [ ] **M9.8 Exit review** — the bar in §7, run by `/milestone-review`, PROGRESS
      updated in the same session, `docs/status/` snapshot written.

## 7. Exit criteria

M9 closes when **all** of the following hold, each with tier A or B evidence in
the record:

1. **The native engine passes the whole conformance table** — the same rows as
   `claude`, declaring `hooks: 'native'` and `autonomySupport: 'enforced'`, both
   checked in both directions (ADR-0031's method).
2. **A native-engine Skeleton Crew on a local model completes bench T1** — detection,
   triage, a fix branch, a briefing that cites the log — with **zero parked prompts
   and zero un-gated destructive actions**, from the control surface, with no window
   (M9.7), and the row's condition fully recorded.
3. **The harness uplift is measured and recorded** for at least two models, one
   local and `claude` native, under the ablation protocol, N ≥ 3 per cell, in
   `docs/bench/LEDGER.md` — whatever the numbers are.
4. **Zero new runtime dependencies**, or each one with its decision memo and a
   ledger row (invariant §10).
5. **No invariant weakened, no accepted ADR edited** — ADR-0036 supersedes one
   sentence and the CI append-only check stays green.
6. **Docs synced** (`/doc-sync` clean), PROGRESS updated in-session, README's
   landed list current (`check-readme-current.cjs`).

The unattended hour of `docs/EXIT-M8.md` is **not** a separate exit of M9. Criterion
2 is that hour made mechanical and run on a native engine; DD-M9-7 asks whether the
Architect also wants it run once more as written, on `claude`, before M9 begins.

## 8. Order, dependencies and estimate

```
M9.0 contract ──► M9.1 bench v0 (baseline on claude-wrapped)
                      │
                      ▼
                  M9.2 eph-agent + local provider ──► M9.3 tools + gate ──► M9.4 memory/context
                                                                               │
                                                     M9.5 claude native ◄──────┘
                                                                               │
                                                     M9.6 first uplift ◄───────┘
                                                              │
                                                     M9.7 headless-first ──► M9.8 exit
```

About **5–6 weeks** at the project's observed pace (M8's thirteen packages took
eight days of calendar time but were wiring; M9.2 is the first package since M3
that builds a subsystem rather than connecting two). M9.0 and M9.1 are serial and
first for the reason §4 gives. M9.5 can run in parallel with M9.4 once M9.3 lands.
M9.7 is last because the headless boot is proven by running T1, which needs
everything before it.

## 9. What happens to the rest of the plan

- **M7b** moves behind M9 and keeps its content; its order within the milestone
  changes because M9 changes what two of its packages mean. **M7b.2 Recursive
  Improvement** becomes the natural consumer of the bench: a proposal about the
  harness cites a bench row as its evidence and its metric is a bench delta, which
  is FR-12.2's falsifiable metric given a measuring instrument it never had.
  **M7b.5 packaging** stays last for ADR-0024's reason — ship what is measured.
- **The owed exit runs** (M7, M8b, M8c) are answered by criterion 2, honestly: the
  run the project could not get a human to finish is the run the bench performs, on
  a schedule, with its conditions written down. The three exit boxes are the
  Architect's to tick on that record, and this plan does not tick them.
- **The metaphor subsystems** — Terraces, Herald, Odeon decks and meetings — are not
  cut. They become optional clients (M9.7). ADR-0014's standard for the floor
  ("every animation must convey real state faster than a text label would") still
  governs anything that remains; what M9 adds is that the company must also be
  complete **without** them.
- **Munder Difflin** stays on the watchlist as the record of lineage. The two-plane
  design, the file hive and the Stop-hook loop it gave Ephesus are kept because they
  are harness, not metaphor — and the bench will say so, or not.

## 10. Decisions for the Architect

**All seven were decided on 2026-10-02 — each as recommended** — through the
questions workflow, and recorded in `docs/DECISIONS-LOG.md` under that date. The
table is kept as written so the options considered stay on the record.

| ID | Decision | Options | Recommendation and why |
|---|---|---|---|
| DD-M9-1 | Insert M9 before M7b, under this name | (a) yes, "M9 — The harness is the product"; (b) yes, another name; (c) no, M7b first | **(a)**. ADR-0024 and the M8 insertion note both already argue "ship what is measured"; M7b ships. |
| DD-M9-2 | The native engine's shape | (a) Ephesus's own loop as its own CLI in TS; (b) embed a vendor agent SDK as the loop; (c) stay CLI-wrapping only and improve the adapters | **(a)**. (b) keeps the vendor's permission model and loop, which is the constraint C4 names; (c) cannot reach local models at all. (a) keeps every plane and ADR except one sentence. |
| DD-M9-3 | First provider | (a) OpenAI-compatible local endpoint over `fetch`; (b) Anthropic API first; (c) both in M9.2 | **(a)**. Zero dependencies, "local agents" is C4's own phrase, and the bench needs a model whose cost is not the Architect's subscription to run N ≥ 3. (b) follows as M9.5. |
| DD-M9-4 | The metaphor | (a) headless-first core, window as client, nothing deleted; (b) unchanged; (c) cut floor and voice now | **(a)**. C1 and C2 are honoured in code without re-deciding ADR-0014 on silence; (c) is a product decision the Architect may still take later with the bench in hand. |
| DD-M9-5 | Toolchain for `eph-agent` | (a) a third TS build (`tsconfig.engine.json` → `out/engine/`, system `node`, `node:` builtins + `fetch` only); (b) a dependency-free `.mjs` under `shims/` | **(a)**. Invariant §1 says strict TS everywhere, and an agent loop is not a shim; the shims' ABI discipline (no native imports) is kept by construction. A toolchain change is always a must-ask (ephesus-engineer §1). |
| DD-M9-6 | Watchlist | register `src-odysseus` (tags `agent-loop`, `tool-use`, `evaluation`, `local-models`; license **AGPL-3.0 as read, to be verified** — pattern-learning only, code intake refused under FR-13.5 whatever the verification says, because AGPL is incompatible with this repository's MIT) and amend `src-hermes-agent`'s tags with `memory`, `local-models`, `evaluation`; x.ai/bot recorded as positioning in this plan only (a product page, not a studiable source) | **register both** so M9.0's briefs run governed; the Architect alone registers (FR-13.1). |
| DD-M9-7 | The unattended hour as written | (a) run it once more on `claude` before M9.0, by a non-author; (b) let bench T1 subsume it | **(b)**, with the three exit boxes left open until T1's first live row exists. Four attempts have not produced a completed hour; a fifth without new machinery is the same bet. |

## 11. Risks added to the register

| # | Risk | L | I | Mitigation / trigger |
|---|---|---|---|---|
| R17 | The native engine grows engine-specific knowledge into core (NFR-12's failure, the one ADR-0024 warned about from the other side) | M | H | `native.ts` is a fourth adapter behind the same interface; the import-boundary lint keeps provider code under `src/main/engines/` and `src/engine/`; the conformance suite runs with four subjects, not one special case |
| R18 | The bench is gamed — by prompts tuned to its tasks, or by the company once it can read its own score (R11 restated for an instrument) | M | H | ablation scores contribution not absolute; T2/T3 written by someone other than the prompt author; verifiers outside agent worktrees; every bench-seeded proposal is Architect-gated; the ledger is total |
| R19 | Local-model quality makes T1 unreachable at any harness setting, and the milestone reads as "the harness failed" | M | M | the exit asks for a **measured** uplift, not a positive one; the record states the model and its tool-use declaration; `claude` native is the second cell precisely so a model limit and a harness limit can be told apart |
| R20 | Owning tool execution moves THREAT-MODEL §6.7 one layer closer with no OS sandbox | M | H | containment at every path (tool-grants rule), the gate as the shell's permission prompt, worktree isolation (M8.6), and §6.7 amended to say what is and is not bounded — a sandbox is a later ADR |
| R21 | A provider key is a new kind of money the consent screen does not name | L | M | ADR-0032's consent names provider spend per hire before start; the key is broker-held and never read back |

## 12. The edits this plan became (applied 2026-10-02; items 3's ADR-0037/0038/0039 are owed by M9.0 and M9.3)

1. `docs/IMPLEMENTATION.md`: a `## M9` section between M8c and M7b (text from §6–§8),
   the dependency diagram, R17–R21 in the register.
2. `docs/PROGRESS.md`: a `## M9` section with the eight unticked boxes above and a
   "plan drafted 2026-10-02" note; nothing else ticked or changed.
3. `docs/adr/`: ADR-0036 → `accepted` (or amended); ADR-0037/0038 written in M9.0;
   ADR-0039 in M9.3; the index updated; ADR-0009's row gains "(one sentence
   superseded by ADR-0036)".
4. `docs/srs/SRS.md`: FR-15, FR-16, §6.11; FR-1.2 amended additively.
5. `docs/sdd/SDD.md`: §1.1 rows for `engines/native.ts` and `src/engine/`; §3 note;
   §13.
6. `docs/TEST-STRATEGY.md`: S-NATIVE, S-BENCH, the conformance subject, §6 trend.
7. `docs/stoa/WATCHLIST.md`: the rows of DD-M9-6, by the Architect.
8. `docs/DECISIONS-LOG.md`: one entry per DD-M9 answer, dated.
9. This file: status line changed on 2026-10-02; §3 is replaced by citations to
   RB-002/RB-003 once M9.0 produces them.

**Rollback** (ADR-0015 asks for one): M9 adds an adapter, a build target, a `bench/`
directory and documents. Un-registering the `native` adapter restores the ADR-0024
MVP exactly; the bench ledger stays, because a ledger is never deleted.
