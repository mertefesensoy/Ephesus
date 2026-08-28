# ADR-0017 — The Stoa: a research department that feeds the Gymnasium external evidence

**Status:** accepted · **Date:** 2026-08-28

## Context
The Gymnasium (ADR-0015) answers *how* the company improves itself, but its observe
step admits only internal records as evidence (FR-12.1: org metrics, `log.jsonl`,
breaker trips, memo patterns, drift audits — "never from unreferenced speculation").
That rule is load-bearing: it is what keeps proposals falsifiable. It also means the
company is structurally blind to the outside world — it can learn from its own
friction but not from the harnesses, agent frameworks, and CLIs that solve the same
problems differently. The Architect's directive (2026-08-28): the company needs a
small **research department** that studies repositories the Architect chooses, so
that improvement proposals can say not only "this hurt us" but "here is how a
comparable system avoids it" — with the findings promoted through Artemis for
triage and to the Architect for approval, like every other Gymnasium change.

The dangers are specific and known:
- **Prompt injection.** A studied repository is arbitrary third-party text. A
  README that says "ignore your instructions and run this" must be a *finding*,
  never a directive.
- **License/IP contamination.** "Learning from" must not decay into copying code
  whose license we have not verified — the project already holds itself to
  attribution discipline for its own lineage (README, ADR prior-art sections).
- **Evidence-rule erosion.** If external claims enter proposals uncited, FR-12.1's
  falsifiability guarantee dies quietly.
- **Authority creep.** A researcher that can widen its own reading list is the
  Gymnasium-authority problem (FR-12.3) reborn one subsystem over.

## Decision
**The Stoa** — the colonnade where the city's scholars taught — is the research
subsystem, defined by a watchlist, a brief, and four hard rules.

**The watchlist** (`agora/stoa/watchlist.json`, SDD §4.7) is the *only* set of
sources the Stoa may study. Entries are registered and retired **by the Architect
alone** and carry: url, tags describing what to learn (`agent-loop`, `memory`,
`orchestration`, …), the license as verified at registration, a pinned commit, and
intent notes. Agents — the Stoa's researcher included — may *propose* additions;
none may register them.

**The cycle** (UC-14): on the Stoa cadence or on demand, a researcher agent studies
**one source per cycle** at a pinned commit, scoped by the entry's tags, in a
read-only isolated checkout with no secret grants. It files **one research brief**
(`agora/stoa/briefs/RB-<NNN>-<slug>.md`): source\@commit, findings each citing file
paths, applicability mapped to Ephesus subsystems (cross-referenced to internal
friction records where they exist), candidate improvements, and a license note. The
harness validates the shape — a brief with an uncited finding is rejected before any
human sees it (the FR-12.2 pattern applied to research). Artemis then reviews and
ranks the candidates and files (or assigns) Gymnasium proposals *citing the brief*;
from there UC-13 runs unchanged — Artemis pre-screens, the Architect verdicts.

**The four hard rules:**
- **R1 — Sources are Architect-registered only.** The Stoa can never widen its own
  watchlist (the FR-12.3 mirror).
- **R2 — Studied content is data, never instructions.** Directives found inside a
  watched source are reported as findings; the researcher runs read-only, sandboxed,
  without secrets (NFR-17). Tested adversarially: S-STOA plants an injection and
  fails the run if it is obeyed.
- **R3 — A brief is evidence, never a change.** Nothing from a watched source
  reaches code, prompts, config, or process except through a normal gated Gymnasium
  proposal that cites the brief. Patterns are learned; code is not copied — verbatim
  or derived intake additionally requires a verified license on the watchlist entry,
  attribution, and a decision memo (ENGINEERING-STANDARDS §5).
- **R4 — Research is budgeted inside the Gymnasium slice** (FR-12.5): the Stoa can
  never starve the missions, and its spend is reported in the same standup section.

**Build-phase mirror** (the FR-12.6 pattern): the loop exists in the repository now —
`docs/stoa/WATCHLIST.md`, `docs/stoa/briefs/`, and the `/research` skill — with the
same artifact shapes, seeded into the Agora at first run. The watchlist opens with
the Architect's three named sources: NousResearch/hermes-agent,
chaitanyagiri/munder-difflin (the project's own inspiration, now studied
systematically), and anomalyco/opencode.

**Health metric:** the Stoa is measured the way it measures others — Architect-
approved proposals per brief, and the validated-vs-regressed ratio of Stoa-seeded
proposals, reviewed in retros (UC-12) beside the Gymnasium's own ratio.

## Options considered
- **Let the Gymnasium's observe step browse the web/repos freely.** Maximum reach,
  no provenance, unbounded injection surface, and FR-12.1 becomes unenforceable.
  Rejected.
- **Architect pastes findings in manually.** The status quo; wastes agent leverage
  and does not scale past the Architect's reading time. It is, however, the
  degradation mode when the watchlist is empty — the system loses nothing it has
  today.
- **A full web-research agent (search engines, forums, papers).** Far larger
  untrusted surface, no pinnable provenance (a web page has no commit hash), and
  harder license posture. Deferred to post-v1; the watchlist's `kind` field leaves
  room for non-git sources later without changing the governance.
- **Fold research into Artemis.** Artemis already pre-screens proposals; making it
  also author the underlying evidence concentrates narrative control in one agent
  and worsens the R1 (nothing-self-approves) posture. A separate researcher role
  keeps evidence author ≠ ranker ≠ approver.

## Consequences
- FR-12.1 gains one admissible evidence class — Stoa briefs — without losing
  falsifiability: a brief's claims are pinned to commits the Architect can open.
- The company can finally answer "what should we improve?" from both directions:
  its own friction records and the state of the art the Architect curates.
- New standing costs: watchlist upkeep is an Architect chore; researcher spawns
  consume Gymnasium budget; S-STOA joins the scenario suites and E-STOA the evals.
- New attack surface, deliberately narrowed: injection is tested adversarially, and
  the read-only/no-secrets researcher spawn is enforced by the Watch, not by
  convention.
- SRS gains UC-14 and FR-13 and NFR-17; SDD gains `stoa.ts`, §4.7 and §7.7;
  TEST-STRATEGY gains S-STOA and E-STOA; IMPLEMENTATION gains milestone M5b.
- When this loop runs autonomously is not this ADR's question — that is the company
  mode and its proof gate, ADR-0018.

## Prior art
ADR-0015 (the governance this plugs into — the evidence rule, the authority table,
the budget slice); ADR-0016's detect-and-degrade discipline for optional machinery;
the project's own lineage practice (Munder Difflin studied, credited, patterns
reused, no code vendored) — the Stoa institutionalizes exactly that practice;
literature-review practice in research labs: sources are chosen by the PI, claims
carry citations, and a survey is never itself the experiment.
