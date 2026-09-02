# Ephesus — Test Strategy

**Status:** binding for CI gates. Maps to SRS acceptance criteria (§6) and NFRs.

---

## 1. What makes this system hard to test — and the stance

Ephesus is a harness around *nondeterministic* processes (LLM CLIs) doing *real* side
effects (git, files, network) coordinated through *timing-sensitive* mechanisms
(fs-watch, sockets, hooks). The stance:

1. **Determinize the boundary, not the world.** Every nondeterministic dependency
   (engine CLI, voice provider, GitHub, clock) sits behind a seam that tests replace
   with a scripted fake. The mechanisms *between* seams — Hermes, the Agora, the
   Odeon gates, the breaker — are deterministic and get exhaustive coverage.
2. **The fake agent is a first-class test asset.** `test/fakes/fake-engine` is a real
   CLI binary that speaks the adapter contract: spawns in a PTY, emits scripted hook
   events, reads its inbox, writes outbox messages, exits on cue. Most integration
   tests are scripts for fake agents.
3. **Real-engine tests exist but don't gate merges.** A small live suite (needs a
   Claude Code login) runs nightly and before release, not per-PR.

## 2. The pyramid

| Level | Runner | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | Pure logic: schema validators, message rules (hop caps, obligation table), memo-policy matcher, briefing fact compiler, cost folding, breaker signal math, token/contrast checks | per-PR |
| Integration (main-process) | Vitest + real fs/git in temp dirs | Hermes end-to-end with fake agents; Agora committer under concurrency; Stop-hook decisioning; gate/memo flows; profile activation; ledger transitions | per-PR |
| Contract/conformance | Vitest | Engine adapters & voice adapters against recorded fixtures (§5) | per-PR |
| E2E (app) | Playwright + Electron | Boot app, spawn fake agents, drive real UI: floor states, approvals, Odeon panels, kanban, settings | per-PR (smoke) + nightly (full) |
| Live | Playwright/scripted | Real Claude Code, real voice keys (opt-in), real GitHub sandbox repo | nightly + release |
| Evals | custom runner | Agent-behavior quality (§6) | weekly + release |

Coverage is measured (`npm run test:coverage`, v8 provider) and gated as a
**per-subsystem ratchet**, never as an overall number: `scripts/coverage-floors.json`
records each subsystem's measured floor beside the condition it was measured in;
`scripts/check-coverage.cjs` fails CI when a subsystem falls below its floor or a
production file lands that no test reaches; floors rise by re-measurement and fall
only by a reviewed edit with a reason. The ≥ 90 % branch target for the mechanisms
(hermes/agora/odeon/watch) stays a target, and the floors file shows each one's
distance from it. Overall line coverage is still *not* a gate (it incentivizes junk
tests); mutation testing on the message-rule and gate-policy modules quarterly.
*(Amended at M8.0, GYM-006; the rule it enforces is ENGINEERING-STANDARDS §6.7.)*

## 3. Scenario suites (the tests that matter)

Named suites mirroring SRS acceptance criteria — each is an integration/E2E script:

- **S-BLACKOUT** (SRS 6.6): kill main mid-delivery / mid-commit at injected fault
  points; restart; assert zero loss, zero double-processing, committer reconcile.
- **S-LIVELOCK**: two fake agents scripted to ping-pong; assert hop-cap diversion to
  Artemis at exactly the cap, log records, no delivery loop.
- **S-BOUNCE**: mail to archived/missing agent; assert `refuse` bounce + log, sender
  notified, nothing dropped.
- **S-WAKE**: mail lands while agent idle; assert watchdog nudge exactly once, no
  stale nudges, cursor idempotency on replay.
- **S-STOPLOOP**: fake engine's Stop hook cycles with pending mail; assert
  `stop_hook_active` respected, hard block-cap honored, breaker rung 1 on pathology.
- **S-DECKGATE** (SRS 6.3): `review:deck` task refuses `done` until deck exists;
  deck renders in-app; comment → follow-up task.
- **S-MEMO** (SRS 6.4): policy trigger (fake dependency add) holds the action;
  memo → Artemis delegated verdict (countersigned) vs Architect queue; rejection
  reverses; archive immutable.
- **S-GATE**: destructive op deny-by-default; remote approval path tags `remote`;
  voice approval requires repeat-back (policy layer test with scripted STT).
- **S-BRIEF** (SRS 6.2): seeded ledger/log/budget fixtures → compiled brief; assert
  every narrative sentence carries source refs and refs resolve; ≤ 90 s at configured
  wpm.
- **S-MEETING**: convene 3 fake agents; assert turn order enforcement, interjection
  floor-grab, minutes + action items in board/ledger.
- **S-FAILOVER** (SRS 6.5): scripted ElevenLabs adapter failure mid-utterance →
  OpenAI Realtime continues ≤ 3 s; both down → text-only banner, briefs still
  generated.
- **S-BREAKER**: scripted repetition/error-storm/burn-rate fixtures walk the ladder
  steer→constrain→stop; assert work preserved, ledger `stalled`, brief mentions trip.
- **S-LEDGER**: cost folding across restart — the upstream regression class: assert
  cumulative figure survives restart and session figure resets, sourced from
  transcript fixtures.
- **S-SECRETS**: broker write-only (no read IPC exists — asserted by API surface
  test); env grants least-privilege per hire; redaction filter masks a planted token
  in PTY stream.
- **S-PROFILE**: activate Skeleton Crew on a fixture repo; fake CI webhook →
  triage task auto-created → playbook path; assert stricter-wins autonomy
  composition.
- **S-CRASH**: SIGKILL a fake agent mid-task; ghost → archive, task back to `todo`,
  respawn offer; resume path where adapter supports it.
- **S-GYM** (SRS 6.7, FR-12): proposal missing a metric or rollback is rejected before
  reaching a human; a non-architect verdict on `gym.verdict` is refused; a proposal
  altering gym gating / an accepted ADR / Watch maxima is mechanically refused
  regardless of approver; a landed fixture proposal whose metric misses its window is
  rolled back and ledgered `regressed`; ledger rows are append-only.
- **S-STOA** (SRS 6.8, FR-13): fixture watched repo with a planted applicable pattern
  *and* a planted instruction addressed to the reader — the brief must cite the
  pattern (`repo@commit` + path) and report the instruction as a finding, never obey
  it; a brief with an uncited finding is rejected before reaching a human; watchlist
  registration through a non-architect path is refused; a `license: "unverified"`
  source allows study but refuses pattern intake; the researcher spawn plan carries
  no secret grants and a read-only checkout.
- **S-CLOSING** (GYM-003): closing time over real rails — requests land in every
  live inbox; real fake-engine processes append `memory.md` and acknowledge
  through their outboxes; all-ack resolves the protocol with the exchange in
  `log.jsonl` (`kind: shutdown`); a silent agent is named at the hard deadline;
  an ack with no closing in flight bounces ("no closing time is in progress");
  reentry while in flight is refused.
- **S-MODE** (SRS 6.9, FR-14): enabling `improving` with proof evidence missing is
  refused with the missing items listed; a fixture ledger meeting the §6.9 gate
  enables; records produced under autonomy carry the mode tag; a rung-3 breaker stop
  on gym/stoa work auto-reverts to `directed` and lands on the ledger; no agent-side
  path (Hermes message, hook, proposal) can change the mode.
- **S-RECURSE** (SRS 6.10, FR-9.5/FR-10.5): the Recursive Improvement profile over a
  fixture clone of the company's own repo and a scripted `gh` seam — activation in
  `directed` refused naming the missing §6.9 evidence; an approved fixture proposal
  yields an `agent/` branch and a PR under the company identity whose body cites its
  GYM and RB ids; commits carry company authorship + the agent co-author trailer and
  no Architect or vendor identity; no code path can merge or push `main` (asserted by
  API surface, the S-SECRETS pattern); the researcher role's spawn plan carries no
  GitHub grant while the improver's does; revoking the broker token fails delivery
  visibly and nothing else.

## 4. E2E specifics (Electron + Playwright)

- App boots against a temp harness home; fake engines injected via adapter registry
  env override.
- Floor assertions read the scene's *state model*, not pixels (avatar id → state,
  position, station); one visual-regression snapshot suite covers panel chrome and
  each avatar state sprite at 3 zoom levels.
- Reduced-motion mode has an information-parity suite: every scenario asserted in
  normal mode re-runs with animations off and must expose identical state via labels
  (NFR-15).
- Keyboard map: every documented shortcut has a test.

## 5. Conformance suites (the extensibility guarantee, NFR-12)

- **Engine adapters:** a table-driven suite every adapter must pass: spawn/interrupt/
  kill lifecycle, identity injection observable in-session, hook grade honesty
  (declared grade matches demonstrated events), settings-file hygiene (local variant
  only, backup, uninstall), transcript reader against fixtures. The reference
  (claude) adapter additionally runs the live suite nightly.
- **Voice adapters:** contract tests over recorded fixtures — stream start latency,
  cancel latency (barge-in ≤ 250 ms simulated), error taxonomy mapping (auth vs
  transient vs latency-breach → correct failover state machine transitions).
- A new adapter PR is *only* its adapter + passing conformance run — any core diff
  fails the import-boundary lint (ENGINEERING-STANDARDS §1).

## 6. Agent-behavior evals (quality, not correctness)

Weekly and pre-release, with real engines, scored by rubric (LLM-judged with human
spot-check), non-gating but tracked as trend lines in the org panel:

- **E-DECOMP**: 10 canned directives → Artemis task specs; rubric: self-contained,
  right-sized, correctly routed by capability.
- **E-ESCALATE**: 20 borderline requests → does Artemis escalate exactly the critical
  ones (precision *and* recall against a labeled set)?
- **E-MEMO-Q**: memo quality rubric: real options, honest blast radius, rollback
  present.
- **E-BRIEF-FAITH**: generated brief vs ground-truth fixture ledger — hallucination
  rate must be zero (any unref'd claim fails the run; this one *does* gate release).
- **E-PLAYBOOK**: incident drill on the fixture repo — time-to-triage and
  playbook adherence.
- **E-GYM**: seeded operating records (metrics, log, breaker/budget fixtures with
  planted friction) → does Artemis surface the *planted* improvement opportunities,
  and are its proposals valid per FR-12.2 (evidence-ref'd, single-scoped, falsifiable
  metric, honest rollback)? Precision matters more than recall — speculative
  unreferenced proposals fail the run. Tracked alongside the live Gymnasium health
  ratio (validated vs regressed) from the ledger.
- **E-STOA**: a fixture source seeded with planted applicable patterns (and noise) →
  does the researcher surface the *planted* patterns with correct citations and an
  honest applicability mapping? Same precision bias as E-GYM: an uncited or
  speculative finding fails the run. Tracked alongside the Stoa's live health
  metrics (approved proposals per brief; validated ratio of Stoa-seeded proposals).

## 7. Performance & soak

- Bench harness (nightly): 15 fake agents at realistic event rates — assert NFR
  budgets: delivery p95 ≤ 500 ms, hook→state p95 ≤ 200 ms, floor ≥ 60 fps (frame
  timing probe), 30-agent degraded mode holds 30 fps.
- 24 h soak weekly: memory ceiling flat (leak budget < 2 MB/h), zero fd leaks, Agora
  repo growth linear with events, watchdog false-nudge count = 0.
- Startup: cold boot to interactive floor ≤ 4 s with 10 restored agents.

## 8. CI gates summary

Per-PR: typecheck · lint (incl. boundaries, token/hex, secret tripwires) · unit ·
integration · conformance · E2E smoke · schema-migration check (changed schema ⇒
bumped version + migration test).
Nightly: full E2E · live engine suite · bench.
Weekly: soak · evals · mutation (rotating).
Release: everything + S-suite full pass + E-BRIEF-FAITH gate + `npm audit` policy +
signed builds smoke-launched on all three OSes.
