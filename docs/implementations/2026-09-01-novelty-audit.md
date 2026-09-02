# Novelty audit — Ephesus

**Date:** 2026-09-01 · **Auditor:** Claude Code session on `claude/novelty-audit-19b55b`
**Code state audited:** `main` @ `bd91ca9`, plus `fix/workspace-trust-and-remembered-targets`
(+54 commits, the true head of work: all of M7 and the live acceptance run).
**Status:** advisory. No code and no accepted ADR was changed by this audit.

---

## 1. What a novelty audit asks

Ephesus makes explicit originality claims — the README has a numbered "what makes it
different" list, the SRS flags three requirements as *differentiator*, and every ADR is
supposed to carry a **Prior art** section. This audit tests those claims against three
questions, in order. A claim must survive all three to count.

| # | Question | Failure mode it catches |
|---|---|---|
| **Q1** | Is it **original** — does the same mechanism already exist elsewhere? | Reinvention. Effort spent on a solved problem. |
| **Q2** | Is it **built** — does the novel mechanism have a production caller? | A differentiator that is dead code. |
| **Q3** | Is it **enforced as stated** — does the check test what the sentence claims? | A guarantee whose enforcement point is weaker than its wording. |

Q3 is the one this project has already learned to fear. Its own source comments record
two prior instances — `withGate`: *"SDD §4.2's `gates` field has existed since M2 and
nothing ever wrote it, so 'the harness refuses → done while a gate is open' protected
nothing"*; `withDeck`: what *"turns FR-7.2's 'mechanically unclosable until a deck
exists' from a rule about an empty field"* into a real one. M6.10 ran the same pass
against the floor's claims and found 18 of 22 survived mutation. **This audit runs that
pass against the novelty claims themselves.**

---

## 2. Verdict

> **The governance layer is the novel thing. The coordination layer is no longer
> novel, and three of the mechanisms that carry the novelty claim check the *shape*
> of an artifact rather than its *content*.**

Ephesus's real, defensible contribution is narrow and worth keeping: **accountability
artifacts as enforced state-machine preconditions** — a work item that cannot reach
`done` until a review deck exists, a briefing refused whole because one sentence cites
a fact nobody issued, six filing types refused by the harness before a human ever sees
them. That is a genuine delta against every framework surveyed below, all of which gate
*tool calls* and none of which gate *work-item transitions on the existence of an
accountability artifact*.

Almost everything else in the README's differentiator list has either been commoditized
by the engine Ephesus wraps (N-1), has never been checked against prior art at all
(N-2), or is enforced by a schema check standing in for a semantic one (N-4, N-5).

---

## 3. Findings

### N-1 — The coordination substrate has been commoditized by the engine Ephesus wraps · *critical, external*

Ephesus's live acceptance run spawns `claude 2.1.195`. That same CLI now ships, first
party:

| Ephesus subsystem | First-party Claude Code equivalent |
|---|---|
| Artemis — lead agent that decomposes, assigns, supervises | **Agent teams** — "multiple coordinated sessions with a shared task list and inter-agent messaging, managed by a lead" (experimental, off by default) |
| Hermes — inter-agent mailboxes and delivery | **Cross-session messaging** — sessions list and message other sessions on this machine, another machine, or the web |
| The Agora task ledger — the shared work list | Agent teams' shared task list |
| The Terraces / activity log — watch what every agent is doing | **Agent view** (`claude agents`) — one screen per session with state, auto-worktree isolation (research preview) |
| Profile triggers / the scheduler | **Routines** — a session on a schedule |
| The Electron shell's multi-agent surface | Desktop app **parallel sessions** with automatic worktrees |

**Evidence:** [code.claude.com/docs/en/agents](https://code.claude.com/docs/en/agents),
read 2026-09-01. **Not one of these is mentioned anywhere in the design corpus** — `grep`
over `docs/adr/`, `docs/srs/`, `docs/sdd/` and `README.md` returns zero hits for agent
teams, agent view, or cross-session messaging; the single `subagent` hit is a citation of
Anthropic's *research*-system writeup in ADR-0005.

This is not a reason to stop. Two things follow, and they point the same way:

1. **Re-scope, don't re-argue.** ADR-0003 (mailboxes), ADR-0004 (shared coordination
   space), ADR-0005 (lead agent) and ADR-0014 (the floor as observability) now solve
   problems the substrate solves. Their *governance* consequences — single committer,
   append-only log, speech acts as an auditable record — are untouched by any of it. The
   maturity gap is real and in Ephesus's favour today (agent teams is experimental and
   off by default; agent view is a research preview), but it is a shrinking moat, not a
   foundation.
2. **The README's differentiator list is stale.** Items 1 (the architect relationship),
   4 (a real org) and 5 (governed self-improvement) survive. The implicit premise of the
   whole document — *that wrapping CLIs into a coordinated company is itself the novel
   act* — does not.

### N-2 — The three claims flagged as differentiators are the three ADRs with no prior art · *high, structural*

The SRS marks exactly three requirements `— *differentiator*`:

| SRS | Subsystem | Governing ADR | Prior art section |
|---|---|---|---|
| FR-7 | The Odeon (accountability) | ADR-0008 | **absent** |
| FR-8 | The Herald (voice) | ADR-0007 | **absent** |
| FR-9 | Mission profiles | ADR-0012 | **absent** |

Three ADRs out of 22 lack the section the ADR README declares mandatory (*"Format:
Status / Context / Decision / Options considered / Consequences / Prior art"*), and they
are precisely the three the SRS stakes originality on. The claims that most need a
prior-art check are the only ones that never got one.

The wider distribution tells the same story:

- **5 of 22** cite an external system in the same problem domain (ADR-0003 Hearsay-II /
  FIPA-ACL, 0004 stigmergy, 0005 LangGraph, 0006 MemGPT/Letta, 0011 Nygard).
- **4 of 22** cite Munder Difflin and nothing else (0001, 0002, 0009, 0013).
- **3 of 22** cite nothing (0007, 0008, 0012).
- **The remaining 10** cite the project's own ADRs plus an analogy imported from another
  discipline — aviation certification (0018), kaizen and Goodhart (0015), literature
  review (0017), dependabot practice (0020). ADR-0021's prior art is four internal
  references and no external one at all.
- **0 of 22** cite any contemporary agent harness other than the single inspiration.

Citing your own ADRs is lineage, not prior art. A section that never names a system built
by someone else cannot answer the question it exists to answer.

### N-3 — The department built to prevent N-1 and N-2 has run once, on the source the project already knew · *high, empirical*

ADR-0017 states the problem in its own words: without a research function the company is
*"structurally blind to the outside world — it can learn from its own friction but not
from the harnesses, agent frameworks, and CLIs that solve the same problems
differently."* The Stoa was built to close exactly the gap this audit found.

Its watchlist (`docs/stoa/WATCHLIST.md`) holds **three rows**:

| Source | License | Pin | Studied |
|---|---|---|---|
| `src-munder-difflin` | MIT | `b91a49f` | **yes** — RB-001 |
| `src-hermes-agent` | unverified | *(set at first study)* | no |
| `src-opencode` | unverified | *(set at first study)* | no |

One brief exists, and its subject is the project's own inspiration. The mechanism is
sound, wired and gated; it has simply never been pointed at anything the project did not
already know. N-1 and N-2 are its direct, predicted consequence.

**This is the cheapest finding to fix, and it uses machinery that is already built.**

### N-4 — Provenance enforcement is a shape check · *high, enforcement*

The claim, stated everywhere from the README to `stoa-brief.ts`'s own header comment:
*"every finding cites file paths inside the pinned commit"*, and briefs *"whose every
finding must cite a path at the pinned commit or die before a human sees it."*

What the harness actually enforces:

```ts
citations: z.array(z.string().min(1).max(300)).min(1).max(32)   // stoa-brief.ts:35
```

plus `checkBriefAgainstSource`, which verifies (a) the brief names the registered source,
(b) the brief's *declared* commit prefix-matches the pin, and (c) the brief's internal
cross-references — `applicability[i].finding`, `candidates[i].fromFindings` — point at
findings that exist **inside the brief**.

**No citation is ever resolved against the checkout.** A finding citing
`src/entirely/imaginary.ts` is accepted, archived, rendered into the markdown as
`Cites: src/entirely/imaginary.ts`, and is eligible to seed a Gymnasium proposal and
count toward the proof gate. The verified property is *"the researcher wrote a non-empty
string and typed the right commit at the top of the file"* — which is the failure mode
the 2026 literature names outright
([*Cited but Not Verified*, arXiv:2605.06635](https://arxiv.org/html/2605.06635v1)).

The gap is worth flagging loudly because **the project already implements the strong
version elsewhere**. `checkNarrative` in `src/shared/brief.ts` does closed-world
resolution — it builds `new Set(facts.flatMap(e => e.refs))` and refuses the whole
briefing if any sentence *"cites X, which no fact supports"*, with the comment *"an
invented citation is worse than none, because it looks checked."* That sentence is the
finding. The Odeon resolves its refs; the Stoa does not.

The M5b close-out audit caught the neighbouring instance of this — a demo citing a commit
that existed in no repository — and fixed the *commit*. The *paths* were never brought
under the same rule.

### N-5 — The proof gate counts assertions, not outcomes · *high, enforcement*

ADR-0018's analogy is aviation's staged certification: *"a system earns operating
authority by demonstrated outcomes under supervision."* `checkProofGate` requires 3
proposals through the full loop, 2 of them `validated`, 1 Stoa-seeded. The counting is
careful, the refusal messages are excellent, and the absorbing-violation rule is a
genuinely good piece of design.

What `validated` means:

```ts
export function measuredOutcome(measured: string | null): GymStatus {
  return measured === null ? 'regressed' : 'validated'
}
```

Any non-null string is a pass. There is no comparison against the declared target — and
the target is free text: `metric: { what: string(1..500), target: string(1..200),
windowDays: int }`. So ADR-0015's *"proposals without a falsifiable metric never reach a
human"* is enforced as *"proposals without a metric-**shaped object** never reach a
human,"* and the gate that opens standing autonomy counts rows whose Measured cell is
non-empty.

**In fairness:** the string arrives from the Architect through the `gym:metric-result`
IPC channel, so the ledger records a *human judgment*, not a machine claim — which is
defensible, and arguably the right design for a governance ledger. The finding is not
that the gate is fake; it is that **the ADR's analogy overstates what the code does.**
Certification-by-demonstrated-outcome and attestation-by-the-person-who-wants-the-gate-open
are different things, and only one of them is what runs. The source comment is honest
about it (*"the comparison is deliberately not clever"*); the ADR is not.

### N-6 — The floor is now a genre · *medium, external*

ADR-0014 poses the standing question — *"is the 2D floor a gimmick?"* — and answers it
with Stanford Generative Agents and the principle "information through motion." As of
2026 there is a visible cluster of pixel-office agent visualisers doing exactly
"watchability as observability": `rafapetter/agent-town`, `gukosowa/agents-in-the-office`,
`harishkotra/agent-office`, OpenClaw Office, and commercial equivalents — several
describing the same walk-to-desk / idle / failure-state mapping Ephesus implements.

M6 was substantially a floor milestone (citizens, stations, vfx, licensed LimeZu packs,
attribution rules). The mechanism is fine and the execution is careful; the *claim* that
it distinguishes Ephesus no longer holds, and ADR-0014's question deserves re-asking with
this evidence in front of it.

### N-7 — A declared differentiator has no production caller · *medium, built*

FR-8 (the Herald) is one of the SRS's three differentiators and item 3 of the README's
list. `src/main/herald/` is **1,513 lines** across seam, policy, session, narration,
phrasebook and two adapters. Every importer is a test:

```
test/conformance/voice-adapters.test.ts   test/main/herald-elevenlabs.test.ts
test/conformance/voice-conformance.ts     test/main/herald-narration.test.ts
test/fakes/fake-voice.ts                  test/main/herald-policy.test.ts
test/scenarios/s-failover.test.ts
```

No IPC channel, no preload surface, no construction in `index.ts`, no UI. M6.9 is
**deferred indefinitely** by Architect decision (2026-08-30) — a legitimate call,
recorded rather than absorbed, and the PROGRESS entry is a model of how to defer
something honestly. The novelty problem is downstream of the decision: the README still
sells a *"voice-first chief of staff"* as a top-line differentiator with nothing behind
it.

### N-8 — The surviving differentiator is the one the live run could not exercise · *medium, empirical*

The SRS §6.1 acceptance run against a real repository
(`docs/demo/m7-onehour-live-musahit.txt`, 2026-09-01, real GitHub Actions failure
33440874791, real `claude 2.1.195` agents) records its own result:

> RESULT: the DETECTION half passed end to end. The ACTION half did not.
> … Artemis replied "Task opened" to agent.harbor
> NO TASK WAS EVER CREATED. tasks.json holds 0. There are no task events.

Detection, deduplication, gating and escalation all worked. But accountability is a
property of *work*, and no work item was created — so the mechanism this audit identifies
as the genuine contribution has still not been demonstrated on a real task end to end.
The E-PLAYBOOK scorecard is explicit that its drill record is a fixture, not a live agent
run, and records the judged half as owed.

That the project wrote this down itself, in these words, is the strongest signal in the
repository — and the reason the findings above are worth acting on rather than arguing
with.

---

## 4. What is actually novel — keep and lead with these

| Mechanism | Where | Why it survives Q1–Q3 |
|---|---|---|
| **Artifact-gated state transitions.** A task flagged `review:deck` cannot reach `done` until a deck is archived against it; an open gate blocks closure. | `canCloseTask`, `withDeck`, `withGate` in `src/shared/ledger.ts`; `src/main/ledger.ts` | Surveyed HITL frameworks (Microsoft Agent Framework tool approval, LangGraph interrupts, tiered approval gates) all gate **tool calls**. None gates a **work-item transition on the existence of an accountability artifact**. Built, wired, and the check is exactly the claim. |
| **Closed-world briefing faithfulness.** A spoken brief is refused *whole* if any sentence cites a ref no compiled fact issued. | `checkNarrative`, `src/shared/brief.ts` | Stronger than "cite your sources" prompting and stronger than the Stoa's own check: it resolves against a set the harness itself produced. This is the pattern N-4 should copy. |
| **Refuse-before-a-human-sees-it, as a uniform stance.** One endpoint takes six filing types — deck, memo, verdict, standup brief, gym proposal, research brief — each parsed, validated and refused with *every* reason at once. | `src/main/odeon-endpoint.ts` | The consistency is the novelty. Most harnesses validate one artifact type as a special case; here it is an architectural position. |
| **An append-only improvement ledger that keeps its failures.** Rejected and regressed rows are never deleted — *"the training data."* | `src/shared/gym.ts`, `docs/gymnasium/LEDGER.md` | Self-improving-agent work (DGM, SICA, HGM) optimises against benchmarks and archives *successful* variants. A governance ledger that preserves rejections and rollbacks for a human reader is a different and unclaimed artifact. |
| **The institutional honesty habit.** Commits titled *"record what the live run proved, and what it disproved"*, *"record that M7 has not closed, and why that is a decision"*, *"the chain completed, the claims did not verify."* | `docs/PROGRESS.md`, `docs/DECISIONS-LOG.md` | Not a feature, but it is the reason this audit could be written from the repository's own records. Protect it. |

---

## 5. Recommendations, cheapest first

1. **Register the engine as a watchlist source and study it.** Add first-party Claude
   Code — agent teams, agent view, cross-session messaging, routines, worktrees — as a
   Stoa row and run `/research` against it. This is one watchlist edit and one cycle, it
   uses machinery already built and proven, and it addresses N-1, N-2 and N-3 at once.
   *Highest-leverage item in this document.*
2. **Resolve citations against the checkout at intake (N-4).** The Stoa already owns a
   pinned checkout. Adding a path-existence check to `checkBriefAgainstSource` converts
   the project's loudest provenance claim from a shape check to a real one, and brings
   the Stoa up to the standard `checkNarrative` already sets. Small, surgical, high
   symbolic value.
3. **Either compare the metric or rename the status (N-5).** Either give
   `measuredOutcome` a target comparison, or rename `validated` to something that says
   what it means — the Architect attested this hit its target — and soften ADR-0018's
   certification analogy in a superseding ADR. Do not leave a gate to standing autonomy
   resting on a word that overstates its own check.
4. **Supersede ADR-0007, 0008 and 0012 with prior-art sections (N-2).** ADRs are
   append-only, so this is three short superseding records. The Odeon in particular
   deserves its section: the enforced-artifact argument is the project's best original
   claim and it currently has no written defence against prior art.
5. **Rewrite the README's differentiator list (N-1, N-6, N-7).** Lead with enforced
   accountability. Drop or heavily qualify "wraps CLIs into a coordinated company" and
   "the floor". Decide what to do with the voice claim — the Herald is deferred
   indefinitely, and a top-line differentiator with no caller is a liability in the one
   document strangers read first.
6. **Close SRS §6.1's action half before adding surface (N-8).** The accountability
   mechanism is the thing worth being known for and it has not yet run on a real task.
   Everything in M7b is worth less until it does.

---

## 6. Method and limits

- **Read:** all 22 ADRs, SRS §4 and §6, README, PROGRESS (85 packages), the M5/M5b/M6
  close-out audits, `docs/stoa/WATCHLIST.md`, and the M7 live-run evidence files.
- **Inspected:** `stoa-brief.ts`, `brief.ts`, `gym.ts`, `mode.ts`, `ledger.ts`,
  `gymnasium.ts`, `odeon.ts`, `odeon-endpoint.ts`, `src/main/herald/*`, plus import
  graphs for reachability.
- **External prior art was searched, not recalled:** first-party Claude Code
  orchestration docs; HITL approval-gate frameworks; citation-attribution literature;
  agentic autonomy-level governance (arXiv:2607.23438); self-improving coding agents
  (DGM arXiv:2505.22954, SICA, HGM); pixel-office agent visualisers.
- **Not covered:** whether the mechanisms are *good*, performance, security, UI quality,
  or M7b's unbuilt packages. This audit answers "is it new, and is the claim true" — not
  "is it well made". The close-out audits already do the latter, and do it well.
- **Bias to declare:** this audit reads the project's records for claims and its code for
  enforcement. Where the two disagree the code wins, which systematically favours findings
  against documentation. Every N-item above cites the file that settled it.

## Related

- [`docs/adr/README.md`](../adr/README.md) — the Prior art rule this audit tests
- [`docs/srs/SRS.md`](../srs/SRS.md) §4 — the `*differentiator*` flags
- [`docs/adr/ADR-0017-stoa-research-department.md`](../adr/ADR-0017-stoa-research-department.md) — the blindness this audit measures
- [`docs/gymnasium/LEDGER.md`](../gymnasium/LEDGER.md) — where recommendations 1–4 should become proposals
