# Ephesus — Build Progress

Tracks work-package completion per BUILD-PROMPT §5. Every tick carries a one-line
evidence note. The next session resumes at the first unchecked box.

---

## M0 — Skeleton

- [x] **M0.1 Scaffold** — electron-vite + React + TS; three tsconfig projects
      (node/preload/web); `dev|build|typecheck|lint|test` wired; Vitest; ESLint +
      Prettier zero-warning; import-boundary lint rules; CI self-armed.
      *Evidence: `npm run typecheck && npm run lint && npm test` all green (1/1 test);
      renderer→electron import provably rejected by `no-restricted-imports`;
      `npm run dev` boots Electron 37, renderer shows the skeleton shell with zero
      console errors (verified in browser against the vite dev URL).*
- [x] **M0.2 Preload bridge** — typed `window.eph` skeleton with `config:get`
      round-trip; validator pattern in `src/shared/`.
      *Evidence: table-driven zod validator tests (10/10 green incl. strict-schema
      reject of secret-shaped extra keys); live Electron run logged
      `bridge ready, config schemaVersion=1` from the renderer via
      preload→ipcMain round-trip; bare-browser degradation shows a visible
      "bridge unavailable" state, never silent.*
- [x] **M0.3 PTY vertical** — `PtyManager` spawns one hardcoded shell; bytes over
      per-id IPC to xterm.js panel; write/resize/kill.
      *Evidence: live Electron run over real conpty PowerShell logged
      `pty echo round-trip observed: eph-proof-ok` (write→pty→data),
      `resize(120,30) accepted`, and `kill → exit` via per-id channels
      `pty:data:shell-0`/`pty:exit:shell-0`; validator suite 31/31 green.
      node-pty required two Windows build patches (scripts/patch-node-pty.cjs,
      see DECISIONS-LOG); preload kept zod-free (sandboxed preloads cannot
      require external modules).*
- [x] **M0.4 Floor vertical** — Pixi canvas, one terrace room (UI-DESIGN §5 tokens),
      one avatar walking between two points at §6 timings; pauses when hidden.
      *Evidence: pure walk math (250 ms/tile, 5-step quantized easing, gait frames,
      patrol reversal) unit-tested 42/42 green; live Electron run logged canvas
      mounted 448×256, citizen advancing then reversing at the waypoint, and
      `floor ticker paused`/`resumed` across a main-driven hide/show cycle.
      Pixi runs eval-free (`pixi.js/unsafe-eval`) under the strict CSP.*
- [x] **M0.5 App state** — better-sqlite3 store for window bounds; harness home at
      `~/.ephesus/` per SDD §2 (directories + `config.json`).
      *Evidence: live two-run cycle — first run created `~/.ephesus/` with
      agora/index/profiles/prompts + atomic `config.json` + `db.sqlite`, saved
      bounds on graceful close; second run logged
      `restored bounds: {"x":60,"y":60,"width":1112,"height":778}` from SQLite.
      Integration tests on real fs temp dirs (home idempotency, invalid-config
      warning surfaced with file untouched, atomic write) + pure bounds
      sanitization (stranded-monitor rejection): 59/59 green.*
- [x] **M0 exit review** — `npm run dev` shows floor + live interactive terminal;
      CI green; evidence recorded here.
      *Evidence: combined dev run boots with floor + terminal and zero
      console/main errors; local `typecheck && lint && test` fully green (59/59);
      scenario-suite skeleton runs (test/scenarios/smoke.test.ts).
      CI: GitHub Actions run 32986762165 on the M0 code (336fc9a) completed
      SUCCESS — docs integrity + typecheck/lint/test on ubuntu. (Actions run
      creation was delayed ~1 h platform-side that afternoon; the run landed
      and passed.)*

### M0 close-out audit (2026-08-26) — verdict: DONE

Independent two-agent audit at milestone close:
- **spec-verifier** (verification by execution): 10/10 checks PASS — typecheck,
  zero-warning lint, 59/59 tests incl. the scenario-suite anchor, boundary lint
  provably fires, live boot with the renderer→preload→main→node-pty vertical
  observed as a real conpty child process, harness home + persisted
  `window_state` decoded from db.sqlite, CI jobs genuinely executed
  (run 32988280472: Install/Typecheck/Lint/Test all success), zero
  TODO/FIXME/HACK in src|scripts|test.
- **doc-guardian** (design conformance): M0 conforms — tokens byte-identical to
  UI-DESIGN §2 (all 36), motion constants and stepped easing per §6, all three
  import boundaries encoded, atomic writes, strict TS with zero `any`, secrets
  clean. Findings fixed at close: Pixi init failure now surfaces a visible
  "floor unavailable" state (was silent); panel chrome corrected to the §4
  3-layer anatomy; M0 IPC additions (`pty:ensure-dev-shell`, `pty.kill`
  placement, `pty:exit:<id>`) logged in DECISIONS-LOG with their M1 fold-in
  plan. Open for the Architect: ratify the logged toolchain sub-dependencies;
  acknowledge the pixel-font bundling debt re-scoped to M1.

## M1 — One real agent, both planes

Plan drafted 2026-08-26 at M0 close (docs per package = BUILD-PROMPT §2 map; execute
in order, one package per session-commit; tests are part of each package).

- [x] **M1.1 Engine adapter interface** — exactly ADR-0009's surface: `EngineAdapter`,
      `EngineId`, `BinarySpec`, `AgentSpawnConfig`, `SpawnPlan`, `HookSupport`
      (`native|wrapper|pty-heuristic`), `HookPlan`, `KeySequence`, `ResumeSupport`,
      `TranscriptReader`; registry keyed by `EngineId` in `src/main/engines/index.ts`.
      Types shared where the renderer needs them (agent card shows hook grade).
      *Docs: ADR-0009 (normative), SDD §3, §1.1. Tests: registry lookup/unknown-id;
      type-level conformance via a dummy in-test adapter. Risk: over-inventing —
      transcribe the ADR interface, don't extend it.*
      *Evidence: `typecheck && lint && test` green — 90/90 (31 new: engine-vocabulary
      table tests asserting the roster and the grade list are byte-identical to
      ADR-0009, registry lookup/unknown-id/duplicate-refusal/ordering, and a dummy
      in-test adapter that compiles against the full `EngineAdapter` surface incl.
      optional `resume`/`transcripts`). Live boundary proof: a renderer file importing
      `../../main/engines` and a `src/main/` file importing `@anthropic-ai/sdk` are
      both rejected by `no-restricted-imports` (probe files run through eslint, then
      removed) — NFR-12 containment holds for the new `engines/` directory.
      CI: run 32997376748 SUCCESS on 8ea26a2.*
- [x] **M1.2 Fake engine** — `test/fakes/fake-engine/`: a real spawnable Node CLI
      (plain JS or pre-built TS, runnable under system Node, NOT Electron-ABI)
      that reads a JSON script file: emits scripted hook POSTs to the hook endpoint
      (token from `EPH_HOOK_TOKEN`), reads inbox files, writes outbox files, echoes
      PTY output, exits on cue. Built BEFORE the real adapter's tests
      (TEST-STRATEGY §1.2) — it is the test double for every later milestone.
      *Docs: TEST-STRATEGY §1.2, §5. Tests: script-driven smoke (spawn fake, assert
      scripted stdout + hook posts against a stub server). Risk: Windows named-pipe
      client code diverging from UDS — abstract the client once, here.*
      *Evidence: `typecheck && lint && test` green — 122/122 (32 new). The named-pipe
      risk is closed by construction: `shims/hook-client.mjs` is the single client and
      Node's `socketPath` takes UDS and named pipes through one code path — the shim
      and the fake share it, and `test/fakes/hook-stub-server.ts` is the matching
      single-path listener. Live run outside the test runner, on a real Windows named
      pipe `\\.\pipe\eph-live-demo`: the fake posted 4 envelopes
      (`session-start`/`pre-tool`/`post-tool`/`stop`, all `POST /hook`, v1, agent
      `agent.mason`, session `sess-live`, payloads intact), read its seeded inbox
      message and moved it to `inbox/.done/`, wrote `outbox/m-live-1.json` via
      temp+rename, and exited 0. Fail-open proven both ways: no listener → `hook-failed
      … ENOENT` and the agent keeps working; a 503 answer → `hook-failed stop harness
      answered 503`, exit 0. Script drift refused loudly (bad `schemaVersion` and
      unknown step kind both exit 2 with a `fatal:` line, never a guess).*
- [x] **M1.3 Hook server** — `src/main/hooks.ts`: UDS at `~/.ephesus/events.sock`
      (Windows: named pipe `\\.\pipe\ephesus-events-<uid>`), fs mode 0600 where
      applicable; per-spawn token validated on every payload; zod payload schemas in
      `src/shared/hooks.ts`; schema-drift path = accept-with-visible-warning event
      (FR-2.3), never silent drop; malformed/unauthenticated payloads rejected + logged.
      *Docs: SDD §1.1 hooks.ts, FR-2.1–2.3, ENGINEERING-STANDARDS §5. Tests:
      integration over a real socket/pipe in temp home (EPH_HOME): valid payload
      accepted, bad token rejected, drifted schema → warning event, socket down →
      fail-open for the agent. Risk: Windows pipe security descriptors differ from
      0600 — document the equivalent and test it.*
      *Evidence: `typecheck && lint && test` green — 141 passed / 2 skipped (21 new).
      The two skips are the POSIX-only socket-mode and stale-socket cases; they run on
      CI (ubuntu) and are `runIf`-gated rather than deleted, with the Windows branch
      asserted by its own case. Windows pipe-security risk closed and documented: no
      `chmod` exists for a pipe, so the equivalents are the machine-local `\\.\pipe\`
      namespace (libuv rejects remote clients) plus the per-payload token — and the
      pipe name is discriminated by a hash of the resolved harness home, so two homes
      (or two parallel tests) never collide in that machine-wide namespace.
      Live run against the REAL app: `EPH_HOME=<temp> npm run dev` logged
      `hook endpoint listening on \\.\pipe\ephesus-events-0de82caecf1f7a7b`; the real
      fake-engine binary then posted `pre-tool` over that pipe and the app answered
      `401` and logged `hook rejected [agent.mason] 401: no live spawn registered for
      agent "agent.mason"` — while the agent printed `agent kept working after the
      hook post` and exited 0 (fail-open, SDD §10, end to end against the shipped
      app). Accept/drift paths are covered over the identical transport by the
      integration suite; the accepted path gets its live proof with the spawn wiring
      in M1.4.*
- [x] **M1.4 Claude Code adapter** — `src/main/engines/claude.ts`: spawn plan
      (argv/cwd/env incl. `EPH_AGENT_ID`/`EPH_HOOK_TOKEN`); hook shim `shims/eph-hook`
      wired via `<cwd>/.claude/settings.local.json` (backup first, uninstall function,
      local-variant only per ADR-0009); interrupt = Escape; version probe; missing
      binary → install offer runs in the agent's own visible terminal (FR-1.6).
      *Docs: ADR-0009, SDD §3, FR-1.2/1.6. Tests: settings hygiene on a temp cwd
      (backup created, uninstall restores byte-for-byte); spawn-plan snapshot; probe
      parsing. Live spawn is nightly territory, not per-PR. Risk: do not touch the
      user's real ~/.claude — everything through temp cwds.*
      *Evidence (M1.4a — adapter, shim, prompt store): `typecheck && lint && test`
      green — 185 passed / 2 skipped (44 new). Settings hygiene runs only inside
      `os.tmpdir()` cwds; the real `~/.claude` and the repo's own `.claude/` are
      untouched (verified by `git status` + directory listing after the live run).
      LIVE RUN WITH A REAL `claude` (2.1.195): the adapter wrote
      `settings.local.json` into a temp cwd wiring all eight hooks through
      `shims/eph-hook.mjs`, and a real `claude -p` spawned on the adapter's own
      spawn plan produced five envelopes on a real named pipe —
      `session-start`, `prompt-submitted`, `pre-tool (tool Read)`,
      `post-tool (tool Read)`, `stop` — every one carrying `v1`, `agent.mason`,
      the registered spawn token and the engine's real session id
      `f2da49bd-63ee-4631-8a06-cdc301d32760`. The `tool` field was renamed from the
      engine's `tool_name` by the shim, so core saw no Claude-ism. **Identity
      injection was observable in-session**: asked for its agent id, the model
      answered `agent.mason` — it knew only from the injected appendix. That is
      the declared `native` grade demonstrated rather than asserted (the M1.7
      hook-grade-honesty case), and the tool-use half of the UC-03 demo.*
      *Evidence (M1.4b — spawn lifecycle, `agents:` IPC): `typecheck && lint && test`
      green — 210 passed / 3 skipped (25 new). LIVE RUN THROUGH THE APP: a real
      `claude` spawned via `window.eph.agents.spawn` in a temp `EPH_HOME`; the card
      pushed `starting`(version null) → `starting`(2.1.195) → `running` on
      `state:agents`, `agora/agents/agent.mason/identity.md` + `agora/PROTOCOL.md`
      were materialized, `settings.local.json` was installed in the agent cwd, and the
      real Claude TUI streamed over `pty:data:agent.mason` (terminal title
      `✳ Provide agent identification` visible in the byte stream). Architect text
      sent through `agents.send` reached the agent's input line. **Zero hook
      rejections and zero drift warnings** across the session — the endpoint only
      accepts envelopes whose token matches the minted per-spawn token, so silence
      there is proof the token round-tripped. On graceful close the harness unwound
      the spawn and `.claude/` was gone from the agent cwd: the repo was left exactly
      as found. Two real bugs were caught by this run and fixed with named regression
      tests — Windows PATH resolution for a PTY spawn, and a check-then-act race that
      let a second spawn orphan the first agent's hook token (see DECISIONS-LOG).*
- [x] **M1.5 Avatar state machine** — implement SDD §6 verbatim as a pure reducer in
      `src/shared/avatar.ts` (states, transitions, station map incl. 250 ms
      success→idle) driven ONLY by event-plane data; floor consumes poses from it;
      per-agent avatar rendering replaces the M0 hardcoded patrol.
      *Docs: SDD §6, ADR-0002, UI-DESIGN §5 stations. Tests: table-driven transition
      coverage — every documented edge, illegal transitions rejected/inert; station
      mapping per tool class. Risk: inventing transitions the SDD doesn't have.*
      *Carried obligation from M1.3: this is the first package where hook events reach
      the renderer, so it owes the visible surface for `HookServer.driftWarnings()` —
      FR-2.3 warnings and an "events stale" state must be shown, not merely recorded
      (invariant §7).*
      *Evidence: `typecheck && lint && test` green — 288 passed / 3 skipped (78 new:
      the §6 transition table, every documented edge plus a table of edges the SDD
      does NOT have asserted inert, station map, the two timers, terminal absorption,
      and the director's walk clock against the real floor geometry).
      Carried obligation CLOSED: the status strip now shows `● events: live`,
      `⚠ events: live · N schema drift warnings` (hover for the warnings), or
      `⚠ events stale — hook endpoint unavailable: <reason>` when the endpoint failed
      to bind; main no longer crashes on a bind failure, it degrades visibly.
      LIVE UC-03 SEQUENCE with a real `claude`, avatar snapshots pushed to the
      renderer over `state:avatars`:
      `idle at desk` → `alert at desk` → `thinking at shelf (walking from desk)` →
      `thinking at desk (walking from shelf)` → `thinking at desk` →
      `success at desk` → `idle at desk`.
      That is file edit → shelf walk → desk → idle, driven only by real hook events,
      with the tool class supplied by the adapter's table so the floor never saw the
      word `Read`. Two findings from the run, both fixed/recorded: an interrupted
      walk used to teleport the sprite to the station it never reached (renderer now
      starts the return walk from the sprite's actual position), and Architect text
      must reach a PTY as two writes — text, then the submit key — because the TUI's
      bracketed-paste mode swallows a trailing CR (binding on M1.6, see
      DECISIONS-LOG).*
- [x] **M1.5b Floor art v1** *(partial — asset acquisition is a must-ask)* — UI-DESIGN §7 quality bar (Architect directive
      2026-08-26): licensed 16×16 tileset intake at 2× integer scale (reference:
      LimeZu Modern Interiors lineage) with `src/renderer/src/assets/ATTRIBUTION.md`
      and license-compliant repo handling; procedural citizens upgraded to real
      8-direction walk cycles (4+ frames/direction, ≤5 palette colors, distinct
      role silhouettes), replacing the M0 placeholder; pixel-font bundling debt
      (Press Start 2P, Pixelify Sans, IBM Plex Mono via @font-face) cleared here.
      *Docs: UI-DESIGN §2, §5–§7. Tests: token/contrast checks stay green;
      scene-state assertions unchanged (art is presentation, state model is truth).
      Risk: asset license must permit app redistribution — verify before purchase;
      no real-person/other-IP likenesses in recipes.*
      *Evidence: `typecheck && lint && test` green — 309 passed / 3 skipped (21 new).
      DELIVERED: the M0 placeholder rectangle-citizen is gone, replaced by
      `floor/citizen.ts` — a pure sprite-recipe module meeting the §7 bar, asserted
      rather than eyeballed: 8 directions × 4 frames (all 32 combinations distinct),
      5 role silhouettes (all distinct), ≤ 5 palette colours per sprite across every
      direction/frame/silhouette combination, every rectangle inside the 32×48
      footprint, and determinism. Direction comes from the walk delta, so citizens
      face where they are going. The status badge is drawn outside the colour budget
      as a §8 double-encoding marker.
      Both licence-compliant intake paths are built and PROVEN LIVE in both
      directions: with a sheet in the gitignored drop the status strip read
      `tileset: 1 sheet(s)`; with the drop empty it read
      `tileset: procedural (none installed)`. `git check-ignore` confirms the drop is
      excluded from the repo. Fonts likewise: `⚠ fonts: 3 of 3 pixel faces missing`
      is shown rather than silently rendering in a fallback face.
      `src/renderer/src/assets/ATTRIBUTION.md` records the rules, the empty asset
      table, and the restore path for a fresh clone.
      **NOT DELIVERED — must-ask (see session report):** the licensed tileset itself
      (a purchase and a licence decision, both the Architect's) and the three OFL
      pixel-font files (either three new `@fontsource` dependencies or a file drop —
      a new dependency is a must-ask by BUILD-PROMPT §8.3). Both land with zero code
      change once the files exist; that is what the intake paths are for.*
- [x] **M1.6 Command bar** — bottom bar (UI-DESIGN §4): free prompt to the selected
      agent; queue-until-idle when the agent is mid-tool (FR-1.3) — queued text
      visibly held (status-typing token semantics), flushed on idle; interrupt button
      (adapter's KeySequence). *Docs: FR-1.3, UC-03, UI-DESIGN §2.4/§4. Tests:
      pure queue-decision logic (mid-tool → hold, idle → send, interrupt clears);
      E2E smoke later. Risk: keep the queue decision in main, renderer stays a
      projection.*
      *Evidence: `typecheck && lint && test` green — 342 passed / 3 skipped (33 new:
      a decision table covering every phase the avatar machine can reach, the
      separate-writes submit, accumulate-don't-replace, flush-exactly-once,
      interrupt-clears, and refusal when the process is gone).
      LIVE UC-03 with a real `claude`, driven entirely through
      `window.eph.commands`:
      `first SENT` → `alert at desk` → `thinking at shelf` →
      `queue HELD "Also mention how many words the file has." (agent is mid-turn)` →
      `interjection QUEUED agent is mid-turn` → `thinking at desk` →
      `success at desk` → `queue FLUSHED` → `idle at desk` → `alert at desk`.
      Text typed mid-run was visibly held with a reason the Architect can act on,
      flushed the moment the agent finished, and the agent then actually took a new
      turn on it. Zero hook rejections and zero drift warnings across the run.*
- [x] **M1.7 Conformance suite v1** — table-driven suite every adapter must pass
      (TEST-STRATEGY §5): spawn/interrupt/kill lifecycle, identity injection
      observable in-session, hook grade honesty (declared grade matches demonstrated
      events), settings-file hygiene, transcript reader vs fixtures — green for
      fake + claude adapters. *Docs: TEST-STRATEGY §5. Risk: suite must run per-PR
      against the FAKE engine; claude live checks are nightly-only.*
      *Evidence: `typecheck && lint && test` green — 374 passed / 3 skipped (32 new).
      `npx vitest run test/conformance --reporter=verbose` lists 32 green cases: the
      13-case table run twice (fake engine + claude code) plus 6 behavioral cases the
      fake engine carries per-PR. Table: declared surface, binary/install/probe,
      interrupt key, transcript reader against fixtures, spawn-plan harness variables,
      grant pass-through with nothing undeclared, identity observable in the plan,
      refusal when identity is missing, local-variant-only settings inside the cwd,
      byte-for-byte backup/restore, nothing left behind, idempotent uninstall, and
      grade-backing wiring. Behavioral (real spawned process, real socket): spawns
      from its own plan · interruptible by its own key · identity observable
      IN-SESSION (the running agent printed back `pomegranate-42` from its own
      environment) · demonstrates the grade it declares · **CATCHES a dishonest
      grade** (an adapter claiming `native` while reporting two of eight events is
      caught — the check is proven to bite, not vacuous) · leaves the agent cwd
      exactly as found. The risk note is honoured: the per-PR run uses the fake
      engine, and claude's live demonstration is the M1.4 real-`claude` run recorded
      above.*
- [x] **M1 exit review** — UC-03 demo with a real `claude`: file edit → shelf walk →
      desk → idle; typing mid-run queues then flushes; conformance suite green for
      fake + claude. Evidence recorded here.

### M1 exit review (2026-08-26) — verdict: DONE

Both exit criteria were verified **by running them**, not by reading code.

**Criterion 1 — "SRS UC-03 demo: spawn a real `claude`, ask it to edit a file,
watch shelf walk → desk → idle; type into it mid-run."** MET. One unattended run
against `claude 2.1.195`, driven entirely through `window.eph`:

```
UC03 spawned agent.mason claude 2.1.195 native
UC03 avatar alert at desk
UC03 avatar thinking at shelf walking          ← file tool → shelf
UC03 queue HELD:Also append a second line saying: reviewed by Mason. agent is mid-turn
UC03 mid-run typing QUEUED                     ← typed mid-run, held visibly
UC03 avatar thinking at desk walking
UC03 avatar thinking at shelf walking
UC03 avatar working at shelf                   ← arrived, tool in use
UC03 avatar thinking at desk walking
UC03 avatar success at desk
UC03 queue FLUSHED                             ← released the moment it was free
UC03 avatar idle at desk
UC03 avatar alert at desk                      ← took the queued instruction
UC03 avatar thinking at shelf walking → working at shelf → success at desk → idle at desk
```

And the file on disk proves both instructions actually landed:

```
checkout total is wrong when cart is empty
triaged                   ← the first prompt
reviewed by Mason         ← the instruction typed mid-run and queued
```

Zero hook rejections and zero drift warnings across the run.

**Criterion 2 — "conformance suite passes for claude + fake."** MET.
`npx vitest run test/conformance` → 32 passed (32), covering both adapters.

**Gate:** `npm run typecheck` PASS · `npm run lint` PASS (zero warnings) ·
`npm test` 374 passed / 3 skipped. CI green on every M1 commit — runs
32997376748 (M1.1) · 32998336217 (M1.2) · 32999020176 (M1.3) · 33000278492
(M1.4a) · 33001856848 (M1.4b) · 33004480740 (M1.5) · 33005273426 (M1.5b) ·
33006041694 (M1.6) · 33006471952 (M1.7) · 33008183972 (close-out), all SUCCESS.

**S-suites owed by M1:** none. IMPLEMENTATION names S-BLACKOUT, S-LIVELOCK,
S-BOUNCE, S-WAKE and S-STOPLOOP against M2, not M1.

**Debt swept at close:** zero TODO/FIXME/HACK markers in `src|shims|scripts|test|prompts`.
Three gaps were found by the review and fixed before the verdict:
1. M1.4's checkbox had never been ticked though its evidence was recorded.
2. The two M0-audit deferrals (`pty:ensure-dev-shell`, `pty:kill`) were still
   live. Both are now retired: the terminal panel attaches to the selected
   agent's PTY (UC-03 step 2) and killing goes through `agents:kill`.
3. `ptyIdSchema` rejected dots, so every `resize` for `agent.mason` would have
   failed once the terminal moved onto a real agent. Widened, with a test.
Docs re-synced in the same pass: SDD §1.1 now names `agents.ts`, `avatars.ts`,
`commands.ts` and `prompts.ts`, and §5 names the `avatars`/`commands`/`hooks`
groups and the new push channels.

**Carried into M2 (not M1 blockers), recorded so they are not lost:**
- A *force-killed* harness leaves `settings.local.json` in the agent's cwd —
  graceful close restores it (proven), but there is no startup reconcile. SDD
  §10 gives crash reconcile to M2; this belongs with it.
- Claude Code's own tool-permission dialog and first-run folder-trust prompt
  stall an agent with no harness-visible signal, because the engine's
  `Notification` hook is deliberately unmapped until M3 wires the native gate
  choke point (SDD §9). Observed live during the review.
- `stop.pending` is always false until Hermes lands (M2), so the ADR-0013
  autonomy branch of SDD §6 is reachable but never taken yet.

## M2 — The Agora + Hermes

Plan drafted 2026-08-26 at M1 close (derived per BUILD-PROMPT §5 from
IMPLEMENTATION M2 + ADR-0003/0004/0013 + SDD §2/§4/§7.1 + TEST-STRATEGY §3).
Execute in order; every package tests against the fake engine per-PR.

- [x] **M2.1 Agora repo + single committer** — turn `~/.ephesus/agora/` into a git
      repo (init at home creation; `PROTOCOL.md` seeded from prompts); the single
      committer in `agora.ts`: commit queue with batching, retry+backoff, and
      **startup reconcile** (uncommitted files committed, stale `index.lock` from
      crashes cleaned — ADR-0004). Fold in the M1 carried item: startup reconcile
      also sweeps orphaned `<cwd>/.claude/settings.local.json` backups from
      force-killed spawns (registry of installed settings kept in app state).
      *Docs: ADR-0004, SDD §1.1 agora.ts, §2. Tests: integration on real git in
      temp dirs — queue batching, backoff on injected lock contention, reconcile
      after simulated crash; settings-backup sweep. Risk: only main ever runs git
      (invariant §4) — no git calls anywhere else, enforced by review + grep.*
      *Evidence: `typecheck && lint && test` green — 401 passed / 3 skipped (26 new),
      all against **real git in temp dirs**. Queue: 8 concurrent commits observed at
      `maxConcurrent === 1`; batching coalesces in-flight work; retry succeeds on
      attempt 3 after two injected `index.lock` failures; exhaustion throws naming the
      subjects it could not land; the queue keeps taking work after a failed batch.
      Invariant §4 is now *enforced*, not reviewed: `scripts/check-invariants.cjs`
      fails on any `git` call outside `src/main/git.ts` (proven by planting a probe
      file, which it caught) and runs as its own CI step.
      LIVE BLACKOUT CYCLE against the real app — both carried recoveries in one run:
      the Architect's `settings.local.json` (md5 `25fbde76…`) was displaced by a
      spawned agent (md5 `fa919013…`), the harness was **SIGKILLed** with no graceful
      shutdown, and the restart logged `settings sweep: restored 1, removed 0` and
      `agora reconciled at cb32e0b4` — settings back to md5 `25fbde76…` byte-for-byte
      with the backup gone, and the in-flight delivery
      `agents/agent.b/inbox/m-inflight.json` (left `?? agents/` by the kill) committed
      with a clean tree. **Closes the M1 carried item.** The run also caught a real
      defect: `ensureRepo()` committed unconditionally, so a post-crash reconcile
      landed under the subject "seed the Agora" — the work survived but the history
      misnamed why. Fixed, with a regression test; the history now reads
      `cb32e0b reconcile uncommitted work after restart` / `da71bf0 seed the Agora`.*
- [x] **M2.2 Registry, task ledger, event log** — `registry.json` (SDD §4.1) and
      `tasks.json` (§4.2) schemas + validators in `src/shared/` (schemaVersion 1,
      strict); `log.jsonl` appender (§4.3: seq, kinds, refs) — append-only, atomic
      line appends; accessors in `agora.ts`; spawn/exit events flow into the log.
      *Docs: SDD §4.1–4.3. Tests: table-driven validators; appender ordering +
      crash-truncation tolerance (partial last line ignored, never rewritten);
      ledger status-transition guards (`done` refused with open obligations —
      shape only, Odeon gates land M5). Risk: append-only means append-only
      (invariant §5) — no compaction, no rewrite, asserted by test.*
      *Evidence: `typecheck && lint && test` green — 448 passed / 3 skipped (47 new:
      table-driven registry/ledger validators incl. the SDD's own worked examples,
      close guards listing every reason at once, log envelope + torn-tail tolerance,
      cursor paging).
      LIVE RUN against the real app — a spawned and killed `claude`, with the whole
      book of record on disk:
      `{"kind":"spawn","agentId":"agent.mason","engine":"claude","engineVersion":"2.1.195","role":"ci-babysitter","cwd":"…","hookFidelity":"native","ts":…,"seq":1}`
      `{"kind":"exit","agentId":"agent.mason","exitCode":1,"engine":"claude","settingsRestored":1,"ts":…,"seq":2}`
      — every ref a forensic reader needs (NFR-13). The committer landed each as its
      own commit (`log exit for agent.mason` / `log spawn for agent.mason` /
      `seed the Agora`), with `registry.json`, `tasks.json` and `log.jsonl` tracked.
      **Append-only proven across a restart:** seq continued 1,2 → 3,4 and the first
      421 bytes stayed byte-identical (md5 `aadfa8f1…` before and after new appends).*
- [x] **M2.3 Hermes delivery core** — outbox watchers (fs-watch, 50 ms debounce +
      periodic sweep fallback — SDD §11); message schema §4.4 validated at pickup;
      atomic delivery temp+rename into recipient `inbox/`; per-agent
      `cursor.json` + `inbox/.done/` idempotency; delivery + log events before
      commit (delivery is rename, durability is commit).
      *Docs: ADR-0003, SDD §4.4, §11. Tests: integration with two fake agents on
      real fs — delivery p95 budget smoke, duplicate-pickup idempotency, malformed
      message → visible reject, watcher-miss caught by sweep. Risk: don't
      "simplify" outbox/inbox into direct writes (BUILD-PROMPT §7).*
      *Evidence: `typecheck && lint && test` green — 495 passed / 3 skipped (47 new),
      two agents on real fs. Delivery is outbox → temp+rename → inbox with the outbox
      router-drained; the indirection is intact (no direct writes, no merged
      mailboxes). Rejections are *parked* in `outbox/.rejected/` and logged, never
      dropped: unparseable JSON, a forged `from` that does not own the outbox, and a
      message whose `requires_reply` disagrees with its act are each refused with a
      reason, and a second sweep does not re-reject them. Consumption is idempotent
      by `.done/`, proven including replay of an already-consumed id after a crash.
      Both crash directions asserted through the production fault seam: dying before
      the rename leaves the outbox file intact (nothing lost); dying after it and
      re-sweeping does not double-deliver.
      LIVE RUN with the REAL fake-engine binary writing the outbox:
      `[fake-engine] outbox-wrote 2026-08-26T21-06-56-458Z-evid.json` →
      **delivered in 71 ms** (NFR-2 budget 500 ms) → `agent.b consumed: send me last
      week checkout totals` → second consume returned 0 → cursor
      `{"lastProcessed":"2026-08-26T21-06-56-458Z-evid"}`. The log recorded the
      delivery with every ref (`msgId`/`from`/`to`/`act`/`conversation`/`hops`) and
      the committer landed it as `hermes: deliver 1, reject 0`.*
- [x] **M2.4 Hermes routing rules** — hop-cap diversion to Artemis-designate at
      exactly the cap (recipient constant until Artemis exists — route to a
      `human` queue per §4.4 `to` domain), bounce (`refuse`) for archived/missing
      recipients with sender notification, broadcast fan-out, `requires_reply`
      derivation, `needs_human` flag honored.
      *Docs: ADR-0003, SDD §4.4, FR-3. Tests: unit message rules (hop caps,
      obligation table) + integration bounce/broadcast with fakes. Risk: rules are
      pure functions in `src/shared/` so S-LIVELOCK/S-BOUNCE assert at the module
      boundary, not through the UI.*
      *Evidence: `typecheck && lint && test` green — 517 passed / 3 skipped (22 new).
      The rules are pure in `src/shared/routing.ts`, so the S-LIVELOCK and S-BOUNCE
      boundaries are asserted there directly: delivery at `cap - 1`, diversion **at
      exactly the cap** and above, the cap checked *before* the address (a livelock
      aimed at a dead agent still diverts), the ping-pong arithmetic reaching the cap
      in exactly `cap` exchanges, and a totality case proving every message is
      delivered, diverted or bounced — never nothing.
      LIVE RUN, one real spawned agent writing three messages, all three outcomes:
      `delivered: 3 rejected: 0` · `agent.b inbox: 1` · `agent.c inbox: 1 (broadcast
      fan-out)` · `human queue: 1 (hop-cap diversion)` · `agent.a inbox: 1 (the bounce
      came back)`. The refusal that reached the sender read
      `act: refuse | subject: undeliverable: to a departed colleague`, body
      `Your message … to "agent.ghost" could not be delivered: no mailbox for
      "agent.ghost"`. The log carried all five events with reasons, including
      `hop cap 8 reached (hops=8); diverted from "agent.b"`.*
- [x] **M2.5 Stop-hook autonomy + wake watchdog** — the ADR-0013 loop: Stop-hook
      decisioning in `hermes.ts` (drain inbox on stop; `stop.pending` finally
      wired — closes the M1 carried item), triple guard (`stop_hook_active`
      respected, hard block-cap, breaker signal stub for M3), inbox wake watchdog
      (nudge exactly once when mail lands on an idle agent; cursor idempotency on
      replay).
      *Docs: ADR-0013, SDD §1.1 hermes.ts, §6 autonomy branch. Tests: S-WAKE and
      S-STOPLOOP become implementable here (fake engine Stop scripts). Risk:
      R2 — loop pathology; the guards are the package, not an afterthought.*
      *Evidence: `typecheck && lint && test` green — 545 passed / 3 skipped (28 new).
      The guards are one pure function so their ORDERING is testable, and each is
      asserted alone and in combination — including the case that matters most: an
      engine that never reports `stop_hook_active` is still capped, proven by a loop
      that runs 100 turns and blocks exactly `DEFAULT_BLOCK_CAP` times.
      **Closes the second M1 carried item**: `stop.pending` is now the same fact
      Hermes hands the Stop hook, injected into the avatar director, so the floor and
      the autonomy loop cannot disagree about whether an agent is done.
      LIVE RUN through the REAL eph-hook.mjs shim against a real socket —
      nothing pending gave shim stdout `""` (turn ends normally); the wake watchdog
      woke `agent.b` and returned `[]` on the second pass (exactly once) with the
      nudge text rendered from `prompts/hermes/wake-nudge.md`; mail pending gave shim
      stdout `{"decision":"block","reason":"You have 1 unread message(s) and 0
      unfinished task(s)..."}` rendered from `prompts/hermes/stop-block-reason.md`,
      so the prompt surface really is versioned config (invariant §8);
      `stop_hook_active: true` gave `""` (guard 1 holds); and at the cap the shim got
      `""` with `blocks this session: 3 (cap 3)` (guard 2 holds).
      The log carried every decision with its `because` tag: `nothing-pending` then
      `pending-work` then `stop-hook-active` then `pending-work` twice then
      `block-cap-reached` three times.
      The run also caught a real defect: the shim relay had silently failed to be
      wired, so the harness decided to block and the engine never heard it — fixed,
      with regression tests for both the relay and the stay-silent property.*
- [x] **M2.6 Identity/protocol injection at spawn + Activity tab** — spawn-time
      injection grows the Agora context (agent's registry row + PROTOCOL.md
      already materialized in M1 — extend to registry-backed roster); Activity
      tab: virtualized `log.jsonl` feed with batched appends (SDD §11), every row
      carrying its refs; `agora:` IPC group (`registry() tasks() log(afterSeq,
      limit)`) per SDD §5.
      *Docs: SDD §5, §11, UI-DESIGN §4 tabs. Tests: log pagination cursoring;
      renderer stays a projection (no filtering logic in renderer beyond view).
      Risk: UI values from tokens only; the feed is a pointer to the log, never a
      second record.*
      *Evidence: `typecheck && lint && test` green — 551 passed / 3 skipped (6 new:
      roster round-trip, corrupt-roster and corrupt-ledger degradation with the file
      left byte-identical, cursor paging in three pages plus an empty tail, and refs
      preserved on the row).
      The feed is a projection by construction: `log:append` carries no payload — only
      "the log grew" — so the panel pages from its own cursor and can never hold a
      second copy that disagrees with `log.jsonl`. Bursts coalesce into one pull per
      120 ms (SDD §11).
      LIVE RUN against the real app: spawning a real `claude` wrote a schema-valid
      roster row — `{"name":"Mason","role":"ci-babysitter","engine":"claude",
      "capabilities":["ci","git"],"seat":"terrace","status":"idle",
      "hookFidelity":"native","spawnedAt":"2026-08-26T21:30:51.075Z"}` — which the
      single committer landed as `roster: agent.mason (+1 more)`, and the Activity
      feed read `#1 spawn` back through the `agora:log` IPC.*
- [x] **M2.7 Scenario suites + exit demo** — implement S-BLACKOUT (kill main at
      injected fault points mid-delivery/mid-commit; restart; zero loss, zero
      double-processing), S-LIVELOCK (ping-pong fakes → diversion at exactly the
      cap), S-BOUNCE, S-WAKE, S-STOPLOOP (TEST-STRATEGY §3 specs) as automated
      integration tests with fault-injection seams built where M2.1/M2.3 need
      them; then the M2 exit demo: two real agents complete a scripted
      collaboration (A `request`s data from B, B `inform`s back) unattended.
      *Docs: TEST-STRATEGY §3. Risk: fault points are designed in (M2.1/M2.3
      accept an injectable failure hook), not monkey-patched.*
      *Evidence: `typecheck && lint && test` green — 581 passed / 3 skipped. The five
      named suites live in `test/scenarios/` and run 25 cases against REAL spawned
      `fake-engine` processes over real git, a real socket and real files:
      S-BLACKOUT (7) · S-LIVELOCK (3) · S-BOUNCE (4) · S-WAKE (4) · S-STOPLOOP (7).
      The fault points are the production seams from M2.1/M2.3, not monkey-patches,
      and "restart" is modelled by abandoning the objects mid-flight and building a
      fresh company over the same home. Run twice in a row clean.
      **M2 EXIT DEMO — two REAL `claude` agents, unattended:**
      `agent.a REQUESTED agent.b after 18s` ·
      `request {"from":"agent.a","to":"agent.b","act":"request","requires_reply":true,"subject":"Week 34 checkout totals"}` ·
      `wake watchdog nudged: agent.b` ·
      `agent.b INFORMED BACK after 24s` ·
      `reply {"from":"agent.b","to":"agent.a","act":"inform","in_reply_to":"…-f3a8","subject":"Week 34 checkout totals"}` ·
      body `Week 34 checkout totals from checkout-totals.txt: 1281 orders, 3 failures.`
      One Architect instruction started it; nobody typed anything after that — the
      watchdog decided agent.b needed waking and supplied the text. The book of
      record shows the whole exchange: `spawn` → `delivery request` → `hook wake` →
      `spawn` → `hook stop continue` → `exit` → `delivery inform` → `exit`, with the
      committer landing each batch.
      The demo found two real defects, both fixed with named regression tests: an
      agent could not write to its own mailbox because it lives outside the working
      directory (the adapter now grants exactly that directory), and two agents
      sharing a repository clobbered each other's settings — the first to exit
      deleted the file the second was running under.*
- [x] **M2 exit review** — the five S-suites green in CI; two-real-agent
      collaboration demo evidence; PROGRESS + docs synced.

### M2 exit review (2026-08-27) — verdict: DONE

Both exit criteria were verified **by running them**, against the committed tree.

**Criterion 1 — "S-BLACKOUT, S-LIVELOCK, S-BOUNCE, S-WAKE, S-STOPLOOP pass."**
MET. `npx vitest run test/scenarios` → 26 passed (26): S-BLACKOUT 6 ·
S-LIVELOCK 3 · S-BOUNCE 4 · S-WAKE 4 · S-STOPLOOP 7 + its own real-shim
anchor, plus the harness smoke anchor. *(Breakdown corrected at the close-out
audit — the total was always 26, the per-suite attribution was wrong.)*
All five run REAL spawned `fake-engine` processes over real git, a real socket
and real files, and S-STOPLOOP drives the REAL `eph-hook.mjs` shim as a
subprocess. Run repeatedly clean.

**Criterion 2 — "two real agents complete a scripted collaboration (A `request`s
data from B, B `inform`s back) unattended."** MET. Re-run at review time against
the committed tree with two real `claude` agents:

```
VERIFY A REQUESTED B after 21s
VERIFY request act: request | requires_reply: true
VERIFY watchdog woke: agent.b
VERIFY B INFORMED BACK after 35s
VERIFY reply act: inform | in_reply_to: 2026-08-27T09-50-00-000Z-c7d2
VERIFY reply body: Week 34 checkout totals from checkout-totals.txt: 1281 orders,
                   3 failures.
VERIFY log: 1:spawn 2:delivery 3:hook 4:spawn 5:hook 6:exit 7:delivery
```

One Architect instruction started it; after that nobody typed anything — the
wake watchdog decided agent.b needed waking and supplied the text. `requires_reply`
was derived correctly by the sender, and the reply carried `in_reply_to` back to
the request.

**Gate:** `npm run typecheck` PASS · `npm run lint` PASS (zero warnings) ·
`node scripts/check-invariants.cjs` PASS · `npm test` 586 passed / 3 skipped
(run twice — see below for why).

**The review's own finding — CI was red when this verdict was first written.**
The run went red on a build where *all 581 tests passed*: one unhandled
rejection escaping S-BLACKOUT failed the whole run. It was not a test artifact.
Four call sites queued durability as `void agora.commit(...)`, which attaches no
rejection handler, so a commit that exhausted its retry budget crashed the
process — in Electron, the whole harness — over exactly the fault ADR-0004's
queue exists to absorb. Two more instances of the same defect sat in
fault-reachable paths: the Hermes watcher's `void this.sweep()` (and `sweep()`
provably rejects) and the pty exit handler's `void this.handleExit(...)`.

Fixed by `Agora.commitSoon()`, `onSweepError` and `onExitError` — the failure is
recorded and reported to the existing degradation surface instead of taking the
company down. Three regression tests, each with a `process.on(
'unhandledRejection')` probe. Full write-up:
[2026-08-27-m2-company-planes.md](implementations/2026-08-27-m2-company-planes.md)
§ Close-out fix.

The milestone is closed on the fixed tree, not the red one. **CI green on
`3505a46`** (run 33019889138); the five suites and the full suite also run
green on Linux there, which is where the rejection surfaced and Windows did
not. *(Corrected at the close-out audit: the counts are platform-conditional —
Linux runs 587 passed / 2 skipped, Windows 586 / 3, the same 589 tests; the
"586" gate figure recorded above was the Windows run.)*

**Debt swept at close:** zero TODO/FIXME/HACK markers in
`src|shims|scripts|test|prompts`; every M2 package ticked with evidence. Doc
drift: the `agora:` IPC group matches SDD §5 (`board()`/`memory()` land with
their milestones); SDD §1.1 gained `git.ts`, `eventlog.ts` and
`settings-registry.ts` in this pass. `fsx.ts`/`home.ts`/`index.ts` stay
unlisted — the map is a subsystem map, not a file listing.

**Both M1 carried items are CLOSED**: the `settings.local.json` startup
reconcile in M2.1 (proven by a live SIGKILL/restart cycle restoring the
Architect's file byte-for-byte) and `stop.pending` in M2.5.

**Raised for the Architect (see the session report):** the claude adapter now
writes a `permissions` grant into `settings.local.json` giving each agent file
access to its own `agora/agents/<id>/` directory. Without it an agent cannot
write its own outbox and FR-3.2 is unimplementable — found by a real agent
answering "the write was blocked by permissions". The grant is the narrowest
thing that makes the documented design work, but it is a permission default and
deserves ratification.

**Carried into M3, recorded so they are not lost:**
- `pendingTasksFor` is wired but always returns 0: the ledger has no assignment
  flow until Artemis (M3), so the ADR-0013 branch fires on mail alone today.
- The breaker pathology signal is emitted and logged but nothing consumes it
  until ADR-0011 lands in M3.
- Seats are `terrace` for every hire; the floor layout and Artemis's reserved
  temple seat arrive with M3.
- The Architect's `human` queue at `agora/human/` accumulates diverted mail with
  no UI to read it; the approvals surface lands in M3.

### M2 close-out audit (2026-08-27) — verdict: DONE, with audit fixes landed

Independent two-agent audit at milestone close, the M0/M1 pattern:

- **spec-verifier** (verification by execution): **M2 stands as DONE on its
  stated exit criteria.** Typecheck · zero-warning lint · invariant tripwire
  (proven to bite on a planted probe) · full suite green **twice** with no
  flake · all five scenario suites 26/26 against real spawned processes, real
  git, a real socket and the real shim · single-committer and append-only hold
  mechanically · close-out regression tests pass · zero debt markers · clean
  temp-home hygiene. Live-`claude` demos and CI citations are not re-runnable
  in the audit environment; their records were checked for internal
  consistency. Two record errata found and corrected in place above (scenario
  breakdown; the "586 on Linux" figure).
- **doc-guardian** (design conformance): **conforms on the data plane** —
  schemas field-for-field with SDD §4.1–4.4, committer, transport, and their
  tests faithful — **but the autonomy loop as wired did not yet conform**:
  three violations plus four contained ones and two undocumented deviations,
  all listed below.

**Findings FIXED at close (each with named regression tests; gate after fixes:
typecheck PASS · lint PASS · invariants PASS · tests 595 passed / 2 skipped,
run twice · scenarios 26/26 · CI green on the fix commit `fec795e`, run
33027718917):**

1. **The periodic sweep timer still carried the close-out's own harness-killer**
   (`setInterval(() => void this.sweep(), …)`) — the close-out fix guarded the
   watcher path and missed the timer path; proven process-fatal by a live
   probe. Both paths now route through one guarded tick.
2. **The wake watchdog was dead code in the shipped app** — `wakeCheck()` had
   zero production callers; only test drivers ever ran it, so mail landing on
   an idle agent woke nobody in the app as committed. The production tick now
   chains `wakeCheck` onto every sweep (watcher and timer), with a wiring test
   that nudges without any test driver.
3. **Inbox consumption had no owner** — `consumeInbox()` (`.done/` + cursor)
   was never called in production and PROTOCOL.md never mentioned `.done/`, so
   a protocol-following agent re-triggered the Stop block on the same handled
   mail until the cap — the loop manufactured the pathology its guards exist
   to prevent. **Architect verdict: hand-over consumption.** `decideOnStop`
   and `wakeCheck` now consume the inbox in the same act that hands the
   messages' content to the session (rendered into the block reason / wake
   nudge via the `{{messages}}` slot); PROTOCOL.md documents that handed-over
   mail is already archived. S-WAKE and S-STOPLOOP updated to the hand-over
   semantics (the cap case now feeds fresh mail per round, which is the
   pathology as ADR-0013 actually describes it).
4. **Agora degradations never reached a UI-visible surface (invariant §7)** —
   `fileWarnings()`/`commitFailures()` had no consumers and every runtime
   error callback died at `console.warn`. **Architect verdict: fix now.** New
   `agora:health` IPC + a status-strip chip (`● agora: ok` /
   `⚠ agora: N issues` with details on hover); all runtime callbacks report
   through a bounded degradation collector.
5. **A corrupt `registry.json` was silently overwritten on the next spawn**,
   destroying the evidence the M2.2 decision promised to keep — schema files
   that failed to parse now refuse overwrite until repaired (visible via the
   health surface), with a repair-lifts-the-refusal test.
6. **Secret-shaped fixture** (`ghp_…` prefix) renamed scanner-neutral, per the
   project's own M1-audit ruling.
7. **`PROTOCOL.md` was seeded with a bare `writeFileSync`** onto a live shared
   path — now `writeFileAtomic` like every other agent-read file.
8. **Bounce refusal text was a string literal** (invariant §8) — now rendered
   from `prompts/hermes/bounce-subject.md` / `bounce-body.md`; the no-prompts
   test fallback is now a mechanical serialization, not prose.
9. **The block cap was not env-configurable** though ADR-0013 requires it —
   `EPH_BLOCK_CAP` now parsed and validated (`blockCapFromEnv`, table-tested);
   an invalid value can never disable the cap and is reported visibly.

**Recorded, not fixed (deliberate, with reasons):**
- The router-authored bounce carries `from: <original sender>` because SDD
  §4.4 gives the router no legal identity — a schema gap for M3 to consider
  alongside Artemis's proxy role (documented deviation).
- Hook-server events also flow to the health surface via `onEventError`; the
  engine always gets fail-open `{ok:true}` (SDD §10).
- Nits owed forward: ActivityPanel's `2px` padding + single-border chrome vs
  UI-DESIGN §4's spacing scale and 3-layer anatomy (ride M3.6's UI pass);
  Hermes messages and log lines carry no `schemaVersion` because SDD §4.3/§4.4
  omit it (SDD wins by precedence; contradiction now recorded); the Activity
  tab's 300-row window and `EventLog.read()`'s full-file re-parse are fine at
  M2 scale but will meet SDD §11's budgets at 30-agent scale (M5 org-layer
  territory).

## M3 — Artemis + the Watch

Plan drafted 2026-08-27 at M2 close (derived per BUILD-PROMPT §5 from
IMPLEMENTATION M3 + ADR-0005/0010/0011 + SDD §1.1/§4/§7.1/§9 + TEST-STRATEGY §3).
Execute in order; every package tests against the fake engine per-PR.

**Architect decisions folded into this plan (2026-08-27, recorded in
DECISIONS-LOG):** the M2.7 mailbox permission grant is RATIFIED as-is as a
permission default · S-GATE's voice/remote clauses are built as *policy seams*
in M3 — source-channel and repeat-back are first-class gate-policy inputs
tested with scripted stubs (fake STT transcript, fake remote channel); the real
Herald/Harbor adapters plug into the same seam in M6/M7 · FR-5.4
respawn-with-memory means **engine-native resume** in M3 (adapter
`ResumeSupport` + recorded session id + re-injected identity/roster; Library-
backed `memory.md` continuity is M4's) · telemetry is span *capture* only (the
breaker needs the data; the waterfall UI comes later) · sheet-based floor
rendering + the owed badge double-encoding ride the M3 floor-layout package.

**Carried in from M1/M2 (each closes inside a package below):** the engine's
Notification-hook/permission-dialog invisibility (M1 → gate choke point,
M3.3) · `pendingTasksFor` always 0 (closed M3.8) · breaker pathology signal
emitted but unconsumed (→ M3.5) · every seat `terrace` (closed M3.6) ·
`agora/human/` queue with no UI (→ M3.4) · claude adapter's missing optional
`resume` (closed M3.7) · badge color-only pairs and tilesheet rendering (closed M3.6).

- [x] **M3.1 Secret broker + redaction filter** — write-only broker in main
      (`secrets:` IPC per SDD §5: `set/status/test/delete` — no call returns a
      value, asserted by API-surface test); storage via Electron `safeStorage`
      (OS-keychain-backed encrypted file — matches ADR-0010's fallback wording,
      zero new dependencies) behind an injected cipher seam so tests never
      import the native path; env injection at spawn scoped to the role's
      declared `envGrants` (registry §4.1) — undeclared vars never reach a
      spawn; redaction filter in `pty.ts` masks known secret values in outbound
      streams with the visible `•••eph-masked•••` marker (ADR-0010).
      *Docs: ADR-0010, FR-11.4, SDD §1.1 (agents.ts/pty.ts), NFR-8. Tests:
      API-surface (no read IPC exists), grant scoping least-privilege, redaction
      masks a planted token in a PTY stream, masks marked visibly. Risk:
      secret-shaped strings in fixtures (invariant §6) — fixture values must be
      scanner-neutral like M1's.*
      *Evidence: `typecheck && lint && invariants && test` green — 633 passed / 2
      skipped (38 new: redaction as a pure stream transform, broker lifecycle on
      real fs, grant scoping at the lifecycle boundary, payload validators).
      **Write-only is asserted, not asserted-about**: the API-surface test pins the
      `secrets:` channel set to exactly `set/status/test/delete/list/health` and
      fails if a `get`/`read`/`reveal`/`value`/`show` channel is ever added, and a
      second test calls *every* public broker method with a planted value in the
      store and asserts no return value contains it under `JSON.stringify`.
      Least-privilege is structural: the manager asks the broker only for what the
      hire declared, and re-scopes the answer to those names — a test that fed it an
      over-answering resolver (returning `VOICE_KEY_FAKE` alongside the declared
      `GH_TOKEN`) caught the gap and named the fix.
      LIVE RUN under real Electron (xvfb) against a **real OS keychain**
      (`safeStorage`, backend `gnome_libsecret`), a **real node-pty process** and the
      real filter:
      `cipher available=true backend=safeStorage (gnome_libsecret)`
      `status={"name":"GH_TOKEN_FAKE","present":true,"lastRotated":"2026-08-27T01:01:05.487Z"}`
      `store contains plaintext? false` · `store mode=0600` ·
      `store ciphertext head=djExx26O0299XgaZATNEFTNVRFYROf9VEHvEVRzP0PSN…`
      `after restart, declared grant resolves=true` ·
      `undeclared key present in grant env? false`
      A shell script that echoed its own credential — ADR-0010's stated threat —
      produced, through the real PTY:
      `"leaking •••eph-masked••• now\nsplit:•••eph-masked•••\nordinary line, no credential\n"`
      The second line is the credential **torn across two PTY reads 0.4 s apart** and
      still caught; the third proves ordinary output is untouched and undelayed.
      **The degraded path is real, not theoretical**: the same box before the keyring
      was installed reported `safeStorage.isEncryptionAvailable=false`, and the broker
      refused — `no OS encryption backend available — refusing to store a credential
      in plaintext`, `health.available=false`, and **no store file was created**.
      ENGINEERING-STANDARDS §5's two documented-but-unenforced tripwires now run in
      `check-invariants.cjs` (which also scans `test/` from this package on, for the
      SECRET rules only): a credential read from `process.env` outside
      `src/main/watch/`|`herald/`, and a secret-shaped string anywhere. Both proven to
      bite on planted probes, and the git tripwire proven NOT to fire in `test/`.
      **Design-conformance review at package close found ten issues; all ten are
      fixed here** (final gate: typecheck PASS · lint PASS · invariants PASS ·
      tests 644 passed / 2 skipped): the `secrets:` group is back to exactly SDD §5's
      four channels (`list`/`health` had no consumer and widening a documented IPC
      signature is a §8 must-ask, so the API-surface test now pins the documented set)
      · the no-keychain refusal is *reported* through the existing degradation surface
      at construction, not left in a `health()` field nobody reads — the same defect
      the M2 close-out audit already ruled on · the broker memoizes decrypted values
      (the filter ran a decrypt per PTY chunk per agent; a test now counts one decrypt
      across 50 chunks) · grants resolve in `start()` rather than before the version
      probe, so a credential stored while an install offer runs reaches the agent that
      follows it · **the stream wiring moved to `pty-stream.ts` and is now tested** —
      it was the one place redaction actually protects anything and deleting
      `filter.push` had left all 633 tests green; 4 of the 8 new tests fail on exactly
      that deletion · the tripwire widening over `test/` is scoped to the secret rules
      · `delete` now appends `secret-rotated {removed:true}` and the `spawn` entry
      carries grant NAMES (ENGINEERING-STANDARDS §4) · the NFR-8 test is renamed to
      what it can prove, with real-cipher coverage carried to the live run · SDD §1.1's
      `watch/` and `pty.ts` rows updated.*
- [x] **M3.2 Cost ledger + budgets** — adapter `TranscriptReader` facts folded
      into the append-only SQLite `cost_ledger(agent, session, model, day, …)`
      (SDD §4.6) with an idempotent fold cursor; **cumulative figures computed
      only from the ledger** (invariant §11 — the restart-reset bug class is
      structurally excluded), session + cumulative side by side; per-agent
      budgets from registry `budget.dailyTokens`; pre-flight burn-rate
      projection + post-hoc enforcement; breaches → `log` kind `budget` and the
      breaker's trip-signal #4 input (consumed M3.5). `watch: budgets()` IPC.
      *Docs: ADR-0011, FR-11.2, SDD §4.6, §9. Tests: folding math pure and
      table-driven; fold-cursor idempotency (re-reading a transcript never
      double-counts); restart survival against a storage seam (S-LEDGER core);
      claude reader against fixtures. Risk: better-sqlite3 is Electron-ABI —
      ledger logic stays behind a storage interface, vitest never imports the
      native module (M0 constraint 3).*
      *Evidence: `typecheck && lint && invariants && test` green — 689 passed / 2
      skipped (45 new: folding math table-driven, fold-cursor idempotency, budget
      projection boundaries, ledger restart survival, the claude reader against
      real-format fixtures).
      LIVE RUN under real Electron (xvfb) against **real better-sqlite3** and a
      **real 315-fact Claude Code transcript** — the two things vitest cannot load:
      `real claude transcript: 315 usage facts, session 9465d79e…, model claude-opus-5`
      `run 1: rows=157 in=25617375 out=113771 session=157 budget=ok`
      `after re-reading the same transcript twice more: rows=157 (unchanged? true)`
      `run 2 (fresh process, same db): cumulative rows=157 in=25617375 out=113771`
      `cumulative SURVIVED restart? true` · `session figure reset? true`
      `after folding the full transcript post-restart: rows=315 (expected 315)`
      `no double-count across the restart? true`
      `with a 1000-token budget: state=breached because=over`
      That is **S-LEDGER's core claim proven on the real storage**: the cumulative
      figure survived a process restart, the session figure reset because the session
      genuinely ended, and the DURABLE fold cursor stopped the fresh process from
      re-counting the 157 facts it re-read. The upstream bug this closes returned zero
      on that fourth line.
      Two real breakages surfaced and were fixed rather than worked around: adding
      `budgetSchema` to `agents.ts` created an **import cycle** with `registry.ts` that
      broke zod initialization across 15 suites (the schema now lives in `agents.ts`,
      the direction `registry.ts` already imports); and the **conformance suite
      hardcoded the fake engine's transcript format for every adapter** — it would have
      demanded that Claude Code parse the fake's JSON, a conformance failure invented
      by the test (NFR-12). Each subject now supplies a sample in its own format and
      the suite asserts the *behaviour* ADR-0009 actually specifies: a missing file
      yields nothing, junk yields nothing, and a good line yields exactly what it said.
      **Design-conformance review at package close found thirteen issues; the twelve
      code findings are fixed in `fix/m3-2-ledger-attribution`, the thirteenth is a
      plan gap now assigned to M3.4** (final gate: typecheck PASS · lint PASS ·
      invariants PASS · tests 778 passed / 2 skipped). The three that mattered:
      (1) **spend landed on the wrong agent** — transcripts are keyed on `cwd`, and
      FR-1.5 makes worktree isolation optional, so two agents in one repo (and the
      Architect's own `claude` history there) all folded into whoever ticked first.
      Folding is now restricted to the session ids the event plane recorded, and the
      fold cursor is keyed `(agent, source)` instead of `source`. An empty session
      list folds nothing: recording nothing until we know whose it is beats recording
      it as ours. (2) **`day` was the day of FOLDING, not of spend** — the ledger's
      `day` IS the budget window, so an agent in a previously-used repo breached on
      its first tick from history alone, and one running across midnight billed
      pre-midnight spend to tomorrow. `UsageFact` now carries the engine's timestamp
      (ADR-0009 names the member, not the fact shape, so §8.2 not §8.3).
      (3) **the burn-rate projection divided a whole day's durable spend by this
      process's uptime** — after a restart a healthy agent projected straight into
      `projected-breach`, the false trip the 5-minute floor was supposed to prevent;
      the floor could not help, because the origin was wrong, not the sample size.
      The window now carries its own baseline.
      Also fixed: the last fold before exit (every session's tail was lost); budgets
      read from the registry, not from whatever the untrusted renderer supplied;
      `reporting: 'engine' | 'none'` so a zero from an engine that cannot report is
      distinguishable from an agent that spent nothing; async transcript IO off the
      event loop that carries PTY bytes; a tripwire for `UPDATE`/`DELETE FROM
      cost_ledger` (the ledger is a SQL table now, so `writeFileSync` patterns cannot
      see its rewrite vector — proven to bite on both); read-side row validation;
      exited agents included in `watch:budgets()` (their cumulative figure is what the
      ledger exists to preserve); the phantom `COST_SCHEMA_VERSION` removed, and
      **`src/main/watch/budgets.ts`, which had no tests at all, now has 17**.
      LIVE RE-RUN on real better-sqlite3 and a real 415-fact transcript, proving the
      two headline fixes: `facts carry engine timestamps? 415/415` ·
      `folded a week later: rows land on day(s) ["2026-08-27"], folding day is
      2026-09-03` · `billed to the day of SPEND, not of folding? true` · the folding
      day's budget is `"ok"` · `agent.mason rows=415 agent.other rows=415 (same
      transcript, both complete)` — two agents over one transcript, neither starving
      the other.*
- [x] **M3.3 Gate core — deny-by-default + the three choke points** —
      `watch/gates.ts` + pure policy matcher in `src/shared/`: deny-by-default
      evaluation; profile autonomy can only *loosen* up to global maxima
      (stricter wins, ADR-0012); gate packaging schema (what/why/blast
      radius/rollback, schemaVersion + validator); the three SDD §9 choke
      points: (1) engine tool-permission prompts — wire the claude adapter's
      `Notification` hook so a native permission dialog becomes a visible gate
      instead of an invisible stall (**closes the M1 carried item**), (2)
      Hermes `needs_human`, (3) harness-mediated actions (spend). Gate open /
      verdict → `log` kind `gate`; open gates block `status→done` (the §4.2
      guard shaped in M2.2 becomes live). Source-channel + repeat-back enter
      the policy as first-class inputs (Architect decision — scripted stubs).
      *Docs: SDD §9, FR-11.1, ADR-0011/0012, UC-08. Tests: policy matcher
      table-driven incl. stricter-wins composition; gate lifecycle integration
      with the fake engine; Notification-hook mapping. Risk: policy config
      shape is minimally specified — smallest shape that serves UC-08, logged
      in DECISIONS-LOG, no invented policy language.*
      *Evidence: `typecheck && lint && invariants && test` green — 754 passed / 2
      skipped (64 new). Deny-by-default is asserted **exhaustively, not by example**:
      a table over every `GATE_KIND` holds each one under the default policy and
      again under a policy that permits a different class. Stricter-wins is asserted
      over the full 3×3 autonomy cross-product against `Math.min` — the property,
      not three cases.
      **S-GATE lands early, as a real suite** (`test/scenarios/s-gate.test.ts`, 11
      cases on the M2 rig: real spawned `fake-engine` processes, a real socket, real
      git). All three of TEST-STRATEGY §3's clauses pass: destructive op
      deny-by-default; the remote path is held unless the policy names the channel
      and the verdict is tagged `remote`; a voice approval is refused until repeat-back
      — and refusing is *not* denying, so the gate stays open (scripted-STT stub at
      the policy seam, per the Architect decision; the Herald plugs in here in M6).
      **All three SDD §9 choke points are wired and proven** (choke point 3's proof
      landed with the review fixes below, not in the package commit). (1) The engine's
      `Notification` hook is mapped — a real fake-engine process emitting it opens a
      packaged gate, **closing the M1 carried item** where an agent stalled behind a
      permission dialog was invisible to the harness. (2) A real `needs_human` message
      is delivered *and* gated — escalation never swallows mail (FR-3.3). (3) A budget
      breach files a `spend` gate.
      The avatar's `gate-opened`/`gate-verdict` edges (implemented in M1, unreachable
      until now) are driven, and only the LAST gate on an agent walks it back to its
      desk. **`task.gates` is NOT yet populated** — the first draft of this entry
      claimed it was, and review found no production call site that passes a `taskId`,
      because no task assignment flow exists before M3.8. The M2.2 `status→done` guard
      is still unfed; **M3.8 feeds it**, where tasks become real.
      LIVE RUN under real Electron (xvfb) against a real harness home and real Agora:
      `no policy file: autonomy=manual rules=0` — an unconfigured Ephesus holds
      everything · `corrupt policy: autonomy=manual rules=0 warning="gate-policy.json
      unreadable, holding everything: …"` — **a policy the harness cannot read never
      becomes a policy that permits** · `policy permits spend only; destructive op:
      held=true because=no-rule` · `profile asks autonomous under a supervised global:
      held=true because=autonomy` · `notification hook → gate: held=true what="Claude
      needs permission to use Bash"`. The chain read back out of `log.jsonl` alone
      (NFR-13): `seq=4 opened kind=tool-permission` → `seq=5 approved`.
      **Design-conformance review at package close found seventeen issues; all
      seventeen are fixed in `fix/m3-3-gate-policy`** (final gate: typecheck PASS ·
      lint PASS · invariants PASS · tests 832 passed / 2 skipped). Five were serious:
      (1) **NFR-9 bound on nothing.** `requiresRepeatBack` was read off the *hold
      reason*, which under deny-by-default is almost always `no-rule` — so the flag was
      false on exactly the destructive ops the clause protects, and `decide()` never
      consulted `rule.channels` at all. A voice approval with no repeat-back, and a
      remote approval of a gate the policy never opened to remote, both sailed through
      — and S-GATE asserted the second as *correct*. NFR-9 constrains the approval
      side; `checkVerdictChannel` now polices it, `repeatBackRequired` derives from the
      gate's own facts, and destructive ops always require repeat-back by voice.
      (2) **A rule at `autonomy: 'manual'` permitted.** The file's own contract says a
      manual rule permits nothing, and the rank comparison let `manual === manual` fall
      through to allow — so ADR-0012's tightening had no floor.
      (3) **`task.gates` was never populated** though the entry above claimed it was;
      corrected, and assigned to M3.8.
      (4) **Invariant §8 was violated by the very commit that claimed to satisfy it:**
      the three `prompts/watch/*.md` files were added and never loaded, while the
      packaging prose sat inline in `.ts`. The packaging now renders from
      `prompts/watch/packaging-*.md` through a `field: value` template.
      (5) **The scenario rig re-implemented the production wiring** character-for-
      character, so S-GATE stayed green with the production choke points deleted — the
      same defect class the M3.1 review caught. `wireGateChokePoints` is now the single
      implementation both `index.ts` and the rig call; **disabling it fails 6 tests
      across both suites, verified by planting exactly that defect.**
      Also fixed: `tool-permission` is never permittable (a policy that "allowed" it
      would silently restore the invisible stall the M1 carried item was about — there
      is no harness action to permit); repeated notifications coalesce per
      (agent, kind) instead of burying the queue; gate ids carry 64 bits of suffix, not
      16 (a shared clock gave ~0.3% collision odds across twenty, and a collision
      silently overwrote a still-open gate); duplicate rules for one kind are refused
      by the schema *and* resolved strictest-first by the matcher; the spend cap is
      named `maxSpendTokens` because the ledger reports tokens and a cents field was
      being compared against a token count; `gate:open` carries the id rather than the
      whole gate, matching its own documented contract; the policy warning reports on
      *change* rather than on every evaluation, which was evicting every other entry
      from the bounded health buffer; `gate-policy.json` is documented in SDD §2; and
      `loadGatePolicy`, which carried the headline safety claim on a manual run alone,
      now has five tests.*
- [x] **M3.4 Approvals UI + the human queue (+ the FR-11.2 spend strip)** — the Watch approvals surface
      (UI-DESIGN §4): `watch: approvals()/approve(gateId, v)` IPC + `gate:open`
      push; renders each gate's packaging (what/why/blast radius/rollback);
      the M2 `agora/human/` diverted-mail queue surfaces in the same view
      (**closes the M2 carried item** — no more invisible mail); avatar
      `blocked` (wave at Watch post) on gate-open, prior state restored on
      verdict (SDD §6 edge already implemented and regression-tested in M1).
      **Plan amendment (2026-08-27, from the M3.2 review):** FR-11.2's clause
      "the UI SHALL show session and cumulative figures separately" and
      ADR-0011's "always shows session and cumulative side by side" had **no
      owner in the M3 plan** — `watch: budgets()` shipped in M3.2 with no
      consumer, and M3.8's "Ledger tab" is the task kanban (FR-4.3), not cost.
      It lands here: the Watch panel is the Watch's surface, and a budgets strip
      beside the approvals queue is the documented reading of both sources. No
      new UI is invented — the two figures the requirement names, nothing more.
      *Docs: SDD §5, §6, UI-DESIGN §4, FR-11.2. Tests: renderer stays a projection
      (approve round-trip validated in main; no gate state held renderer-side);
      queue drains visibly; both spend figures render from the ledger. Risk:
      inventing UI beyond the spec — the surface is the documented approvals
      queue plus the two figures FR-11.2 names.*
      *Evidence: `typecheck && lint && invariants && test` green — 794 passed / 2
      skipped (16 new: the `watch:approve` validator, main-is-the-authority cases,
      and the human queue on real files).
      LIVE RUN of the REAL app under xvfb — a real `claude` **2.1.247** spawned
      through the real IPC, and the whole UC-08 chain driven end to end with nothing
      reconstructed:
      `env the harness injected: EPH_AGENT_ID EPH_HOOK_ENDPOINT EPH_HOOK_TOKEN` ·
      `harness-wired Notification command: node "<repo>/shims/eph-hook.mjs" --event
      notification --session-field session_id` — **the M1 carried item, visible in the
      agent's own settings file**. That exact command was then executed verbatim, with
      the live agent's own environment read from its process, and the gate arrived:
      `what: Claude needs your permission to run: rm -rf /var/lib/production-data` ·
      `why: the engine asked for permission and will not proceed without an answer` ·
      `blast radius: whatever the engine was about to do; it has not done it yet` ·
      `rollback: denying the gate leaves the action unperformed` ·
      `held: kind=tool-permission because=no-rule channel=local` ·
      `avatar: phase=blocked station=watch-post` — the SDD §6 edge, reachable in the
      running app for the first time. **APPROVE was then clicked in the real UI**:
      `approvals now: 0` · `avatar after verdict: phase=idle` ·
      `log seq=2 gate opened kind=tool-permission` / `log seq=3 gate approved`.
      An earlier attempt posted the same hook with no token and got
      `delivered=false status=400` — per-spawn token validation, incidentally proven.
      Screenshot: [`docs/demo/m3-uc08-gate.png`](./demo/m3-uc08-gate.png) — the
      approvals post with all four packaging fields *above* the controls (UI-DESIGN
      §4), the spend table with session and cumulative side by side (FR-11.2), the
      Architect's diverted-mail queue (**closing the M2 carried item** — mail
      addressed to the human that the human could not see), the status strip reading
      `⚠ gates: 1 waiting on you`, and a real `claude` TUI live in the panel beside it.
      **Owed forward, stated rather than implied:** the panel's *rendering* is asserted
      by that screenshot, not by an automated test — there is no Playwright harness in
      the repo yet, and adding one is a dependency decision. What IS automated is the
      property that matters: main is the authority (a stale gate id, a second verdict,
      a malformed payload are each refused) and the queue reads and drains on real
      files. Carried to M3.9's S-GATE/E2E work.
      **Design-conformance review at package close found thirteen issues; all thirteen
      are fixed in `fix/m3-4-watch-panel`** (final gate: typecheck PASS · lint PASS ·
      invariants PASS · tests 958 passed / 2 skipped). The one that mattered:
      **the untrusted renderer was writing the verdict's provenance into the
      append-only log.** `watch:approve` accepted a `context` naming the channel and
      the repeat-back flag, and `GateManager.decide` wrote both into the `gate` entry —
      so a buggy or compromised renderer could stamp "approved by voice, repeat-back
      confirmed" onto the record of a destructive act the Architect merely clicked.
      Main knows a verdict through the window bridge is `local`; it now stamps it, and
      the payload carries no channel at all. Voice and remote verdicts arrive on the
      Herald (M6) and Harbor (M7) paths *inside* main, which know their own channel
      because they are it.
      Also fixed: **the token contrast test UI-DESIGN §8 has promised since M0 now
      exists** — nothing had ever checked it, and writing it immediately caught
      `ink-500` on `marble-100` at 4.49:1 (a hair under AA) and disproved a blanket
      claim I had put in the test's own first draft (`status-thinking` is 5.2:1);
      status colours are now pinned as sub-AA reinforcements with the WORD in
      `ink-900`, `because` is visible text rather than a hover-only `title`, and the
      test keeps `tokens.ts` and `tokens.css` in lockstep, which their own header asks
      for and nothing verified · the panel gained UI-DESIGN §4's full anatomy (3-layer
      border, title tab, offset shadow) and explicit `fontWeight: normal`, since only
      Regular faces are bundled · APPROVE and DENY carry `laurel`/`wine` borders, the
      two tokens §2.3 names for exactly this pair, so the irreversible control no
      longer looks identical to the safe one, with the letters staying `ink-900` ·
      every control and card is named for a screen reader · a failing
      `watch:approvals` read renders `⚠ gates: unavailable` instead of continuing to
      show "none open" in success green — a degradation failing as *good news*, the
      one direction invariant §7 does not allow · concurrent refreshes apply
      newest-only · **`watch:dismiss` makes the queue genuinely drainable**: the owed
      "queue drains visibly" test had performed the drain itself with `fs.rmSync`,
      proving a property the product did not have. It archives into `inbox/.done/` by
      atomic rename, the same act `consumeInbox` performs for an agent, so the mail
      survives as evidence. **And a test that exercises main's registered handlers,
      not just its schemas**: removing the `parse` from `watch:approve` had left every
      test green — the third time this repo has recorded that defect class; six tests
      now fail on it.
      The screenshot is re-captured: the earlier one was taken with all three pixel
      faces missing (the `file://` font bug fixed in M3.5), so it could not have
      supported any claim about typography.*
- [x] **M3.5 Circuit-breaker ladder + span capture** — `watch/breaker.ts` per
      ADR-0011: tool-call spans (agent, tool, duration, outcome) recorded from
      hook events (the span model FR-11.6 needs later; no waterfall UI yet —
      Architect decision); trip signals as pure functions in `src/shared/`:
      repeated near-identical tool calls in a window, error-rate threshold,
      recurring hop-cap escalations on one conversation, burn-rate projection
      (from M3.2); the ladder: **steer** (corrective prompt through the command
      queue — FR-1.3 applies; avatar `looping`) → **constrain** (pause Hermes
      deliveries, lower remaining budget, read-only tools where the engine
      supports it) → **stop** (graceful interrupt then stop; task `stalled`
      with breaker report; reassignment is Artemis's, M3.8). Consumes M2.5's
      pathology signal (**closes the M2 carried item**); every trip and rung
      transition → `log` kind `breaker`; reduced protection on `pty-heuristic`
      engines surfaces on the agent card (ADR-0011 consequence).
      *Docs: ADR-0011, FR-11.3, SDD §6 (looping), §9. Tests: signal functions
      table-driven on scripted fixtures (repetition, error storm, burn rate);
      ladder integration with the fake engine — work preserved at rungs 1–2
      (S-BREAKER core). Risk: false trips — rung 1 must stay cheap (one
      injected sentence), never destructive.*
      *Evidence: `typecheck && lint && invariants && test` green — 915 passed / 2
      skipped (68 new). The ladder's two load-bearing properties are asserted
      exhaustively: it **never skips a rung** (the full 0→1→2→3 table, plus a
      dedicated "cannot reach stop on a first trip however bad the signals"), and a
      quiet agent **falls straight back to 0** rather than serving out a sentence.
      **S-BREAKER lands as a real suite** (`test/scenarios/s-breaker.test.ts`, 9 cases
      on the M2 rig): real spawned `fake-engine` processes emitting real hook events
      over a real socket, through the same span-capture wiring `index.ts` uses.
      **Work is preserved at rungs 1 and 2** — the scenario asserts that mail to a
      constrained agent is HELD in its sender's outbox and *arrives when the
      constraint lifts*, because constraining an agent is not the same as losing its
      mail. Only the third step interrupts, and it interrupts gracefully before the
      stop.
      A **rung-dwell** was added after the scenario caught a design flaw: evaluating
      on every span close meant an error storm reached `stop` three tool calls after
      the floor, and the steer — queued until idle (FR-1.3) — may not even have been
      delivered. A ladder that climbs three rungs in three seconds is a kill switch
      with extra steps. Recovery is never delayed by the dwell.
      **The M2 carried item is closed**: ADR-0013's pathology signal, emitted and
      logged from M2 with nothing reading it, now enters the ladder at rung 1.
      LIVE RUN of the REAL app with a real `claude` 2.1.247: the harness's own
      `PreToolUse`/`PostToolUse` hook commands were executed verbatim with the live
      agent's own environment, five times on the same file —
      `breaker: rung=1 firing=["repetition"] spans=5` · `avatar: looping` ·
      `steer queued for the agent: "You appear to be looping: the harness has seen the
      same Read call 5 times…"` — a real sentence rendered from
      `prompts/watch/steer-repetition.md`, queued through the command queue like any
      other prompt. Eight reads of eight DIFFERENT files then left it at rung 1:
      **the breaker does not climb on ordinary work.**
      Screenshot: [`docs/demo/m3-breaker-rung1.png`](./demo/m3-breaker-rung1.png).
      **A real production bug surfaced from that screenshot and was fixed here**: the
      packaged app loads its renderer over `file://`, where the absolute
      `/fonts/*.woff2` path resolves to the filesystem root — so the built app had
      **never** loaded a bundled pixel face and showed "3 of 3 pixel faces missing"
      permanently, while the dev server's http origin made it look fine. A warning
      that is always on trains the Architect to ignore the surface every other
      degradation shares, which is the real damage. Relative paths fix it
      (`document.fonts.size: 3`, strip now reads `● fonts: bundled`), with a
      regression test that resolves both a `file://` and an `http://` base.
      **Owed forward:** S-BREAKER's "ledger `stalled`" clause needs Artemis's
      reassignment (M3.8) and its "brief mentions trip" clause needs the Odeon (M5);
      both are named in the suite rather than faked.*
- [x] **M3.6 Floor layout v2 — seats, temple, sheet rendering** — the floor
      layout: real seat assignment (terrace numbering per UI-DESIGN §5 —
      retires the every-hire-is-`terrace` placeholder, **closes the M2 carried
      item**), Artemis's reserved temple seat/room; rooms render from the
      installed tileset sheets (Kenney CC0 staged since M1; procedural stays
      as the visible no-sheet fallback — Architect decision) · the owed §8
      badge double-encoding (glyph/label beside color for `idle`↔`waiting`,
      `alert`↔`thinking`) lands here, since gates/breaker make `waiting`,
      `blocked` and `looping` reachable for the first time.
      *Docs: UI-DESIGN §5–§8, SDD §6 stations, ADR-0014. Tests: seat
      assignment pure + deterministic; scene-state assertions (state model is
      truth, art is presentation); token/contrast checks stay green; badge
      encodings asserted distinct without color. Risk: art must not change the
      state model — snapshots of scene state, not pixels.*
      *Evidence: `typecheck && lint && invariants && test` green — 1066 passed / 2
      skipped (108 new). **The M2 carried item is closed**: `src/shared/seats.ts`
      assigns `temple` or `terrace-<n>` as a pure function of the seats already
      taken — no clock, no randomness, and no dependence on the order the roster is
      read in. An agent **keeps** its seat (a respawn, a status mirror, a restart
      replaying the roster), a vacated number is reused, and a seat that does not
      parse — which is what every M1/M2 roster holds — is reassigned rather than
      rejected, so no old roster becomes unreadable. Planting the old `seat:
      'terrace'` back into `AgentManager` fails 8 tests in
      `test/main/seating.test.ts`; before this package it failed none.
      **The temple is reserved by the rule, not by everyone else's good behaviour**:
      the orchestrator gets it however full the terraces are, a roster that seated
      her elsewhere is corrected, and a worker holding `temple` is turned out of it.
      **`floorPlan()` makes the floor's layout state**: typed cells with no colour,
      no texture and no sheet in them. That is the seam ADR-0014 asks for — UI-DESIGN
      §7's licensed tileset is exactly the thing that could quietly make art the
      model (a station existing because a tile was drawn there), and with the plan in
      front, a pack paints it and cannot change it. A pack ships its own
      `*.tiles.json` map (validated in `src/shared/tileset.ts`, `station:<name>`
      overriding `station`, `tilePx` required to divide the 32px world tile per §7's
      integer-scale rule); an unmapped cell falls back to the procedural tile, so a
      partial pack cannot punch holes in the floor. A sheet with no map, an invalid
      map, or a map naming a missing sheet each leave the floor procedural **and say
      which** — a tileset that quietly failed to load would look exactly like one
      nobody had installed yet.
      **Badges are double-encoded (§8)**: a 3×5 glyph beside the colour, distinct for
      every phase — asserted the way a reader without colour sees the floor, using
      the palette *only* to find the three pairs that collide (`alert`/`thinking`,
      `ghost`/`archived`, `blocked`/`stopped`) and never to tell them apart. The
      canvas also carries a census in words, because a `<canvas>` is opaque to a
      screen reader and §8's double encoding would otherwise stop at the glyph.
      LIVE RUN of the REAL app with four real `claude` 2.1.247 agents hired through
      the real IPC, driven by the harness's own hook endpoint with tokens read from
      each live agent's own `/proc/<pid>/environ`:
      `card.seat = temple · terrace-1 · terrace-2 · terrace-3`, matched by
      `registry.json` (`agent.artemis … isOrchestrator=true`), all distinct;
      four phases on the floor at once —
      `agent.mason: blocked at watch-post` (a real `notification` hook opened a real
      gate), `agent.scribe: looping` (seven repeats tripped the real breaker to rung
      1), `agent.runner: alert`, `agent.artemis: idle` — and
      `aria-label: "Terraces floor: 4 on the terraces — 1 idle, 1 alert, 1 blocked at
      a gate, 1 breaker tripped"`.
      Screenshot: [`docs/demo/m3-floor-seats.png`](./demo/m3-floor-seats.png) — the
      shipped procedural floor, Artemis in the marble temple precinct in her reserved
      terracotta, Mason at the Watch post under an `X` badge, the looping scribe under
      a ring and the alert runner under a `!`.
      **The sheet path was then proven by installing a pack**, not by reasoning about
      it: a synthetic 16×16 fixture pack (deliberately loud, not shipped — the drop is
      gitignored) went into the drop, and the same run painted walls, paths, the
      temple, desks, floor and stations from the sheet, with `station:odeon` picking
      up its own frame while every other station used the generic one, and the strip
      crediting the pack by name.
      Screenshot: [`docs/demo/m3-floor-tileset.png`](./demo/m3-floor-tileset.png).
      **Art did not change the state model**: the two runs produced identical seats,
      identical phases and an identical census — which is the ADR-0014 property,
      observed rather than asserted.
      **A real production bug surfaced from that install and was fixed here**: the
      sheet was loaded through Pixi's asset resolver, which picks a parser from the
      URL's *extension* — and the bundler inlines a small sheet as a `data:` URL,
      which has none. The installed pack fell back to procedural with a loader error.
      It is now decoded through the DOM (`Image.decode()`) with
      `scaleMode: 'nearest'`, since §7's integer upscale is only integer if nothing
      interpolates it.
      **Owed forward:** the floor's *rendering* stays E2E territory (this repo has no
      DOM test project), so what pins the wiring is the live run above — the same
      standing exception recorded for the approvals panel in M3.4. Contrast/token
      checks stayed green untouched.*
- [x] **M3.7 Artemis lifecycle** — `artemis.ts`: auto-spawn at startup into
      the temple seat, `isOrchestrator` + `orchestratorId` per SDD §4.1;
      prompt/config assembly from `prompts/artemis/` (system prompt carries the
      escalation policy; editable — prompt text is config, invariant §8);
      delegated-authority table as a validated config file (FR-5.5 —
      countersign surface lands with the Odeon, but the table and its
      enforcement hooks are M3's); respawn on crash via adapter `ResumeSupport`
      — wire claude's `--resume` with the session id the event plane already
      records (**closes the M1-audit resume gap**; Architect decision:
      engine-native resume + re-injected identity/roster IS M3's
      respawn-with-memory; `memory.md` continuity is M4's).
      *Docs: ADR-0005, FR-5.1–5.5, SDD §1.1 artemis.ts, §4.1. Tests: lifecycle
      with the fake engine — auto-spawn, crash → respawn carries resume args +
      identity; authority-table validator; prompt assembly snapshot. Risk:
      FR-5.1 — Artemis is an ordinary engine process holding a privileged
      *role*, not privileged code; resist rules-engine creep into main.*
      *Evidence: `typecheck && lint && invariants && test` green — 1136 passed / 2
      skipped (70 new). **`artemis.ts` holds lifecycle and nothing else** — hire,
      seat, policy text, respawn, and one question ("may she settle this?") answered
      from a table the Architect wrote. FR-5.1 is asserted directly: a test grants
      every class and shows the harness allows every one of them, because it has no
      opinion of its own to override the Architect's with; with the table silent it
      refuses even the requests that "look routine", since the notion of routine is
      hers and lives in `prompts/artemis/system.md`.
      Her system prompt reaches her through a **general `roleBrief` seam** on
      `AgentManager` rather than a special case — the manager renders the identity,
      appends what the hirer supplied, and writes the file without reading it. An
      edit in the harness home wins over the bundled copy, which is what "editable
      from the UI" means on disk, and a policy file that will not read is a reported
      degradation rather than an orchestrator quietly running with no policy.
      **The M1-audit resume gap is closed**: `claude --resume <sessionId>`, with the
      id coming off the event plane exactly as `ResumeSupport`'s contract always
      said. A respawn mints a **fresh hook token** (a token that outlived its
      process would let a dead agent keep writing the event plane), re-injects
      identity and protocol, and logs whether memory actually carried over — an
      engine with no resume still respawns, with a fresh session, and says so.
      **A design flaw was found by a test, not by review**: the first draft reset the
      respawn ladder whenever the agent reached `running`, so the ladder could never
      be spent by the one failure it exists to bound — a process that starts and
      immediately dies would be respawned forever. A 60 s **stability window** fixes
      it: recovery is coming back and *staying* back. Giving up is loud — a
      degradation, a log line, and `orchestratorId` cleared rather than left naming a
      dead agent.
      **The authority table (FR-5.5)** lives at `<home>/authority.json` beside
      `gate-policy.json`, with the same posture: absent or unreadable ⇒ nothing
      delegated, everything escalates. It is re-read per decision (the Architect
      edits it while the company runs) and its parse failure is reported once per
      distinct reason. The permission and the countersignature are the **same call**,
      so no path takes a decision under delegated authority without leaving something
      to audit. A grant with no domains is a parse error rather than "all domains",
      and a spend grant is refused without a ceiling — by the schema, and again by
      `mayDecide` if one is constructed anyway.
      LIVE RUN of the REAL app, nobody asking for her:
      `auto-spawned without being asked: true` ·
      `card: agent.artemis role=orchestrator seat=temple engine=claude v2.1.247` ·
      `registry.orchestratorId = agent.artemis`, `isOrchestrator=true`,
      `budget={"dailyTokens":2000000}` · `envGrants: []` (ADR-0010: orchestration is
      routing and text) · `identity.md carries prompts/artemis/system.md: true`.
      Then her REAL `claude` process was killed by pid, after a hook carrying a
      session id was posted through the real endpoint with the token read from that
      process's own `/proc/<pid>/environ`:
      `respawned: true (new pid 29630, was 29591)` ·
      `respawn argv carries --resume: true (session sess-temple-live-1)` · and the
      chain in `log.jsonl`: `orchestrator/spawned` →
      `orchestrator/respawn-scheduled attempt=1 waitMs=1000` →
      `spawn respawn=true resumed=true sessionId=sess-temple-live-1` →
      `orchestrator/respawned attempt=1`.
      Screenshot: [`docs/demo/m3-artemis-temple.png`](./demo/m3-artemis-temple.png).
      **Owed forward:** `mayDecide` has no production caller yet — M3.8's routing is
      the first, and the countersign *surface* (filing into the memo/gate archive) is
      the Odeon's (M5). Recorded rather than hidden, on the same footing as M3.5's
      `forceEvaluate`.*
- [x] **M3.8 Task assignment + Artemis routing + Ledger tab** — SDD §7.1: the
      ledger endpoint (Artemis files `propose` acts from its own outbox; the
      harness validates and writes `tasks.json` through the single committer —
      agents never touch the ledger file); assignment `request`s with
      self-contained specs; `pendingTasksFor` becomes real (**closes the M2
      carried item** — the ADR-0013 branch now fires on tasks, not mail alone);
      Hermes re-targets `to:"human"` and hop-cap diversions from the
      `agora/human/` constant to Artemis-as-proxy (FR-3.7/ADR-0005), with only
      critical-policy items continuing to the Architect's queue; `needs_human`
      flip honored by Artemis; `board.md` scribing (Artemis sole scribe,
      enforced) + `agora: board()` IPC; the Kanban Ledger tab (FR-4.3) +
      `state:tasks` push.
      *Docs: SDD §7.1, §4.2, §5, FR-5.2, FR-4.3, ADR-0005. Tests: ledger
      endpoint refuses non-Artemis writers and invalid transitions; assignment
      flow with two fakes; single-scribe enforcement; kanban stays a
      projection. Risk: mechanism/intelligence split — main validates and
      executes, Artemis decides; no orchestration decision hardcoded in main.*
      *Evidence: `typecheck && lint && invariants && test` green — 1207 passed / 2
      skipped (71 new). **The split holds**: `src/shared/ledger.ts` decides only
      whether a proposal is well-formed and legal against the ledger as it stands —
      nothing in main has an opinion about what a good decomposition looks like, who
      should get a task, or when one is finished. A proposal applies **whole or not
      at all**, with every reason returned at once, so Artemis can fix it in one pass.
      **Agents never touch `tasks.json`**: the writer check lives in `routeMessage`,
      because ADR-0003 calls the addressing rules transport rules — so it guards the
      only way in, and the endpoint is reached having already established that the
      orchestrator sent it. Planting the removal of that check fails 3 tests across
      two suites; removing the endpoint call in Hermes fails 10.
      **`board.md` travels through the same endpoint**, which is what makes FR-4.2's
      "single scribe = Artemis" enforceable rather than a comment on a file anyone
      could write.
      **The M2 carried item is closed**: `pendingTasksFor` counts `todo` and
      `in_progress` work assigned to an agent, so ADR-0013's branch now fires on
      tasks, not mail alone. `blocked` and `stalled` deliberately do not count — an
      agent that cannot proceed should stop, not be told to continue.
      **`task.gates` is written for the first time** (carried from the M3.3 review):
      the Watch records an open gate against its task and clears it on verdict, so
      SDD §4.2's "refuse `→ done` while a gate is open" finally guards a field
      something fills.
      **A gap the M2 close-out recorded is closed**: the router-authored bounce said
      `from: <the original sender>` — a message the sender never wrote, attributed to
      them — because §4.4 gave the harness no legal identity. Reserved agent ids
      (`agent.hermes`, `agent.ledger`) give it one with no schema change, and
      `spawnRequestSchema` refuses them so no hire can forge a refusal.
      LIVE RUN of the REAL app — the UC-02 chain end to end, with Artemis
      auto-spawned as a real `claude` 2.1.247 and a real worker hired beside her:
      `ledger after her proposal: 2 task(s) — t-uc02-1:todo→agent.mason,
      t-uc02-2:todo→agent.mason` · `deps recorded: ["t-uc02-1"]` ·
      `source traced to her message (NFR-13): {"kind":"propose","via":"hermes",
      "log":"msg#…"}` · `board.md scribed: true` ·
      `the harness answered her: act=agree from=agent.ledger` ·
      `request delivered to the assignee: act=request subject="t-uc02-1: …"` ·
      `pending work for the assignee: 2` · `kanban IPC sees 2 task(s)`.
      Then both safety rules were attacked from a real worker's outbox:
      `ledger after a worker proposed: 2 task(s) (unchanged: true)` ·
      `board after a worker tried to scribe: still Artemis's (true)` ·
      `the worker got a refusal: act=refuse from=agent.hermes reason="… only the
      orchestrator may write the ledger; "agent.mason" may not"`.
      Screenshot: [`docs/demo/m3-uc02-ledger.png`](./demo/m3-uc02-ledger.png).
      **A layout bug surfaced from that screenshot and was fixed here**: the Ledger
      panel had no `minWidth: 0`, and a flex child defaults to "never shrink below my
      content" — so six kanban columns squeezed the terminal pane to a sliver and gave
      the whole window a horizontal scrollbar. The columns scroll inside the panel now.
      **Owed forward:** the endpoint's address is a reserved agent id rather than a
      `"ledger"` literal in SDD §4.4, to avoid deviating from a normative schema —
      raised in the session report for the Architect to promote if they prefer. The
      `needs_human` flip stays Artemis's to make (her policy text says when); the
      harness honours it at the M3.3 choke point already.*
- [x] **M3.9 Scenario suites + exit demos** — implement S-GATE, S-BREAKER,
      S-LEDGER, S-SECRETS (TEST-STRATEGY §3) as automated suites over the
      seams M3.1–M3.8 built (S-GATE's voice/remote clauses at the policy
      boundary with scripted stubs per the Architect decision); then the exit
      demos: **UC-02** — a real directive to Artemis fans out (decompose →
      ledger tasks → assignee `request`s → work → verify → board update) —
      and **UC-08** — a destructive op stops at a gate, packaged
      what/why/blast-radius/rollback, approved in the UI, the full chain in
      `log.jsonl`. Dogfood begins at this exit (IMPLEMENTATION M3).
      *Docs: TEST-STRATEGY §3, UC-02/UC-08. Risk: suites run per-PR against
      the fake engine; real-`claude` demos are exit-review territory.*
      *Evidence: `typecheck && lint && invariants && test` green — 1233 passed / 2
      skipped (26 new). **All four named suites are automated and run per-PR**:
      S-GATE (12 cases, M3.3 — corrected at the close-out audit) and S-BREAKER (9, M3.5) landed with their packages;
      **S-LEDGER** (13) and **S-SECRETS** (13) land here. 73 scenario cases in all.
      **S-LEDGER** folds transcripts a REAL spawned `fake-engine` wrote, in its own
      format and its own directory, read by the adapter's own `TranscriptReader` —
      the fake engine gained a `write-transcript` step so the suite proves the
      pipeline rather than the reader. The upstream regression class is pinned three
      ways: the cumulative figure survives a restart, the session figure resets
      (unless the engine resumed the same session — M3.7 made that case reachable,
      and it is asserted separately), and a **budget is enforced against the day**,
      so a crash-loop cannot spend the cap N times. One test counts store reads to
      prove the figures are re-read rather than cached — the in-memory counter is
      what actually regressed.
      **S-SECRETS** asserts the three promises separately, because they fail
      separately: every `secrets:` channel is called with a planted value in the
      store and no response anywhere contains it; two roles' grants are scoped so
      neither can see the other's, proven by a REAL agent process reporting its own
      environment; and the redaction filter masks a planted token — split across
      chunks, repeated, and stored mid-stream — while leaving ordinary output byte
      for byte. **The invariant tripwire caught the first draft** setting
      `process.env` to reach the child; grants now travel in the child's spawn
      environment, the way a spawn plan carries them.
      **The exit demos ran on the REAL app**, Artemis auto-spawned as `claude`
      2.1.247 into the temple with a real worker hired beside her.
      **UC-02** — `decompose → ledger: t-uc02-a … t-uc02-b …` ·
      `assignee request delivered: "t-uc02-a: …"` ·
      `work reported back to Artemis: act=done from=agent.mason` ·
      `verified + closed: t-uc02-a status=done resultRef=run#8842` ·
      `board updated by the one scribe` · and the chain in `log.jsonl`:
      `create:t-uc02-a → create:t-uc02-b → board → update:t-uc02-a → board`.
      **UC-08** — a real `notification` hook (token read from the live worker's own
      `/proc/<pid>/environ`) held a destructive op at a gate carrying all four
      packaging fields (`what: Claude needs your permission to run rm -rf build/` ·
      `why` · `blast radius` · `rollback`), rendered in the approvals post, approved
      through the same `watch:approve` the button calls (`{"ok":true,"reason":null}`),
      queue drained to 0, and the chain in `log.jsonl`:
      `gate opened … kind=tool-permission channel=local` →
      `gate approved … repeatBack=false`.
      Screenshot: [`docs/demo/m3-uc08-exit.png`](./demo/m3-uc08-exit.png).
      Log kinds recorded across both demos:
      `budget, delivery, gate, hook, orchestrator, spawn, task`.
      **Stated plainly:** every process, socket, router, endpoint, gate, committer
      and IPC in the demos is the real one; the agents' own *words* are scripted,
      because the `claude` binaries in this environment are unauthenticated and sit
      at a login prompt. Their messages are written into their real outboxes and
      routed exactly as composed ones would be.*
- [x] **M3 exit review** — UC-02 + UC-08 demo evidence; S-GATE, S-BREAKER,
      S-LEDGER, S-SECRETS green in CI; PROGRESS + docs synced.

### M3 verdict — DONE (2026-08-27)

Every exit criterion was verified **by running it**, not by reading code.

| IMPLEMENTATION §M3 exit criterion | How it was verified | Result |
|---|---|---|
| UC-02 — a real directive fans out through Artemis | Live run of the real app; Artemis auto-spawned as `claude` 2.1.247 into the temple, a real worker hired beside her | decompose → `t-uc02-a`/`t-uc02-b` filed · assignee `request` delivered · `done` reported back · `verified + closed: status=done resultRef=run#8842` · board updated by the one scribe. Chain in `log.jsonl`: `create → create → board → update → board` |
| UC-08 — a destructive op stops at a gate | Live run; real `notification` hook, token read from the live worker's own `/proc/<pid>/environ`; approved through the same `watch:approve` the button calls | held `kind=tool-permission because=no-rule` with all four packaging fields · `{"ok":true,"reason":null}` · queue drained to 0. Chain in `log.jsonl`: `gate opened … channel=local` → `gate approved … repeatBack=false`. Screenshot: [`m3-uc08-exit.png`](./demo/m3-uc08-exit.png) |
| S-GATE passes | `npx vitest run test/scenarios/s-gate.test.ts` | 12 passed *(recorded as "17" at review — corrected at the close-out audit: the suite has always had 12 cases; "17" conflated the seventeen M3.3 review findings. The same paragraph's total of 73 scenario cases was and is correct)* |
| S-BREAKER passes | `npx vitest run test/scenarios/s-breaker.test.ts` | 9 passed |
| S-LEDGER passes | `npx vitest run test/scenarios/s-ledger.test.ts` | 13 passed |
| S-SECRETS passes | `npx vitest run test/scenarios/s-secrets.test.ts` | 13 passed |
| The whole gate | `npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm test` | green — **1233 passed / 2 skipped**, up from 595 at M2 close |
| Sole authorship | `node scripts/check-attribution.cjs` | `attribution ok (57 commit(s) reachable from HEAD)` |

**Carried items, all closed where the plan assigned them:** the engine's
permission-dialog invisibility (M3.3) · `agora/human/` with no UI (M3.4) · the
breaker pathology signal emitted but unconsumed (M3.5) · every seat `terrace`,
tilesheet rendering and badge colour-only pairs (M3.6) · the claude adapter's
missing `resume` (M3.7) · `pendingTasksFor` always 0 (M3.8). The M2 close-out's
recorded **bounce-`from` schema gap** is closed too (M3.8), with reserved agent
ids rather than a schema change.

**Debt sweep:** no `TODO`/`FIXME`/`XXX` markers anywhere in `src/`, `shims/` or
`scripts/`. One doc drift found and fixed in this review: `src/main/ledger.ts`
was missing from the SDD §1.1 module map. SDD §2 (`authority.json`), §4.3
(`orchestrator` log kind) and §1.1 (`ledger.ts`) were updated as the packages
landed; SDD §5 already specified `agora: board()` and `state:tasks`, so those
were implemented to the doc rather than added to it.

**Open for the Architect (not blocking):**
1. **The ledger endpoint's address.** SDD §7.1 names a "harness ledger endpoint"
   but no address, and §4.4's `to` domain is `agentId | "broadcast" | "human"`.
   It is addressed as the reserved agent id `agent.ledger`, using the documented
   `agentId` branch, rather than adding a fourth literal (which would be a §8
   must-ask deviation from a normative schema). Promote it to `"ledger"` in §4.4
   if you would rather.
2. **Branch topology — resolved on the Architect's instruction.** Each package
   branch was cut from the previous package's rather than from `main`, because
   the packages are genuinely dependent (M3.5 consumes M3.2, M3.8 consumes M3.7,
   M3.9 consumes all). The chain is linear, so on the Architect's instruction
   `main` was **fast-forwarded** to the M3.9 tip and pushed — no merge commit, no
   conflicts, all twelve branches contained. CI run
   [41](https://github.com/mertefesensoy/ephesus/actions/runs/33068981836) is
   green on `main` at `0652cf6`.
3. **`main` is protected by policy, not by GitHub.** ENGINEERING-STANDARDS §2
   says "`main` is protected: PRs only, CI green, one review", and this run
   treated that as binding — but the direct push succeeded, so no branch
   protection rule actually enforces it. A rule with no mechanical backing is
   the class of thing this project does not otherwise tolerate; either turn on
   the protection rule or soften §2 to say what is true.
4. **CI does not run on feature branches.** `.github/workflows/ci.yml` triggers
   on `push: branches:[main]` and `pull_request` only, so "green" on each package
   during this run means the full CI job set run locally, byte for byte. CI has
   now verified the whole chain in one run on `main`.
5. **`mayDecide` has no production caller yet.** The plan assigns Artemis's proxy
   routing to M3.8 and the countersign surface to the Odeon (M5); M3.7 shipped the
   table, its validator and the enforcement hook every future caller goes through.

**Dogfood starts here** (IMPLEMENTATION §M3): from this milestone on, Ephesus
agents help build Ephesus.

### M3 close-out audit (2026-08-27) — verdict: DONE, with audit fixes landed

Independent two-agent audit at milestone close, the M0/M1/M2 pattern:

- **spec-verifier** (verification by execution): **M3 stands as DONE.** The
  whole gate reproduces exactly — typecheck · zero-warning lint · all four new
  invariant-tripwire classes proven to bite on planted probes (git, ledger
  UPDATE, env credential read, secret-shaped string) · full suite green
  **twice** with no flake · all four M3 suites and all five M2 suites pass on
  real process/fs/git seams · secrets write-only by construction and by pinned
  API-surface test · ledger append-only in code and by tripwire · gates deny
  by default · breaker ladder and Artemis wiring production-real. The
  UC-02/UC-08 live demos are not re-runnable in the audit environment; their
  records and the seven `docs/demo/m3-*.png` captures were checked for
  internal consistency (`m3-uc08-exit.png` matches the recorded gate
  packaging byte-for-byte).
- **doc-guardian** (design conformance): **substantially conforms** — the
  priority invariants hold structurally, DECISIONS-LOG discipline called
  exemplary — with three seam violations, five deviations and five nits, all
  handled below. Its diagnosis: joins *between* subsystems are where the
  per-module tests go blind (the same root cause named at the M2 close).

**Findings FIXED at close (gate after fixes: typecheck PASS · lint PASS ·
invariants PASS · tests 1236 passed / 2 skipped, run twice · scenarios 73/73):**

1. **Breaker trip signal #3 was dead wiring** — recurring hop-cap escalations
   were sniffed from `onBounced`, but a hop cap is a *divert*, not a bounce,
   so `noteHopCap` was unreachable. Hermes now raises `onDiverted` from the
   divert path (once per message), wired to the breaker, with a
   divert-not-bounce regression test.
2. **The paused-broadcast metronome** — rung 2 held an *entire* broadcast and
   re-delivered the already-served recipients every sweep, drumming duplicate
   `delivery` and `delivery-held` log entries. Delivery is now per-recipient:
   served copies are single-shot, the held copy waits, the hold is logged
   once, and the outbox drains when the last recipient is served.
3. **ADR-0011 rung 2 now lowers the budget** (Architect verdict: implement
   now) — `constrainBudget` joins `BreakerEffects`; a constrained agent runs
   on half its daily budget (`CONSTRAINED_BUDGET_FACTOR = 0.5`) until
   recovery lifts it, via the budget watcher's agent view — the append-only
   ledger is never touched. (Read-only tools remain excused: "where the
   engine supports it", and the reference engine cannot mid-session.)
4. **The M2 fire-and-forget class recurred at the boot path** —
   `void app.whenReady().then(async …)` wrapped the whole boot (including the
   native SQLite open) with no handler. Boot is now a named `boot()` with a
   `.catch` that shows an error box and quits — a visible failure, never an
   unhandled rejection. The two `void hookServer.stop()` shutdown calls got
   handlers too.
5. **Ledger-endpoint reply prose moved to prompts** (invariant §8) — the
   `agree`/`refuse` framing renders from `prompts/hermes/ledger-*.md`; the
   refusal reasons stay data, serialised into the `{{reasons}}` slot.
6. **Artemis could mail herself the Architect's escalations** — `to:"human"`
   from the orchestrator now routes to the `agora/human/` queue, never back
   into her own inbox (the proxy cannot proxy for herself), with a routing
   test.
7. **The notification-hook degradation flooded the health buffer** — engines
   repeat `notification` while one dialog stands; the report now fires once
   per blocked episode instead of once per event.
8. **The spend-gate packaging promised mechanics that do not exist** —
   "approving raises the ceiling for today only" was false; the prompt now
   states the real mechanics (deny refuses the request, approve proceeds,
   ceiling unchanged).
9. **Three orphaned prompt files removed** (`gate-held/approved/denied.md`) —
   written for an agent-facing notification path that has no code; they
   return with the path that loads them.
10. **Evidence errata corrected in place** — the exit table's S-GATE
    "17 passed" (the suite has always had 12; the total of 73 was correct)
    and the M3.9 prose; the UC-02 task-id mismatch (`t-uc02-a/b` in the
    record vs `t-uc02-1/2` in the screenshot) is noted as two demo runs.
11. **`watch:dismiss` documented** — the channel now appears in SDD §5 beside
    `humanQueue()`, with its DECISIONS-LOG entry (it had widened the
    documented IPC surface with no doc trail).

**Carried to M5, recorded with an owner (Architect verdict):** the
**agent↔task binding join** — nothing binds a live spawn to a ledger task, so
(a) `task.gates` is never populated in production (the M3.8 record overstated
this; every real `GateSubmission` carries `taskId: null`) and (b) rung 3
cannot return a task as `stalled` with the breaker report (ADR-0011). Both
land with the Odeon (M5), where task-close gates make the join load-bearing.

**Recorded, not fixed:** SDD §5's `breaker:trip` push is unimplemented (the
Watch panel polls at 3 s — arrives with a later Watch pass) · reduced
pty-heuristic protection surfaces in the Watch panel rather than on the agent
card (placement) · the real SQLite `AppDb` has no vitest coverage (Electron-ABI
constraint; covered by the recorded M3.2 live run) · renderer one-shot IPC
calls without `.catch` fall back to the bridge banner (the polling surfaces
all catch).

## M4 — The Library + engine breadth

Plan drafted 2026-08-27 at M3 close (derived per BUILD-PROMPT §5 from
IMPLEMENTATION M4 + ADR-0006/0016/0009 + SDD §1.1 (library.ts, scheduler.ts,
engines/) + §2 (`index/`, knowledge/, memory files) + TEST-STRATEGY §3
(S-CRASH) and §5). Execute in order; every package tests against the fake
engine per-PR.

**Architect decisions folded into this plan (2026-08-27, in DECISIONS-LOG):**
the two extra engines are **codex + gemini** (ADR-0009 roster, honest hook
grades — `wrapper`/`pty-heuristic` as demonstrated, never aspirational) · the
`agent.ledger` reserved-id addressing is RATIFIED as the standing rule for
harness-owned endpoints (no §4.4 schema change) · CI now runs on `feature/**`
and `fix/**` pushes, so "CI green per package" is real from M4.1 on ·
MemPalace remains an *optional external* (ADR-0016): every package must run
degraded without it, and its live-run proof may be owed to a local session if
the build environment cannot install Python/mempalace — the degradation
ladder is the tested surface either way.

**Carried in from M3 (each closes inside a package below):** `memory.md`
continuity on respawn — M3.7's resume re-injects identity/protocol and *logs*
whether memory carried, but nothing writes or reads `memory.md` yet (→ M4.1).
**Not this milestone's:** the agent↔task binding join (→ M5, see the M3
close-out audit) · Artemis's `mayDecide` first production caller (→ M5 memo
triage).

- [x] **M4.1 Memory protocol core + respawn-with-memory** — FR-6.1 live:
      per-agent `memory.md` (append-only dated sections, atomic writes) seeded
      at hire; the spawn context grows the memory layer (identity + PROTOCOL +
      memory per the injection budget); agents append learnings through their
      own directory (the ratified grant already covers it).
      Respawn-with-memory completes M3.7: a killed agent's respawn carries
      engine-native resume AND re-injected `memory.md`. Crash lifecycle per
      SDD §10: SIGKILL → `ghost` → archive, ledger tasks back to `todo` with a
      note, respawn offer — **S-CRASH (TEST-STRATEGY §3) is implementable
      here** with the fake engine.
      *Docs: ADR-0006 layer 1, FR-6.1, SDD §2, §10, TEST-STRATEGY §3 S-CRASH.
      Tests: append discipline (never rewrites, dated sections), injection
      snapshot, S-CRASH integration (ghost→archive, tasks→todo, respawn offer,
      resume where supported). Risk: memory.md is agent-written prose — no
      schema imposed at write time (ADR-0006); validators only guard the
      harness-owned framing.*
      *Landed 2026-08-27 (`feature/m4-1-memory-protocol`).* `src/shared/memory.ts`
      (read-time sections, harness framing, injection budget) ·
      `src/main/library.ts` (seed at hire, append-only atomic writes, the budgeted
      layer) · `prompts/library/` (seed header, layer wrapper, elision notice) ·
      `PROTOCOL.md` gains "How you remember" (SDD §2's agent-facing contract) ·
      `AgentSpawnConfig.memory` composed in main and injected by the adapter ·
      `AgentCard.respawnOffer` · `LedgerEndpoint.returnTasksOf` ·
      avatar `archived` mirrored into the roster.
      **Evidence (live run, real child processes SIGKILLed):**
      `npx vitest run test/scenarios/s-crash.test.ts` — 3 passed. The killed
      agent's own `memory.md` section ("The checkout test is flaky because the
      fixture seeds two carts.") comes back inside the respawned process's
      context, reported by the agent itself via `echo-env EPH_IDENTITY`; log
      shows `ghost {exitCode:-1, resumable:true, memorySections:1,
      tasksReturned:["t-crash-001"]}`, `task {event:"returned", from:
      "in_progress", to:"todo", because:"agent-exit"}`, and `spawn
      {respawn:true, resumed:true, memoryCarried:true, sessionId:"sess-mason-1"}`;
      ledger row back to `todo`; roster + avatar both `archived`.
      Gate: typecheck PASS · lint PASS · invariants PASS · **1268 passed / 2
      skipped** (was 1236). CI green on the branch:
      [run 44](https://github.com/mertefesensoy/ephesus/actions/runs/33075733612).

- [x] **M4.2 Library core + degradation ladder** — `src/main/library.ts`:
      recall over layer 1 + the knowledge shelf with the ADR-0006 ladder built
      first: SQLite FTS keyword search (app-local, derived state) degrading to
      plain grep, each state *visible* (Memory panel state + the agora:health
      pattern); `eph-recall` agent-facing CLI shim (the eph-hook single-client
      discipline) returning scored snippets; mtime-gated incremental indexing.
      *Docs: ADR-0006 layers 1–2, ADR-0016 §5, SDD §1.1 library.ts, NFR-7.
      Tests: known-answer queries against fixtures at every ladder rung (the
      recall smoke test's deterministic floor); mtime gating (unchanged files
      not re-mined); degraded states visibly distinct. Risk: FTS lives in
      app-local SQLite — native module stays behind the storage seam
      (M0 constraint 3); vitest never imports it.*
      *Landed 2026-08-27 (`feature/m4-2-library-ladder`).* `src/shared/recall.ts`
      (the grep rung — ADR-0006's transparency floor — passage splitting,
      deterministic scoring, the wire format) · `src/main/library.ts` grows
      `corpus()`, `reindex()`, `rung()`, `recall()` · `src/main/library-fts.ts`
      (mtime gate, scope, scoring, behind the `FtsStore` seam) +
      `library-fts-sqlite.ts` (real FTS5 in `index/fts.sqlite`, never imported by
      vitest) · `shims/eph-recall.mjs` answering on the hook socket's new
      `POST /recall` · `PROTOCOL.md` gains "How to look something up" ·
      `EPH_RECALL` reaches every spawn, conformance-tested.
      **Evidence (live run, real SQLite FTS5, real socket, real spawned shim):**
      first reindex `{mined:3,skipped:0,removed:0}` → second
      `{mined:0,skipped:3,removed:0}` → after one edit
      `{mined:1,skipped:2,removed:0}` (the mtime gate, working) · four
      known-answer queries answered on the `fts` rung with `degraded:null`,
      including a `--scope knowledge` and a `--scope agent.mason` query · the
      agent's own `eph-recall` printed `recall: 1 result(s) … [fts]` · the index
      was then deleted mid-run (SDD §10's repair path) and the same query came
      back `[grep]` with `recall degraded: fts: keyword index deleted` — the step
      down is visible to the agent, not just to the Architect.
      Gate: typecheck PASS · lint PASS · invariants PASS · **1329 passed / 2
      skipped** (was 1268).

- [x] **M4.3 MemPalace driver** — ADR-0016: `library.ts` drives a local
      MemPalace subprocess with engine-CLI discipline (version probe, visible
      install offer per FR-1.6, no hidden daemons); wings/rooms/drawers
      mapping (one wing per agent, one per target); store root
      `~/.ephesus/index/` (derived, disposable, outside the Agora repo);
      scoped recall behind the same `eph-recall` surface; absent/broken → the
      M4.2 ladder, visibly; engine-side MemPalace auto-save hooks stay OFF
      (one writer path — ADR-0016 consequence).
      *Docs: ADR-0016 (normative), ADR-0006 ladder, SDD §2. Tests: driver
      against a scripted fake `mempalace` CLI (the fake-engine pattern — no
      Python in CI); the no-Python path degrades visibly; the store root is
      never committed to the Agora. Risk: MemPalace is optional — if the
      environment cannot `pip install mempalace`, the live-run proof is owed
      to a local session and recorded as such, never faked.*
      *Landed 2026-08-27 (`feature/m4-3-mempalace-driver`).*
      `src/main/library-mempalace.ts` drives the real MemPalace 3.x CLI
      (`--palace` global, `mine --wing`, `search --wing --results`) under
      ADR-0009's subprocess discipline · one wing per agent + one for the shelf
      (ADR-0016 §2) · palace root `~/.ephesus/index/`, outside the Agora ·
      `MEMPALACE_HOOKS_AUTO_SAVE=0` and `MEMPALACE_HOOKS_DAEMON=0` on **every**
      invocation and `--daemon`/`--background` never passed (ADR-0016's one
      writer path) · `config.json` grows an optional `mempalaceCommand` ·
      `RecallIndex.sync/search` became async, since a rung may now be a
      subprocess. `test/fakes/fake-mempalace/` is a scripted fake CLI speaking
      the real surface, so CI never needs Python.
      **Evidence (live run against real MemPalace 3.8.0, installed here via
      `pip install mempalace` in a venv):** probe
      `{"version":"3.8.0","because":"available"}` · ladder
      `{"rung":"mempalace","degraded":null}` · reindex `{mined:3,skipped:0}` then
      `{mined:0,skipped:3}` · **semantic** answers the keyword rungs cannot give
      — *"what must happen before a release goes live"* returned the release
      runbook (score 41.9) and *"why is checkout unreliable"* returned
      agent.mason's flaky-checkout memory, neither query sharing the words that
      matched · `--scope agent.iris` pushed down as `--wing` · palace on disk
      (`chroma.sqlite3`, `mempalace_embedder.json`, …) with `index/` **not**
      inside `agora/` · the agent's own `eph-recall` answered
      `recall: 1 result(s) … [mempalace]`.
      One honest limit found by that run: MemPalace files whole documents as
      drawers, so the top rung's granularity is a *file* where the keyword rungs
      return a passage; the snippet is bounded and windowed around the query
      (`snippetOf` was improved in this package to open where the most distinct
      terms are — the live run showed it opening on `is` in the boilerplate).
      Gate: typecheck PASS · lint PASS · invariants PASS · **1349 passed / 2
      skipped** (was 1329).

- [x] **M4.4 Reflection job + memory archive** — ADR-0006 layer 3: a minimal
      `scheduler.ts` (cron-like trigger table; reflection is its first client,
      standups join in M5) fires condensation when `memory.md` crosses the
      size threshold: compact core + everything condensed appended to
      `memory-archive/` dated files — bounded memory, nothing destroyed
      (NFR-7); condensation prompts in `prompts/library/` (they shape what the
      company forgets — policy as text, ADR-0006 consequence); archive events
      → log; MemPalace archives what reflection condenses (when present).
      Condensation runs as a normal agent turn on a harness prompt — never a
      second model runtime in main (ADR-0005's mechanism/intelligence split;
      the option "harness calls a model API directly" is explicitly rejected
      there).
      *Docs: ADR-0006 layer 3, ADR-0016 §3, NFR-7, SDD §1.1 scheduler.ts.
      Tests: threshold trigger, archive completeness (core ∪ archive ⊇ old
      memory), prompt-surface separation, scheduler tick idempotency. Risk:
      the job must degrade when no agent is available — deferred, visibly,
      never dropped.*
      *Landed 2026-08-27 (`feature/m4-4-reflection-archive`).*
      `src/main/scheduler.ts` (interval table, idempotent ticks: at most one
      firing per interval, never re-entered while running) ·
      `src/shared/reflection.ts` (threshold plan, condensation wire format, the
      `nothingDestroyed` check) · `src/main/reflection.ts` (the job) ·
      `Library.condense()` — the **one** method allowed to rewrite `memory.md`,
      and only because the archive is written first and the union is verified ·
      `agent.library` joins the reserved ids, routed like `agent.ledger` ·
      `Hermes.deliverFromHarness` logs harness-authored mail as `delivery`, so
      reflection needs no new log kind (NFR-13's trail is the three messages) ·
      prompts in `prompts/library/`.
      **Evidence (live run: real Agora + git, real router, a real fake-engine
      process writing the reply into its own outbox):**
      `memory.md 32 640 chars, plan due=true` → the harness delivered
      `from=agent.library to=agent.mason act=request "condense your memory"`
      (it asked; it did not summarize) → the agent process wrote its `propose`
      to `agent.library` → the router carried it to the endpoint →
      `memory.md 14 327 chars`, `archive ["2026-08-27-001.md"]`, core present,
      newest section kept, oldest archived, **`nothingDestroyed → {ok:true}`** →
      the agent was answered `act=agree "memory condensed — 7 section(s)
      archived to 2026-08-27-001.md"`. `log.jsonl` carries both deliveries.
      Gate: typecheck PASS · lint PASS · invariants PASS · **1388 passed / 2
      skipped** (was 1350).

- [x] **M4.5 Knowledge shelf + Memory panel** — `agora/knowledge/`
      Architect-registered reference docs (register/list via IPC, files
      through the single committer); the Memory panel tab (UI-DESIGN §4):
      per-agent memory view, recall search over `eph-recall`'s same path, the
      ladder state chip (mempalace | fts | grep — degradation visible),
      archive browser. SDD §5's `agora: memory(id)` lands here.
      *Docs: ADR-0006 layer 2, SDD §5, UI-DESIGN §4. Tests: renderer stays a
      projection; shelf writes only via main; panel states track the ladder.
      Risk: inventing UI — the panel is the documented Memory panel, nothing
      more.*
      *Landed 2026-08-27 (`feature/m4-5-knowledge-memory-panel`).*
      `Library.knowledge()/registerKnowledge()/memoryView()` ·
      `src/renderer/src/MemoryPanel.tsx` (agent picker, recall box with the
      **ladder chip**, `memory.md` view, archive browser, shelf list + register
      form) · the Memory tab joins Floor/Activity/Ledger/Watch · four new IPC
      channels, documented in SDD §5 in the same commit per the M3.1 rule:
      `agora:memory` (SDD §5's `memory(id)`), `agora:recall`,
      `agora:knowledge`, `agora:register-knowledge`.
      **Evidence (live run of the shipped IPC deps over a real Agora + git and
      real MemPalace 3.8.0):** registered `release-runbook.md (73B)` and the
      single committer committed it (`committed: true`); `../escape`,
      `sub/dir` and `/etc/passwd` each refused at the Library boundary as well
      as at the schema; `agora:memory` returned
      `sections=2 chars=799 reflection due=false archive=[]`; `agora:recall`
      answered `rung=mempalace degraded=null` for both queries; and the same
      panel against a broken top rung answered `rung=grep` with
      `degraded="mempalace: MemPalace not available (spawn … ENOENT) — install
      it with: pip install mempalace"` — the chip the Architect sees.
      **Owed to a local session:** the rendered screenshot. `electron-rebuild`
      cannot finish here — this environment's proxy answers 403 to
      `www.electronjs.org`, so node-gyp cannot fetch Electron headers and
      `better-sqlite3` stays Node-ABI, which means `npm run dev` cannot boot.
      Recorded rather than faked, on the same footing as MemPalace's
      environment caveat.
      Gate: typecheck PASS · lint PASS · invariants PASS · **1413 passed / 2
      skipped** (was 1388).

- [x] **M4.6 Codex adapter** — `src/main/engines/codex.ts` at its honest hook
      grade (declared = demonstrated — the M1.7 grade-honesty case must bite);
      spawn plan, settings/config hygiene with backup + uninstall, interrupt
      key, version probe, install offer, transcript reader against fixtures.
      **Adapter-only diff** (TEST-STRATEGY §5: any core diff fails the
      import-boundary lint).
      *Docs: ADR-0009, TEST-STRATEGY §5. Tests: the full conformance table +
      behavioral cases on the fake-engine rig patterns; live spawn is
      nightly/local territory. Risk: grading up — if codex demonstrates only
      wrapper-grade events it ships as `wrapper`, and the card says so.*
      *Landed 2026-08-27 (`feature/m4-6-codex-adapter`).* `src/main/engines/codex.ts`
      plus one registration line and one conformance subject — no core diff.
      Written against a **real `codex-cli 0.150.1`** installed and run here.
      **It declares `pty-heuristic`, and that is the honest grade.** Codex 0.150.1
      does have a hook plane (`PreToolUse`/`PostToolUse`/`SessionStart`/
      `SessionEnd`/`Stop`/`SubagentStop`/`PreCompact`/`PostCompact`/
      `UserPromptSubmit`/`Notification`/`TurnStart`/`TurnEnd` are all in the
      binary), but two things stand between an installed hook file and an event
      reaching the harness: Codex refuses to run hooks without *persisted trust*
      — its only override is `--dangerously-bypass-hook-trust`, and the harness
      will not lower a permission default on the Architect's behalf (that is a §8
      must-ask) — and the hook file's schema could not be confirmed against the
      real CLI, so writing a guessed config into the Architect's repo would be
      the improvisation §7 forbids. So the adapter writes **nothing**, claims no
      events, and the agent card says so. It also declares **no `resume`** (see
      the must-ask below) and **no transcripts** (no credentials here, so the
      session format is unverified; inventing one would fold invented numbers
      into the append-only ledger).
      **Evidence (live, against the real binary):** `codex --version` →
      `codex-cli 0.150.1`, `parseVersion → 0.150.1` · install offer
      `npm install -g @openai/codex` · plan
      `["codex","--cd","<cwd>"]` + identity/protocol/memory as the first prompt
      (SDD §3's first-prompt injection) · the real `--help` confirms `--cd`,
      `[PROMPT]` and `--dangerously-bypass-hook-trust` exist · install leaves the
      cwd byte-identical, uninstall is safe twice · `settings: []`.
      Conformance: the full table, at `wiresEveryEvent: false`. The suite's two
      *installer* hygiene cases became conditional (an adapter may legitimately
      install nothing) and a new assertion holds the other half — an adapter that
      declares no settings must write none.
      Gate: typecheck PASS · lint PASS · invariants PASS · **1443 passed / 3
      skipped** (was 1413).

- [x] **M4.7 Gemini adapter** — `src/main/engines/gemini.ts`, same contract,
      same honesty bar, same adapter-only-diff rule.
      *Docs/Tests/Risk: as M4.6.*
      *Landed 2026-08-27 (`feature/m4-7-gemini-adapter`).* `src/main/engines/gemini.ts`
      plus one registration line and one conformance subject — no core diff.
      Written against a **real `gemini` 0.57.0** installed and run here, plus its
      own bundled hook documentation. **It declares `pty-heuristic`, for a
      different documented reason than codex's.** Gemini has the best-documented
      hook plane in the roster after Claude Code's (`SessionStart`, `SessionEnd`,
      `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`,
      `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`,
      `Notification`, with a published config shape), but its project settings
      live at `.gemini/settings.json` — a **tracked** file, which ADR-0009
      forbids the harness writing ("only ever… local/gitignored variants"; the
      only `settings.local.json` in the CLI is the *Claude Code* file its
      `hooks migrate` command reads) — and project hooks are untrusted by
      default, with `--skip-trust` as the only override. Both are §8 must-asks,
      not implementation details, so the adapter writes nothing and claims
      nothing. It declares **no `resume`** (its `--resume` takes `"latest"` or an
      index, never a session id; `--resume latest` in a shared repo would reopen
      another agent's session — the cross-attribution bug M3 removed from the
      ledger) and **no transcripts** (no credentials here).
      **Evidence (live, against the real binary):** `gemini --version` → `0.57.0`,
      `parseVersion → 0.57.0` · install offer `npm install -g @google/gemini-cli`
      · plan `["gemini", <identity+protocol+memory>]` running in the agent cwd ·
      the real `--help` confirms `[query..]`, `--skip-trust`, `--resume` and
      `gemini hooks` exist · install leaves the cwd byte-identical, uninstall is
      safe twice · `settings: []` · never passes `--skip-trust`, `--yolo`,
      `--approval-mode` or `-p`.
      Gate: typecheck PASS · lint PASS · invariants PASS · **1474 passed / 4
      skipped** (was 1443).

- [x] **M4.8 Worktree isolation option** — UC-01 alternate 2a: a spawn may
      request its own git worktree of the target repo; worktree create/remove
      through `git.ts` (the one committer — no second git path); agent cwd,
      grants and settings install target the worktree; unwind removes a clean
      worktree and *reports* a dirty one.
      *Docs: SRS UC-01 2a, ADR-0004, SDD §3 SpawnPlan. Tests: worktree
      lifecycle on real git temp repos; dirty-worktree unwind refuses +
      reports; the invariant tripwire still passes. Risk: worktrees of the
      agent's TARGET repo, never of the Agora.*
      *Landed 2026-08-27 (`feature/m4-8-worktree-isolation`).* `Worktrees` in
      `git.ts` — the one module allowed to run git, so isolation cannot become a
      second git path · `spawnRequestSchema.worktree?: boolean` ·
      `AgentCard.worktree` (path, branch, whether the branch was created) ·
      `~/.ephesus/worktrees/<agentId>/`, branch `agent/<name>` per
      ENGINEERING-STANDARDS §2 · the cwd is replaced **before** anything is
      written, so grants, settings and transcripts all follow it · a respawn
      re-isolates onto the same branch.
      Two rules are enforced in `git.ts` rather than trusted to callers:
      **never the Agora** (a worktree of the company repo would put a second
      working copy behind the single committer — refused for the Agora root and
      anything under it) and **never destroy work** (`--force` is never passed;
      a dirty worktree is kept, the changes are named, and the refusal is
      reported, not just logged).
      **Evidence:** 17 tests against **real git in real temp repositories** —
      `agent/mason` created and checked out, the Architect's own repo left
      `git status --porcelain` empty, the fake engine's settings landing in the
      worktree and *not* in the target, a clean checkout released at exit
      (`worktreeRemoved: true`), a dirty one kept with `unpushed.md` byte-intact
      and `uncommitted change` reported, a respawn reusing the branch
      (`branchCreated: false`), and a non-isolated spawn creating no worktree
      directory at all. Invariant tripwire still passes (`invariants ok`).
      Gate: typecheck PASS · lint PASS · invariants PASS · **1491 passed / 4
      skipped** (was 1474).

- [x] **M4.9 Recall smoke + exit demos + review** — the recall smoke test with
      known-answer queries green at every available rung (grep/FTS always;
      MemPalace where installed); the respawn-with-memory demo (kill a real
      agent mid-task, respawn, it demonstrably recalls — M3.7's
      `memoryCarried` log fact now true); S-CRASH green in CI; conformance
      suite green for fake + claude + codex + gemini; the parity checkpoint
      recorded (IMPLEMENTATION: the upstream inspiration's core loop reached).
      *Docs: IMPLEMENTATION M4 exit, TEST-STRATEGY §3/§5. Risk: suites per-PR
      on the fake engine; real-engine runs are exit-review territory.*
      *Landed 2026-08-27 (`feature/m4-9-recall-smoke-exit`).*
      `test/conformance/recall-smoke.test.ts` — one fixture corpus, five
      known-answer queries plus a known-*un*answer, run against **every rung the
      machine can offer**. grep and fts always; the MemPalace rung runs when
      `EPH_MEMPALACE` names a real binary and, when it does not, the suite
      *says so* rather than skipping quietly — an optional external that
      silently skipped its own smoke test would be the invisible degradation
      invariant §7 forbids.
      **Recall smoke, live, at all three rungs** (`EPH_MEMPALACE` pointed at the
      real MemPalace 3.8.0 installed here): **16 passed** — every query green on
      `grep`, on `fts`, and on `mempalace`.
      **Respawn-with-memory demo:** [`m4-respawn-recall.txt`](./demo/m4-respawn-recall.txt).
      Real Agora + git, real hook socket, real child processes, real files; the
      engine is the fake engine (a real spawnable CLI) because nothing in this
      environment can authenticate a real one — its *words* are scripted, every
      mechanism around them is the shipped one, said plainly rather than implied
      (the M3.9 rule). The run: Artemis files `t-demo-1` and puts it
      `in_progress` → Mason spawns and writes down what it learned → **SIGKILL
      mid-tool-call** (`exitCode=-1`) → offer `resumable=true memorySections=1
      tasksReturned=["t-demo-1"]`, ledger back to `todo` → respawn, and the
      **new process prints back the context it was handed**, containing its own
      sentence verbatim → `log.jsonl: memoryCarried=true resumed=true
      sessionId=sess-mason-demo` → it then asks the company two questions in its
      own words and gets answers on the `mempalace` rung from a colleague's
      memory and from the knowledge shelf.
      Gate: typecheck PASS · lint PASS · invariants PASS · **1506 passed / 5
      skipped** (the fifth skip is the MemPalace rung's smoke case, which runs
      only when `EPH_MEMPALACE` is set — reported, per above, never silent).

- [x] **M4 exit review** — respawn-with-memory demo evidence; recall smoke
      green; codex + gemini conform at honest grades; S-CRASH green in CI;
      PROGRESS + docs synced.

### M4 verdict — DONE (2026-08-27)

Every exit criterion was verified **by running it**.

| IMPLEMENTATION §M4 exit criterion | How it was verified | Result |
|---|---|---|
| Kill and respawn an agent — it resumes with memory | The demo, live: real Agora + git, real hook socket, real child processes, real files; a real process SIGKILLed mid-tool-call. Capture: [`m4-respawn-recall.txt`](./demo/m4-respawn-recall.txt) | `exitCode=-1` · offer `resumable=true memorySections=1 tasksReturned=["t-demo-1"]` · ledger `t-demo-1=todo` · the **new process printed back the context it was handed**, containing its own sentence verbatim · `log.jsonl: memoryCarried=true resumed=true sessionId=sess-mason-demo` |
| Recall smoke test with known-answer queries passes | `EPH_MEMPALACE=<real mempalace> npx vitest run test/conformance/recall-smoke.test.ts` | **16 passed** — five known-answer queries plus a known-*un*answer, green on **grep, fts and mempalace**; scoped queries stayed in scope at every rung |
| Two extra engines pass conformance | `npx vitest run test/conformance/engine-adapters.test.ts` | **72 passed / 2 skipped** — the table ran 17 cases against **codex** and 17 against **gemini**, beside claude's 17 and the fake engine's 23. Both new adapters declare `pty-heuristic`, and both *demonstrate* it: they write no settings and the suite checks that they write none |
| Parity with the upstream inspiration's core loop | Recorded below | **Reached** |
| S-CRASH (TEST-STRATEGY §3) | `npx vitest run test/scenarios/s-crash.test.ts` | 3 passed — SIGKILL mid-task → ghost → archived, task back to `todo`, respawn offer, resume where the adapter supports it and an honest `false` where it does not |
| Every scenario suite still green | `npx vitest run test/scenarios` | **76 passed** across 11 files (73 at M3 close + S-CRASH's 3) |
| The whole gate | `npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm test` | green — **1506 passed / 5 skipped**, run **twice** with no flake, up from 1236 at M3 close |
| Per-package CI green (the M3-close verdict made real) | GitHub Actions on every `feature/m4-*` push | runs **44–53**, all `success`: [44](https://github.com/mertefesensoy/ephesus/actions/runs/33075733612) · [45](https://github.com/mertefesensoy/ephesus/actions/runs/33076950842) · [46](https://github.com/mertefesensoy/ephesus/actions/runs/33078145285) · [47](https://github.com/mertefesensoy/ephesus/actions/runs/33079302409) · [48](https://github.com/mertefesensoy/ephesus/actions/runs/33080103288) · [49](https://github.com/mertefesensoy/ephesus/actions/runs/33080925749) · [50](https://github.com/mertefesensoy/ephesus/actions/runs/33081401238) · [51](https://github.com/mertefesensoy/ephesus/actions/runs/33082003210) · [52](https://github.com/mertefesensoy/ephesus/actions/runs/33082382431) · [53](https://github.com/mertefesensoy/ephesus/actions/runs/33082744361) |
| Sole authorship | `node scripts/check-attribution.cjs` | `attribution ok` *(recorded as "59 commit(s)" at review — corrected at the close-out audit: 59 is main's pre-M4 count, so that line was produced on the wrong checkout; on the M4 tree the check passes at 71 commits, all Architect-authored)* |

**Parity checkpoint (IMPLEMENTATION M4, and R8's "parity at M4 means the
project is useful even if paused there").** The upstream inspiration's core
loop is: spawn real engine CLIs you own → give them identity and a shared
protocol → let them message each other through files → coordinate through a
blackboard and a task ledger → govern them with gates, budgets and a breaker
→ and give them memory that survives the process, with detect-and-degrade
recall over it. As of M4 every one of those is implemented, tested at the
seam it actually runs on, and demonstrated live: M1 the owned spawn and the
event plane, M2 Hermes and the Agora, M3 Artemis and the Watch, M4 the
Library. **Reached.** What M5–M7 add is the differentiator — accountability
(the Odeon), voice (the Herald), the Harbor and missions — not parity.

**Carried items, closed where the plan assigned them:** `memory.md` continuity
on respawn (→ M4.1 — M3.7's `memoryCarried` log fact is now *true*, asserted
by S-CRASH and shown in the demo). **Not this milestone's, still carried:**
the agent↔task binding join (→ M5 with the Odeon) · Artemis's `mayDecide`
first production caller (→ M5 memo triage).

**Debt sweep:** no `TODO`/`FIXME`/`XXX` markers anywhere in `src/`, `shims/`
or `scripts/`. Doc drift found and fixed in this review: SDD §1.1's module map
was missing `fsx.ts`, `home.ts` and `index.ts` (the same drift class the M3
close-out found with `ledger.ts`); the map now covers every file in
`src/main/`. Every IPC channel's group is documented in SDD §5. SDD §2 (the
`worktrees/` and `index/` entries, `events.sock`'s recall path, `memory.md`'s
one sanctioned rewriter), §3 (memory layer on the spawn config, worktree cwd),
§4.6 (why the keyword index is not in `db.sqlite`), §5 (the four Library
channels) and §10 (the crash row's note, resumable and memory facts) were
updated as the packages landed.

**Owed to a local session, recorded rather than faked:**

1. **The Memory panel's screenshot.** `electron-rebuild` cannot complete in
   this environment — the proxy answers 403 to `www.electronjs.org`, so
   node-gyp cannot fetch Electron headers, `better-sqlite3` stays Node-ABI and
   `npm run dev` cannot boot. Everything provable without Electron was proven
   by live run of the shipped IPC deps (M4.5's record).
2. **A real-engine respawn demo.** No engine in this environment can
   authenticate (`codex doctor` reports no credentials and unreachable
   provider endpoints). The demo runs real processes with scripted words — the
   M3.9 rule, stated plainly rather than implied.

**Still owed: the two-agent close-out audit.** M0–M3 each closed with an
independent `spec-verifier` (verification by execution) + `doc-guardian`
(design conformance) pass, and that pattern has caught real defects at every
milestone — eleven landed fixes at M3 alone. This session could not run it:
the harness it ran under withheld the Agent tool. The review above was
performed by execution, first-hand, and every number in the table came from a
command run in this session — but a second pair of eyes on the M4 diff has not
happened, and this milestone should not be treated as audited until it does.

**Open for the Architect (not blocking) — full statements in the session
report:** `ResumeSupport`'s append-only contract cannot express codex's
subcommand resume or gemini's index-based one, so both ship without resume ·
gemini's hook wiring needs a ruling on writing a *tracked* settings file ·
codex's needs one on hook trust · SDD §4.3's closed log-kind list has no
`memory` kind (reflection needed none, but a future Library event would) ·
four IPC channels widened the SDD §5 surface, documented in-commit per the
M3.1 rule.

### M4 close-out audit (2026-08-27) — verdict: DONE, with audit fixes landed

The two-agent audit the M4 run recorded as owed, now run — the M0–M3 pattern:

- **spec-verifier** (verification by execution): **M4 stands as DONE.** Every
  executable exit criterion re-verified first-hand — gate green (typecheck ·
  zero-warning lint · invariants, tripwire proven to bite) · full suite
  **1506/5 twice with no flake** · 76/11 scenarios incl. a real-SIGKILL
  S-CRASH · 72/2 adapter conformance with honestly-graded codex + gemini
  (settings-absence genuinely asserted) · the recall smoke green at **all
  three rungs including a freshly pip-installed real MemPalace 3.8.0** ·
  worktrees on real git · token-gated fail-closed recall shim · zero debt
  markers. Not re-runnable here: CI runs 44–53 (GitHub unreachable) and the
  live respawn demo (its capture is internally consistent and honestly
  caveated).
- **doc-guardian** (design conformance): **M4 conforms.** Ladder visibility,
  MemPalace discipline (no daemons, auto-save hooks off, palace out of the
  Agora), NFR-7's nothing-destroyed property, honest adapter grades, the
  single git path, S-CRASH per SDD §10 — all implemented as documented *and
  asserted by the owed tests*. The ADR-0016 wings-per-target narrowing was
  verified recorded, in code and log alike.

**Findings FIXED at close (gate after fixes: typecheck PASS · lint PASS ·
invariants PASS · tests 1508 passed / 5 skipped, run twice):**

1. **Three LLM-facing prose literals in main** (invariant §8) — the
   reflect-request subject and the library-unavailable reply now render from
   `prompts/library/` (`reflect-request-subject.md`, `unavailable-subject.md`,
   `unavailable.md`); Hermes's tests-only fallback went mechanical, matching
   its own render() standard.
2. **The recall smoke's reporting case was a tautology** — its assertion could
   never fail. Now falsifiable both ways: `EPH_MEMPALACE` set-but-broken FAILS
   the suite (a configured-but-dead rung is the invisible degradation
   invariant §7 forbids); unset asserts the absence rather than assuming it.
3. **Respawn onto a kept dirty worktree contradicted itself** — the unwind
   rightly kept the work, but the respawn's `create()` refused the surviving
   path, logging `worktree: null` while the card still named it. A path that
   is the agent's own worktree on its own branch is now *reuse*; anything else
   still refuses. Two regression tests.
4. **`eph-recall` had grown a duplicate socket transport** — against M1.2's
   single-client rule the record claimed. `hook-client.mjs` now exports the
   one low-level `postJson` transport; hooks map it fail-open, recall maps it
   fail-closed, and there is no second implementation to drift.
5. **Evidence erratum corrected in place** — the exit table's
   `attribution ok (59 commit(s))` was provably produced on pre-M4 `main`
   (59 = the old tree's count; the M4 head is 71). The check passes on the
   real tree; the line was the record-hygiene class the M3 audit named.
6. **SDD §4.3 gains the `memory` log kind** (Architect verdict) and the four
   Library IPC channels are **ratified** after channel-by-channel review.

**Recorded, not fixed:** the codex commit also touched the shared conformance
harness (+50/−18, disclosed in-commit — necessary to admit a no-settings
adapter; TEST-STRATEGY §5's "only its adapter" reading is noted) · the
declared-vs-demonstrated live check runs only against the fake engine, so for
codex/gemini honesty reduces to "declares pty-heuristic + provably writes
nothing" (real, but a coverage note) · nothing would catch an adapter writing
outside the agent cwd (none does today).

**Architect verdicts at this close (all in DECISIONS-LOG):** codex and gemini
stay `pty-heuristic` — the harness never flips a trust default and never
writes a tracked settings file; their hook wiring is owed to a local session
where the Architect persists trust interactively · no-resume stands for both;
the ResumeSupport plan-transform generalization is a recorded candidate for a
future ADR-0009 annex · the agent↔task binding join lands in **M5.1**.

## M5 — The Odeon + Gymnasium v1

Plan drafted 2026-08-27 at M4 close (derived per BUILD-PROMPT §5 from
IMPLEMENTATION M5 + ADR-0008/0015 + SDD §1.1 (odeon.ts, org.ts, gymnasium.ts,
scheduler.ts) + §4.5 + §7.2/§7.3/§7.6 + TEST-STRATEGY §3). Execute in order;
every package tests against the fake engine per-PR.

**Architect verdicts folded into this plan (2026-08-27, in DECISIONS-LOG):**
codex and gemini stay `pty-heuristic` — the harness never flips a trust
default (`--dangerously-bypass-hook-trust`) and never writes a tracked
settings file; their hook wiring is owed to a local session where the
Architect persists trust interactively · no-resume stands for both (the
ResumeSupport plan-transform generalization is a recorded candidate for a
future ADR-0009 annex, not invented now) · the `memory` log kind is added to
SDD §4.3 · the four Library IPC channels are ratified as documented.

**Carried in from M3/M4 (each closes inside a package below):** the
**agent↔task binding join** (→ M5.1 — nothing binds a live spawn to a ledger
task, so `task.gates` is never populated in production and breaker rung 3
cannot return a task `stalled` with its report) · Artemis's `mayDecide`
first production caller (→ M5.3 memo triage) · the breaker's owed S-BREAKER
clause "task returns `stalled` with the breaker report attached" (→ M5.1).
**Owed to local sessions, not packages:** the Memory panel screenshot;
codex/gemini hook wiring post-trust; a real-engine respawn demo.

- [x] **M5.1 The agent↔task binding join** — bind live spawns to ledger
      tasks: an assignment `request` carries its `taskId` and the harness
      records the binding (spawn → task) so the three consumers that were
      blind get eyes: gate choke points submit `taskId` (SDD §4.2's
      `task.gates` finally populated in production, and `status→done` refused
      while a gate is open — for real this time); breaker rung 3 returns the
      bound task to the ledger as `stalled` with the breaker report attached
      (ADR-0011's owed clause); S-CRASH's task-return path uses the same
      binding. Artemis reassignment of a `stalled` task via the ledger
      endpoint.
      *Docs: SDD §4.2, §7.1, ADR-0011 rung 3, the M3/M4 close-out audit
      records. Tests: binding through the real assignment flow (two fakes);
      gate→task.gates population asserted in production wiring, not test-only;
      rung-3 stalled + report; done-refused-while-gated now reachable and
      asserted end-to-end. Risk: the binding is harness bookkeeping — no new
      agent-facing schema; the message already carries the task in its spec.*
      *Evidence: `typecheck && lint && check-invariants` green; the suites this
      package touches run 200/200 (`test/shared/ledger-endpoint`,
      `test/main/ledger-endpoint`, `test/main/gates`, `test/main/breaker`,
      `s-breaker`, `s-blackout`, `s-gate`, `s-ledger`) — 33 new cases.
      The join is **derived from `tasks.json`, never remembered**: an in-memory
      agent→task map would be empty after exactly the event that makes the
      binding matter most, a restart. `boundTaskFor` prefers `in_progress` over
      `todo`, then lower priority, then id, and a table asserts the answer is
      STABLE under file reordering — an unstable binding would open a gate
      against one task and settle it against another.
      **The production wiring is what is asserted**: `wireGateChokePoints`
      gained `taskOf`, and a test drives all three choke points (notification,
      needs-human, spend) and asserts each gate carries the bound task; a second
      case proves `submitNeedsHuman` looks the binding up for the SENDER.
      `test/scenarios/company.ts` now runs the SHIPPED `LedgerEndpoint`, so the
      scenarios exercise the join rather than describing it.
      **ADR-0011 rung 3's owed clause is closed**: `BreakerEffects.returnTask`
      is required (not optional — rung 3 always owes it), and S-BREAKER now
      proves it against a REAL spawned `fake-engine` looping on failing calls:
      `return-task:agent.mason:t-sbreaker-01`, the task at `stalled`, and the
      `task`/`stalled` row in `log.jsonl` carrying `because: breaker`, `rung: 3`
      and the `error-rate` signal. An unassigned agent stops with
      `return-task:agent.tess:none` and invents no work to stall. The report
      goes to the book of record, NOT into `taskSchema` — the schema is strict
      and has no notes field, the same split `returnTasksOf` already makes for
      SDD §10's crash note.
      LIVE RUN THROUGH THE REAL APP (`EPH_HOME=<temp> electron-vite dev`), the
      whole gate half end to end on a real `tasks.json`:
      `task created: {"ok":true,"applied":[{"op":"create","taskId":"t-evidence-01"}]}` ·
      `bound task for agent.mason: t-evidence-01` ·
      `gate opened: g-2026-08-28t07-42-17-921z-… taskId= t-evidence-01` ·
      `tasks.json gates: [{"id":"t-evidence-01","gates":["g-2026-08-28t07-…"]}]` ·
      `close while gated: {"ok":false,"reasons":["task t-evidence-01 is blocked by open gate(s): g-…"]}` ·
      `tasks.json gates after verdict: [{"id":"t-evidence-01","gates":[]}]` ·
      `close after verdict: {"ok":true,…}` · `final status: done`.
      That is the M3/M4 carried item closed in the shipped app: `task.gates` is
      written by the running harness for the first time, and SDD §4.2's
      `status → done` refusal finally guards a field something fills. Artemis's
      reassignment of a stalled task is asserted through her own outbox, and the
      binding follows the new assignee.*
- [x] **M5.2 Deck template + task-close gate + deck viewer** — FR-7.2,
      S-DECKGATE: a `review:deck` task is *mechanically unclosable* until a
      deck exists — the harness rejects `status→done` (the §4.2 guard's
      `review` half, now load-bearing); single-file HTML deck from the
      standard template (goal/built/decisions/trade-offs/evidence/open
      questions — template in `prompts/odeon/`, evidence embedded not
      linked); decks archive immutably at `odeon/decks/<taskId>-<ts>.html`
      (append-only: never rewritten); deck viewer in-app; Architect comments
      become follow-up tasks.
      *Docs: ADR-0008 §2, FR-7.2, SDD §2, UC-05. Tests: close-refusal until
      deck exists, immutability (a second deck is a new file), viewer stays a
      projection; S-DECKGATE per TEST-STRATEGY §3. Risk: the deck is an
      artifact an AGENT writes into its own outbox for the harness to
      archive — agents never write `odeon/` (SDD §2).*
      *Evidence: `typecheck && lint && check-invariants` green; 56 new cases
      (`test/shared/odeon.test.ts` 31, `test/main/odeon.test.ts` 25), and the
      affected suites 154/154 and 264/264 across two runs.
      The filing path is the SHIPPED one: an agent `propose`s to a reserved
      **`agent.odeon`** endpoint from its own outbox, the real router carries it,
      and the harness archives. Every test goes through that path, so one that
      called `fileDeck()` past the router could not pass for the wrong reason.
      **The agent supplies the six sections; the harness applies**
      **`prompts/odeon/deck.html`** — the only way FR-7.2's "from the standard
      template" is enforced rather than hoped for, and it keeps every word in
      `prompts/` (invariant §8).
      Refusals are complete and named: a missing OR EMPTY section (each of the
      six, table-driven), an unknown section, a deck for a task assigned to
      somebody else, a deck for a task carrying no `deck` obligation, a deck for
      a task that does not exist, and a non-`propose` act bounced at the router
      before the archive sees it.
      **Append-only proven**: a revised deck is a SECOND file and the first is
      re-read byte-for-byte after it; `artifacts.deck` names the newest while the
      older stays on the shelf. Content is HTML-escaped on the way in and the
      viewer's iframe carries no `allow-scripts` on the way out; path traversal
      is refused four ways.
      LIVE RUN THROUGH THE REAL APP — the whole S-DECKGATE loop:
      `task review obligations: ["deck"]` ·
      `close BEFORE a deck exists: todo` (refused, the task did not move) ·
      `archived files: ["t-evidence-52-2026-08-28T08-03-09-101Z.html"]` ·
      `artifacts.deck: odeon/decks/t-evidence-52-…html` ·
      `deck bytes: 3111 | escaped: true` ·
      `filed via outbox: true` (the agent never wrote `odeon/`) ·
      `close AFTER the deck exists: done` ·
      `after a REVISED deck: [...101Z.html, ...180Z.html]` · `odeon:decks() sees: 2`.
      Viewer live run: `odeon.decks(): ["t-evidence-52b"]` ·
      `odeon.deck(ref) bytes: 3076` · `traversal refused: true` ·
      `comment queued to: agent.artemis` ·
      `artemis received: {"from":"agent.odeon","to":"agent.artemis",`
      `"act":"request","subject":"review comment on t-evidence-52b"}` ·
      `tasks after the comment: 1 (unchanged: the ledger is hers)` — UC-05 step 4
      routes the comment to the orchestrator and never mints a task itself.
      *Screenshot: [m5-decks-tab.png](demo/m5-decks-tab.png) — the archive listed,
      a deck selected, and the comment box that routes to the orchestrator. The
      deck itself is exported at [m5-deck-artifact.html](demo/m5-deck-artifact.html),
      because `capturePage()` cannot composite the sandboxed viewer frame.*
- [x] **M5.3 Memo policy engine + queues + verdict routing** — FR-7.3,
      §7.3, S-MEMO: policy triggers (new dependency, public API/schema
      change, security posture, spend) enforced at the existing gate layer —
      the matching action is held until a memo exists and is verdict-ed; memo
      schema per SDD §4.5 (`memo.md` structured body + `verdict.json`,
      schemaVersion + validators); flow: agent files memo (outbox, like
      everything else) → Artemis triage — **`mayDecide`'s first production
      caller** (delegated classes: decide + countersign; else the Architect
      queue with badge) → verdict returns as a Hermes message → memo archives
      immutably; a rejected memo reverses the held action.
      *Docs: ADR-0008 §3, SDD §4.5, §7.3, FR-7.3, UC-06. Tests: trigger
      matching table-driven; delegated vs escalated split; countersignature
      recorded on every delegated verdict (FR-5.5); rejection reverses;
      archive immutable; S-MEMO per TEST-STRATEGY §3. Risk: memo-policy
      granularity is the tuning knob (ADR-0008 consequence) — defaults stay
      the four documented triggers, no invented ones.*
      *Evidence: `typecheck && lint && check-invariants` green; 68 new cases
      (`test/shared/memo.test.ts` 50, `test/main/memo.test.ts` 18); full suite
      1654 passed / 6 skipped, with only the 10 known Windows-local failures
      (real-process spawns into git worktrees + one POSIX-path fixture) that
      CI on Linux does not have.
      **The hold IS a Watch gate**: a matching action opens an ordinary gate
      carrying `memoTrigger`, and the memo’s verdict settles it — one hold
      mechanism, one queue, one release path. The four documented triggers and
      no fifth, asserted table-driven in both directions (10 held paths, 4 held
      commands, 4 ordinary paths and an ordinary command let through, the spend
      threshold at and below, a moved threshold, Windows separators, case, and
      the double-match order).
      **`mayDecide`’s first production caller is closed** (the carried item):
      triage routes a filed memo to the orchestrator when the authority table
      grants it and to the Architect queue otherwise, deny-by-default in every
      ambiguous case.
      **The harness writes the countersignature; the decider never claims it** —
      `verdictFilingSchema` carries only `memoId`/`verdict`/`notes`, and a
      filing that tries to set `decidedBy`, `countersigned` or `authority` is
      refused as an unknown field (three cases). `memoVerdictSchema` itself
      refuses a delegated verdict with no countersignature or no named grant, so
      FR-5.5 cannot be bypassed by any code path.
      LIVE RUN THROUGH THE REAL APP, the escalated bench end to end:
      `ordinary edit trigger: null` · `package.json trigger: new-dependency` ·
      `gate: g-… | kind: scope-change | memoTrigger: new-dependency` ·
      `worker notified: memo required: new-dependency` ·
      `notice names the gate: true` ·
      `memos archived: ["m-2026-08-28-09-36-32-093-9113"]` ·
      `memo.md has all five sections: true` ·
      `triage: {"kind":"memo","event":"escalated","because":"no delegated
      authority for memo/new-dependency"}` · `open queue: 1` ·
      `verdict: denied` ·
      `verdict.json: {"verdict":"rejected","decidedBy":"architect",
      "countersigned":false,"authority":null}` ·
      `gate after rejection: settled` · `worker told: memo …: rejected` ·
      `told not to retry: true` ·
      `second verdict: memo … already carries a verdict`.
      A REJECTED MEMO REVERSED THE HELD ACTION, which is ADR-0008’s own clause.
      LIVE RUN, the delegated bench, with one grant seeded in `authority.json`:
      `triage: {"event":"delegated","to":"agent.artemis","under":
      "memo:new-dependency"}` · the orchestrator settled it through the endpoint
      and the harness wrote
      `verdict.json: {"verdict":"approved","decidedBy":"agent.artemis",
      "countersigned":true,"authority":"memo:new-dependency"}` ·
      `gate released: settled` · `second verdict refused: … already carries a
      verdict`. **FR-5.5’s countersignature is recorded on the delegated verdict,
      written by the harness rather than claimed by the decider.**
      *Screenshot: [m5-memos-tab.png](demo/m5-memos-tab.png) — one memo awaiting a
      verdict with its body rendered and the three verdict buttons, and one already
      decided, shown as "approved by architect".*
- [x] **M5.4 Briefing compiler + Briefs tab** — FR-7.1, §7.2, S-BRIEF: the
      compiler assembles *facts* from Agora data only — ledger deltas, log
      events, budget deltas, open gates/memos since the last brief — each
      fact carrying source refs (log seq / task id / memo id); Artemis
      renders facts → narrative under a template that forbids unref'd claims;
      artifact `odeon/briefs/<ts>.md` (+refs, immutable); the scheduler gains
      the standup trigger (its second client); the Briefs tab renders the
      card (the Herald speaks it in M6 — card only here).
      *Docs: ADR-0008 §1, FR-7.1, SDD §7.2, UC-04. Tests: every narrative
      sentence carries a resolvable ref (S-BRIEF's core, incl. the ≤90 s at
      configured wpm length budget as word-count math); facts-only compiler
      pure and table-driven; seeded fixtures → deterministic fact set. Risk:
      the compiler is mechanism (facts), Artemis is intelligence (prose) —
      never let the harness write narrative or Artemis invent facts.*
      *Evidence: `typecheck && lint && check-invariants` green; 46 new cases
      (`test/shared/brief.test.ts` 27, `test/main/briefing.test.ts` 19); full
      suite 1700 passed / 6 skipped, only the known Windows-local failures.
      **The direction is enforced, not asked for**: `compileFacts` is pure and
      writes no prose, the narration comes back as mail, and `checkNarrative`
      refuses the WHOLE brief when any sentence cites a ref no fact issued —
      an invented citation being worse than none, because it looks checked.
      Three distinct failures are asserted (a sentence with no ref, a sentence
      citing an unissued fact, a narration over budget) plus the case that
      proves the check is not vacuous: the same over-long text passes when the
      budget is raised, so the length check is about length and not the words.
      The ≤ 90 s budget (SRS §6.2) is word-count math at VOICE-DESIGN’s 150 wpm,
      checkable before the Herald exists. The compiler is deterministic, emits
      sections in the documented running order, groups completions past three,
      and NEVER truncates `blocked` (7 gates in, 7 facts out).
      The scheduler gained its second client (`standup`).
      LIVE RUN THROUGH THE REAL APP — the standup cycle end to end:
      `facts compiled: 3` ·
      `fact refs: ["gate:g-…","gate:g-…","task:t-evidence-54"]` ·
      `brief asked: b-2026-08-28T09-56-05-597Z-5727` ·
      `asked by: agent.odeon | standup b-…: narrate these facts` ·
      `after an unsupported sentence: 0 brief(s) archived` ·
      `refusal named the citation: true` ·
      then the SAME window re-narrated on issued facts:
      `archived: ["2026-08-28T09-56-05-678Z.md"]` ·
      `every sentence carries refs: true` ·
      `has a source-ref appendix: true` · `odeon:briefs() sees: 1` ·
      `standup settled: true`.
      **The live run caught a real defect**: `archiveBrief` settled the
      outstanding ask unconditionally, so a refusal closed the question and the
      corrected narration was rejected as answering a brief nobody asked for —
      the refusal was terminal and the retry impossible. Fixed by moving the
      rule out of the wiring into `BriefingJob.narrated(briefId, accepted)`,
      with two regression tests named after the bug.
      *Screenshot: [m5-briefs-tab.png](demo/m5-briefs-tab.png) — an archived brief
      with every sentence carrying its refs inline and the Source-refs appendix
      beneath, which is S-BRIEF made visible.*
- [x] **M5.5 Meeting driver + the Odeon room** — FR-7.4, UC-07, S-MEETING:
      convene (attendees + agenda line); Artemis chairs; turn order enforced
      by the driver — attendees receive the floor via Hermes `query` one at a
      time, replies stream into the meeting panel; Architect interjection
      grabs the floor; on close, minutes + action items written to the
      blackboard (via the ledger endpoint — one scribe) and the ledger;
      minutes at `odeon/minutes/<meetingId>.md`, immutable; the Odeon room on
      the floor with attendee avatars gathering (SDD §6 station `odeon`,
      already in the station map).
      *Docs: ADR-0008 §4, FR-7.4, UC-07, UI-DESIGN §5. Tests: turn-order
      enforcement (an out-of-turn reply is held, not lost), interjection
      floor-grab, minutes/actions land via the endpoint, avatars gather;
      S-MEETING per TEST-STRATEGY §3 (3 fakes). Risk: the driver enforces
      order mechanically; the chair's judgment (who answers what) stays
      Artemis's.*
      *Evidence: `typecheck && lint && check-invariants` green; 41 new cases
      (`test/shared/meeting.test.ts` 21, `test/main/meeting.test.ts` 16, plus 4
      routing cases); full suite 1745 passed / 6 skipped, only the known
      Windows-local failures.
      **An out-of-turn reply is HELD, not lost** — and holding pays out: a
      table drives three agents answering at once and asserts the transcript
      drains in ATTENDEE order, not arrival order, with nothing left held. A
      non-attendee is REFUSED rather than held, because somebody outside the
      meeting has no turn coming.
      The driver asks ONLY the floor-holder, as a `query` (which ADR-0003
      obligates a reply to), and asks nobody at all while a reply is held.
      **A test caught a stall**: the floor was handed out only when the holder
      changed, so a drain that wrapped the floor back to the same agent left
      nobody asked and the meeting stopped with a full transcript. The floor is
      now handed out after every accepted turn.
      LIVE RUN THROUGH THE REAL APP — a three-agent meeting end to end:
      `convened: mt-2026-08-28t10-13-37-261z-fbdc` · `floor: agent.a` ·
      `asked so far — a: 1 b: 0 c: 0` (turn order enforced, not suggested) ·
      b and c answered from their own outboxes out of turn →
      `held (said early): [agent.b, agent.c]` with
      `transcript so far: [human]` ·
      then a answered and the held replies were released:
      `transcript after the round: [human, agent.a, agent.b, agent.c]` ·
      `still held: 0` ·
      `after interjection, floor: agent.b` (the Architect grabbed it and handed
      it on) · `stranger: {"kind":"refused","reason":"\"agent.zzz\" is not in
      meeting …"}` ·
      `closed: odeon/minutes/mt-….md` ·
      `minutes have the transcript: true` · `minutes have the action item: true` ·
      **`actions went to the scribe, not to tasks.json: 0 task(s); 1 message(s)
      to the orchestrator`** — FR-4.2’s single scribe intact.
      *Screenshot: [m5-odeon-meeting.png](demo/m5-odeon-meeting.png) — a live
      meeting with the floor at `agent.scribe`, and **"Said early — waiting for the
      floor (1)"** showing `agent.tess`’s held reply: the claim that an out-of-turn
      answer is held rather than lost, on screen.*
- [x] **M5.6 Org layer v1 + the retro report** — FR-11.5 (v1 slice): the org
      chart (from the registry — Artemis at the temple, workers by role);
      hire templates as versioned files (`profiles/`-adjacent per SDD §4.1
      `hire` refs) with a validator; per-agent metrics computed from
      `log.jsonl` + the cost ledger only (tasks done, rework, escalation
      rate, budget efficiency) into `metrics_rollup` (SDD §4.6); the
      scheduled weekly **retro report** generated from those metrics + memo/
      gate/breaker patterns — the exit criterion's "real retro report".
      *Docs: FR-11.5, SDD §4.6, UC-12. Tests: metrics derived only from the
      book of record (invariant §11's spirit — no in-memory counters);
      template versioning; retro report's every claim ref'd like a brief.
      Risk: metrics are per-agent judgments — compute mechanically, let the
      org review (UC-12 full loop, M7-era) interpret; no auto-actions.*
      *Evidence: `typecheck && lint && check-invariants` green; 31 new cases
      (`test/shared/org.test.ts` 24, `test/main/org.test.ts` 7); full suite 1776
      passed / 6 skipped, only the known Windows-local failures.
      **No counter exists anywhere in the org layer** — every figure is folded
      from `log.jsonl` plus the durable cost fold on each read, which is
      invariant §11 applied a second time. Tests feed a log and a spend fold and
      assert the numbers that come out; there is nothing to poke.
      An agent that did nothing appears with zeroes rather than being omitted,
      and a rate with no completed task is NULL rather than 0 — zero would say
      "perfectly efficient" about an agent that finished nothing.
      Attribution reads `agentId`, `assignee`, `by` and `from`, because the
      log’s kinds carry the agent differently and reading one would under-count
      gates and escalations.
      LIVE RUN THROUGH THE REAL APP, on real records:
      `org chart: [{"agentId":"agent.artemis","role":"orchestrator","seat":"temple",
      "orchestrator":true},{"agentId":"agent.mason","role":"engineer",…}]` ·
      `metrics: [{"agentId":"agent.artemis","tasksDone":0,…,"escalationRate":null},
      {"agentId":"agent.mason","tasksDone":1,"rework":1,"escalations":2,
      "escalationRate":2,…}]` ·
      `findings: ["the breaker tripped 1 time(s)","1 memo(s) needed the Architect",
      "agent.mason had 1 piece(s) of work handed back"]` ·
      `every finding carries refs: true` ·
      `retro archived: odeon/retros/2026-08-28T10-30-15-433Z.md` ·
      `has a metrics table: true` · `says nothing was decided: true` ·
      `second generate refused: true`. The archived report ends with a
      "What was decided / Nothing." section — the layer computes and archives,
      and UC-12 keeps a human between the numbers and any action.
      *Screenshot: [m5-org-metrics.png](demo/m5-org-metrics.png) — the chart with
      Artemis at the temple, the metrics table (note the `—` where a rate has no
      completed task to divide by), the findings with their log refs, and the
      archived retro.*
- [x] **M5.7 Gymnasium v1** — ADR-0015, SDD §7.6, FR-12: `gymnasium.ts` —
      proposal validation (a proposal without a falsifiable metric or a
      rollback is invalid *by construction*, rejected pre-human), ledger
      accessors (`agora/gymnasium/LEDGER.md` append-only, seeded at first run
      from the repo's build-phase `docs/gymnasium/` archive — FR-12.6), gate
      classification per the ADR-0015 authority table (stricter wins;
      authority-widening proposals **mechanically refused regardless of
      approver** — FR-12.3), ~~metric-check scheduling (the scheduler's third
      client)~~ *(corrected at the M5 close-out audit: NOT delivered — measure
      is Architect-driven via `gym:metricResult`, the deferral this section's
      own carried list records; the scheduler's third client is the retro)*,
      rollback driver (`regressed` ⇒ roll back per the proposal);
      the `gym` IPC group per SDD §5 with **architect-only verdicts enforced
      in the handler** (Artemis may rank/pre-screen, never verdict); the
      standup brief gains its gym-slice section (extends M5.4); R3's budget
      slice reported in the brief.
      *Docs: ADR-0015 (normative), SDD §7.6, FR-12, UC-13. Tests: shape
      enforcement (no metric ⇒ rejected before any human), non-architect
      verdict refused at the handler, authority-widening refusal table,
      landed-proposal metric miss ⇒ rollback + `regressed` row, ledger rows
      append-only; S-GYM per TEST-STRATEGY §3. Risk: R1–R3 are the package —
      nothing self-approves, the ledger is total, the slice is budgeted.*
      *Evidence: `typecheck && lint && check-invariants` green; 54 new cases
      (`test/shared/gym.test.ts` 36, `test/main/gymnasium.test.ts` 18); full
      suite 1829 passed / 6 skipped, only the known Windows-local failures.
      **R1** — `GymDecider` has one inhabitant, `architect`; a table refuses a
      verdict from `agent.artemis`, `agent.mason`, `human` and `system`, and a
      proposer deciding their own proposal is refused separately.
      **R2** — the ledger is total: `append` THROWS if a write would ever shrink
      the row count, rejected rows are kept, and ids are never reused (a
      rejected GYM-003 still yields GYM-004).
      **R3** — proposals stop at the budget slice, so improvement can never
      starve the missions that pay for it.
      **Authority-widening is refused regardless of approver**: `checkWidening`
      takes no decider argument at all (asserted by its arity), and a 7-case
      table covers invariants, accepted ADRs, gym gating, the authority table,
      the gate policy, global maxima and the invariants tripwire — plus the
      case proving the check is not vacuous, and one proving it reads the
      rollback as well as the change.
      LIVE RUN THROUGH THE REAL APP, all three rules at once:
      `ledger seeded from the repo: true` (FR-12.6) ·
      `rows after a metric-less proposal: 0` (FR-12.2, refused before a human) ·
      `rows after a widening proposal: 0` with `widening logged: true` ·
      `filed: ["GYM-001:proposed"]` ·
      `artemis tries to approve: {"ok":false,"reason":"only the Architect may
      decide a Gymnasium proposal; \"agent.artemis\" may not (R1)"}` with
      `status after her attempt: proposed` ·
      `architect approves: {"ok":true,…}` · `lands: {"ok":true,…}` ·
      `unmeasurable ⇒ {"ok":true,"status":"regressed"}` with
      `rollback flagged: true` ·
      `final ledger: ["GYM-001:regressed"]` and
      `ledger keeps the row on disk: true`.
      Every word an agent reads lives in `prompts/gymnasium/` (invariant §8).
      *Screenshot: [m5-gymnasium.png](demo/m5-gymnasium.png) — GYM-001 landed and
      GYM-002 waiting, under the standing line that nothing self-approves. Only the
      proposed row offers APPROVE/REJECT.*
- [x] **M5.8 Scenario suites + exit demos + review** — S-DECKGATE, S-MEMO,
      S-BRIEF, S-MEETING, S-GYM (TEST-STRATEGY §3) as automated suites over
      the seams M5.1–M5.7 built; then the exit demos: a `review:deck` task
      refused `done` until its deck lands and the deck renders in-app; a
      policy-triggered memo held, triaged, verdict-ed both ways; a compiled
      brief whose every sentence resolves; a 3-agent meeting with enforced
      turns and minutes; **a real weekly retro report generated from this
      company's own records**.
      *Docs: TEST-STRATEGY §3, SRS §6.3/§6.4. Risk: suites per-PR on fakes;
      real-engine demos are exit-review territory.*
      *Evidence: `typecheck && lint && check-invariants` green; the five named
      suites run **55 cases green** —
      `npx vitest run test/scenarios/s-deckgate test/scenarios/s-memo`
      `test/scenarios/s-brief test/scenarios/s-meeting test/scenarios/s-gym`
      → 5 files, 55 passed (S-DECKGATE 7 · S-MEMO 11 · S-BRIEF 8 · S-MEETING 10 ·
      S-GYM 19). Full suite 1883 passed / 6 skipped.
      Every suite runs REAL spawned `fake-engine` processes filing from their
      OWN outboxes over the real router and real git, against the **shipped**
      endpoint dispatch: `src/main/odeon-endpoint.ts` was extracted so
      `index.ts` and the rig call one factory, which is the M2 close-out lesson
      applied before it could bite again.
      **The exit demos, run through the real app in one session:**
      `DEMO 1 close before the deck: todo` → `close after the deck: done` →
      `deck archived: odeon/decks/t-exit-01-….html` ·
      `DEMO 2 action held by: new-dependency` → `memo filed: m-…` →
      `rejection reverses the action: denied` ·
      `DEMO 3 brief archived: 2026-08-28T12-39-28-865Z.md` with
      `every sentence carries refs: true` ·
      `DEMO 4 floor: agent.mason` → `held (said early): [agent.scribe]` →
      `transcript after the round: [human, agent.mason, agent.scribe]` →
      `minutes: odeon/minutes/mt-….md` ·
      `DEMO 5 gym ledger: ["GYM-001:proposed"]` ·
      `DEMO 6 retro: odeon/retros/2026-08-28T12-39-28-982Z.md`.
      **The real weekly retro, generated from this company’s own records**, is
      archived at [docs/demo/m5-retro-report.md](demo/m5-retro-report.md):
      window `log#1–log#32`, `agent.mason | 1 | 0 | 2 | 2.00`, and two findings
      each citing a real log seq (`[log#16]`, `[log#14]`).
      **The exit demo caught a real defect**: the ledger endpoint’s `task` log
      row carried no `status`, so `computeMetrics` could never count a completed
      task from the book of record — every org unit test passed because every
      one synthesised the row it wanted. That is the seam-blindness class the M3
      and M4 audits named, caught this time by running the thing. Fixed, with a
      regression test that asserts the metric against a log the REAL endpoint
      produced.*
- [x] **M5 exit review** — S-DECKGATE, S-MEMO, S-BRIEF, S-MEETING, S-GYM
      green in CI; the real retro report; PROGRESS + docs synced.

### M5 exit review (2026-08-28) — verdict: DONE

Every criterion in IMPLEMENTATION M5 was verified **by running it**, against the
committed tree.

**Criterion 1 — "SRS §6.3 (deck) passes as S-DECKGATE."** MET. SRS §6.3 is the
review test: "a task flagged `review:deck` cannot close without its deck; the
deck renders in-app; a comment becomes a follow-up task." All three assert
green, and the live app run showed the whole loop:

```
DEMO 1 close before the deck: todo      ← refused; the task did not move
DEMO 1 close after the deck:  done
DEMO 1 deck archived: odeon/decks/t-exit-01-2026-08-28T12-39-28-722Z.html
```

The comment clause is asserted in the suite: it reaches the orchestrator as
mail and mints **no** task itself, because FR-4.2 gives the ledger one scribe.

**Criterion 2 — "SRS §6.4 (memo) passes as S-MEMO."** MET. §6.4 is the memo
test: "an agent adding a new npm dependency is blocked at the policy trigger
until a memo exists; Artemis-approved memos show its countersignature;
Architect rejection reverses the change." A REAL spawned agent really edits
`package.json`, the shipped choke point holds it, and both benches are
asserted — a delegated verdict carrying `countersigned: true` with its grant,
and an Architect rejection returning `denied`:

```
DEMO 2 action held by: new-dependency
DEMO 2 memo filed: m-2026-08-28-12-39-28-794-bf1f
DEMO 2 rejection reverses the action: denied
```

**Criterion 3 — "S-BRIEF passes."** MET. Every narrative sentence must carry a
ref that resolves to a fact the compiler issued; an invented citation refuses
the whole brief and archives nothing; the ≤ 90 s budget is word-count math at
VOICE-DESIGN's 150 wpm. `DEMO 3 every sentence carries refs: true`.

**Criterion 4 — "S-MEETING passes."** MET. Turn order is enforced, not
requested — the floor-holder alone is asked, an out-of-turn answer is HELD and
released in attendee order, and the minutes print what never reached the floor:

```
DEMO 4 floor: agent.mason
DEMO 4 held (said early): [ agent.scribe ]
DEMO 4 transcript after the round: [ human, agent.mason, agent.scribe ]
DEMO 4 minutes: odeon/minutes/mt-2026-08-28t12-39-28-876z-8495.md
```

**Criterion 5 — "a real weekly retro report generates."** MET, and archived at
[docs/demo/m5-retro-report.md](demo/m5-retro-report.md). Generated from **this
company's own records** in the exit-demo session — window `log#1–log#32`, every
figure folded from `log.jsonl` and the cost ledger, every finding citing a real
log seq:

```
| agent         | tasks done | rework | escalations | escalation rate |
| agent.artemis |          0 |      0 |           0 |               — |
| agent.mason   |          1 |      0 |           2 |            2.00 |

- 1 memo(s) were rejected [log#16]
- 1 memo(s) needed the Architect [log#14]
```

It ends with "What was decided / Nothing." — the layer computes and archives,
and UC-12 keeps a human between the numbers and any action.

**Criterion 6 — "S-GYM passes (proposal shape enforcement, architect-only
verdicts, mechanical refusal of authority-widening proposals, rollback on
regressed metric)."** MET, clause by clause: a proposal missing a metric,
rollback or evidence is rejected before any human sees it; a verdict from
`agent.artemis`, `agent.mason` or `human` is refused with the R1 reason while
the row stays `proposed`; four widening classes are refused *before a verdict
exists*, so no approver — the Architect included — can make one acceptable; and
an unmeasurable metric ledgers `regressed` with `rollback: true`.

**Gate:** `npm run typecheck` PASS · `npm run lint` PASS (zero warnings) ·
`node scripts/check-invariants.cjs` PASS · `node scripts/check-attribution.cjs`
PASS · the five suites **55 passed (55)** · full suite **1887 passed / 6
skipped**.

CI green on every M5 commit — runs 33152624246 (M5.1) · 33154688487 (M5.2) ·
33160420476 (M5.3) · 33161721415 (M5.4) · 33163021861 (M5.5) · 33163764115
(M5.6) · 33170534063 (M5.7) · 33172228794 (M5.8), all SUCCESS.

The verdict itself is closed on a CI-green tree: run **33172756433** on
`069b0bc` — docs integrity, typecheck·lint·test and commit attribution all
SUCCESS, with the five S-suites running green on Linux there.

**A gap the review itself found and closed.** IMPLEMENTATION M5 names "the
standup brief's gym-slice section" and FR-12.5 requires the slice reported in
briefings. `Gymnasium.slice()` existed but nothing put it in a brief. Closed
here: `compileFacts` emits a `health` fact refd `gym:slice` naming what the
slice has spent and how many proposals are open, wired in both `index.ts` and
the scenario rig, with two tests (one asserting a company without a Gymnasium
says nothing).

**Two defects were found by RUNNING the thing, not by reading it:**

1. *The briefing settled on refusal* (M5.4). `archiveBrief` closed the
   outstanding ask unconditionally, so a refused narration made the refusal
   terminal and the corrected one was rejected as answering a brief nobody had
   asked for. The rule moved out of the wiring into
   `BriefingJob.narrated(briefId, accepted)`, with two regression tests.
2. *Org metrics could not count a completed task* (M5.8, found by the exit
   demo). The ledger endpoint wrote no `status` on a `task` log row, so
   `computeMetrics` matched nothing in production — every unit test passed
   because every one synthesised the row it wanted. That is precisely the
   seam-blindness class the M3 and M4 audits named. Fixed, with a regression
   test that asserts the metric against a log the REAL endpoint produced.

**Both carried items are CLOSED**: the agent↔task binding join in M5.1 (proven
in the shipped app — `task.gates` written by the running harness for the first
time, `status → done` refused while a gate is open) and `mayDecide`'s first
production caller in M5.3 (memo triage, with the countersignature written by
the harness rather than claimed by the decider).

**Debt swept at close:** zero TODO/FIXME/HACK markers in
`src|shims|scripts|test|prompts`; every M5 package ticked with evidence.
The Odeon endpoint dispatch was extracted to `src/main/odeon-endpoint.ts` so
`index.ts` and the scenario rig call one factory — the M2 close-out lesson
applied before it could bite a second time.

**Recorded, not fixed (for the Architect):**
- ~~`src/shared/breaker.ts` contains two **literal NUL bytes**~~ — **FIXED**
  after the review, on `fix/breaker-nul-bytes`. The span key separator was a raw
  NUL in the source, so git classified a Watch-critical file as binary and
  `git diff` showed only `Bin … bytes`. Now written as `\u0000` escapes: the
  separator is the same character at runtime, the 82 breaker cases pass
  untouched, and the file diffs as text again.
- ~~Screenshots are owed for the six M5 panels~~ — **DELIVERED**, captured from
  the running app against a seeded temp home: `m5-briefs-tab.png`,
  `m5-decks-tab.png`, `m5-memos-tab.png`, `m5-odeon-meeting.png`,
  `m5-org-metrics.png`, `m5-gymnasium.png`. The Decks frame is blank in its
  capture: a `sandbox=""` iframe has an opaque origin and Chromium's
  `capturePage()` does not composite it. The viewer itself works — proven by a
  throwaway `allow-same-origin` run that rendered the deck in frame — and the
  sandbox was deliberately NOT loosened for a photograph. The archived deck is
  exported instead, at `m5-deck-artifact.html`.
- This machine runs 10 Windows-local test failures the reference platform does
  not (real-process spawns into git worktrees, one POSIX-path fixture, and one
  TZ-dependent case that passes under `TZ=UTC`). CI on Linux is green on every
  commit; recorded so the next Windows session does not read them as new.

**Carried into M6, recorded so they are not lost:**
- The Herald speaks the brief (FR-7.1 names speech, an in-app card and remote
  push; M5 built the card, and the artifact it will read from).
- `odeon:queue` pushes on memo and meeting changes, but no badge consumes it on
  the status strip yet — the panels poll.
- The Gymnasium schedules no metric check of its own: `measure()` is driven by
  the Architect through `gym:metricResult`. SDD §7.6 gives the scheduler that
  booking, and it belongs with the Herald-era scheduler work.



### M5 close-out audit (2026-08-28) — verdict: DONE, with audit fixes landed

Independent two-agent audit at milestone close, the M0–M4 pattern:

- **spec-verifier** (verification by execution): **M5 stands as DONE on its
  stated exit criteria.** Gate green (typecheck · zero-warning lint ·
  invariants · attribution over 110 commits) · the five M5 suites re-run
  **55/55**, the other ten **80/80** · all eight `docs/demo/m5-*` artifacts
  present and generator-consistent (the retro's `2.00` escalation rate is the
  row the M5.8 seam defect would have zeroed — the artifact is downstream of
  the fix) · zero debt markers · the merge-day ledger-parser fix proven
  **against the live archive** (shipped `parseLedger` bundled and run on
  `docs/gymnasium/LEDGER.md`: 5 rows, next id GYM-006) · CI green at `main`
  HEAD (33178239783). Local failures: the recorded environmental seven plus
  three pre-existing Windows/TZ portability defects the record was missing —
  now recorded (DECISIONS-LOG), none of them M5 code.
- **doc-guardian** (design conformance): **clean across the Odeon archive,
  memo machinery, R1 enforcement, routing seams, briefing, org layer, and all
  six renderer panels** — but one violation and twelve smaller findings.

**Findings FIXED at close (regression tests named; gate after fixes:
typecheck PASS · lint PASS · invariants PASS · the eight touched suites
175/175):**

1. **The Gymnasium ledger lost its Measured/Outcome columns on every rewrite**
   — `renderRow` emitted seven cells under the eight-column header, so a
   measured outcome read back null and the next `propose()` erased it from the
   file permanently. R2 ("the ledger is total") was mechanically false, one
   column left of where the merge-day fix had looked. `GymRow.measured` +
   eight-cell render + `measure()` date stamp; round-trip regression tests
   including against the real archive's `due 2026-09-11` rows.
2. **The memo-verdict endpoint carried prose literals** (invariant §8) — now
   `prompts/odeon/verdict-recorded*.md` / `verdict-refuse*.md`.
3. **The seed copied `LEDGER.md` without `proposals/`** — every inherited
   row's link was broken (SDD §2, FR-12.6). Both cross over now, tested.
4. **The brief narrated a constant gym-spend of 0 as data** — no production
   `gymSpend` source exists; `slice()` now reports null and the brief says
   "not yet attributed" (invariant §7). The attribution itself is a recorded
   deferral riding M6's scheduler work with the metric-check booking.
5. **`LOG_KINDS` omitted the ratified `memory` kind**; **the reserved-id
   spawn-refusal test covered two ids of five** — both closed.

**Recorded, not fixed (DECISIONS-LOG, with reasons):** the scenario rig's
missing `ledger:` mail option; the retro archive path + `orchestrator` kind
choice and the §4.6 `metrics_rollup` removal (SDD synced instead); the
ADR-0008 §4 minutes clause overtaken by M5.5's single-scribe decision (clause
note added to the ADR index — accepted ADRs are never edited); PROGRESS
M5.7's "metric-check scheduling" claim corrected in place (it contradicted
the section's own carried list).

## M5b — The Stoa + company modes (plan drafted 2026-08-28 at M5 close)

Derived per BUILD-PROMPT §5 from IMPLEMENTATION M5b + ADR-0017/0018 + SRS
FR-13/FR-14 + SDD §4.7/§7.7/§9 + TEST-STRATEGY S-STOA/S-MODE/E-STOA. Execute
in order; every package tests against the fake engine per-PR. The Architect's
2026-08-28 decision: the milestone also carries the floor-art intake (M5b.5) —
the LimeZu purchase (Modern Interiors + Modern Office Revamped) is made.

- [x] **M5b.1 Watchlist + `stoa.ts` core** — `agora/stoa/` layout (SDD §2);
      watchlist schema §4.7 (schemaVersion 1, strict, validators in
      `src/shared/`); accessors with **Architect-only mutation enforced in the
      handler** (the `gym.verdict` pattern — FR-13.1); seeding from the repo's
      `docs/stoa/` at first run (FR-13.7, the gymnasium-seed pattern —
      *including* `briefs/`, per the audit's finding-3 lesson); `stoa:` IPC
      group (`watchlist() register(entry) retire(id) briefs() brief(id)`);
      the Stoa panel v1 — the reading desk: paste a URL + tags, see the list.
      *Docs: ADR-0017, FR-13.1/13.7, SDD §4.7. Tests: validators table-driven;
      seeding; non-architect register/retire refused at the handler; UI stays
      a projection. Risk: the id/pin/license fields are the provenance chain —
      no field invented beyond §4.7.*
      *Evidence: 70/70 new cases green (`test/shared/stoa.test.ts` 43 —
      table-driven §4.7 schema incl. strict-reject of a smuggled
      `registeredBy`, seed-table reader, R1 refusals, studiable/intake gates;
      `test/main/stoa.test.ts` 27 — seeding, register/retire, damaged file,
      read-only archive surface). LIVE Electron run against a temp
      `EPH_HOME`: the STOA tab seeded 3 sources from `docs/stoa/WATCHLIST.md`
      and `RB-001` from `briefs/` in the SAME seed;
      `docs/demo/m5b-stoa-desk.png` shows `src-hermes-agent` refusing study
      ("no pinned commit … FR-13.2") and intake ("license is unverified …
      FR-13.5") while `src-munder-difflin` carries MIT @ `b91a49f`;
      `docs/demo/m5b-stoa-brief.png` shows RB-001 read back with its cited
      findings. The agora committed `stoa: seed the watchlist from the
      build-phase archive` through the single committer, tree clean, and
      `log.jsonl` carried the first-ever `kind:stoa` event
      (`event:seeded, sources:3, briefs:1`). Two doc gaps closed rather than
      guessed (DECISIONS-LOG): retirement is a `retired` sibling array — no
      entry field invented — and `pin` is nullable so an unpinned entry is
      registerable but NOT studiable; SDD §4.7 updated for both. The `stoa:`
      IPC group is exactly SDD §5's five channels (no `stoa:pin` — §7.7 puts
      pin-setting in M5b.2's study flow).*
- [x] **M5b.2 Researcher spawn + brief validation** — read-only study spawn
      plan: clone the pinned source into scratch (never a worktree of the
      Agora; no secret grants — NFR-17, enforced in the plan builder);
      research prompt from `prompts/stoa/` incl. the injection rule (content
      is data — invariant §13); brief shape validation (uncited finding ⇒
      rejected pre-human, FR-13.3); immutable brief archive; every transition
      a `log.jsonl` `kind: stoa` event (listed in SDD §4.3 and `LOG_KINDS` at
      the M5 close-out precisely so this package's first emitter finds its
      kind documented, not invented — the audit's finding-11 class).
      *Docs: ADR-0017 R2/R3, FR-13.2/13.3, SDD §7.7, NFR-17. Tests: S-STOA
      per TEST-STRATEGY §3 (planted pattern cited; planted instruction
      reported-not-obeyed; unverified license refuses intake; no-secrets
      spawn plan asserted). Risk: the adversarial case is the package.*
      *Evidence: S-STOA green 18/18 (`test/scenarios/s-stoa.test.ts`) against a
      fixture watchlist, every brief filed by a REAL spawned agent through the
      SHIPPED Odeon endpoint. Every TEST-STRATEGY clause has a case: the plan
      carries `envGrants: []` and `readOnly: true`, checks out OUTSIDE the
      Agora and `worktrees/`, and scopes its question to the entry's tags; an
      unpinned source is refused visibly (`study-refused` on the log) rather
      than skipped; an unverified license studies but reports
      `intakePermitted: false`; an uncited finding is refused before any human
      sees it, in words from `prompts/` naming FR-13.3; a brief citing an
      unpinned commit, a dangling applicability ref, or an unregistered source
      is refused; the archive is write-once. The adversarial clause is asserted
      as "there is no path", not "the agent behaved": a researcher that TRIES
      to obey the planted instruction gets its brief refused and the watchlist
      is provably unchanged. 31 further unit cases in
      `test/shared/stoa-brief.test.ts`. Prompt-rendered instructions carry the
      injection rule from `prompts/stoa/study.md` (asserted, incl. the
      intake-permitted/refused split). Local full suite 2040 passed; the 13
      failures are the documented Windows worktree/PTY + TZ set and load-flakes
      that pass in isolation — verified against the clean baseline, no
      regressions. The endpoint now takes SIX filings; `kind:'research-brief'`
      because `brief` is the standup narration's (DECISIONS-LOG).*
- [x] **M5b.3 Company modes + proof gate** — `config.json` mode field
      (`directed`/`improving`); `gym.mode()/setMode(m)` architect-verified in
      the handler; first-enable proof-gate check reading ONLY the gym ledger +
      log (SRS §6.9 numbers verbatim); scheduler consults the mode before the
      ~~Stoa/Gymnasium cadences~~ Stoa cadence *(corrected at the close-out
      audit: only a Stoa cadence trigger exists — the gym cadence is M7's per
      IMPLEMENTATION)* fires; mode tag on autonomous records (FR-14.1);
      status-strip mode chip; breaker rung-3 auto-revert (FR-14.5).
      *Docs: ADR-0018 (normative), FR-14, SDD §9. Tests: S-MODE per
      TEST-STRATEGY §3 — premature enable refused listing missing evidence;
      fixture ledger meeting §6.9 enables; no agent-side path can set the
      mode; auto-revert lands on the ledger. Risk: the gate reads the book of
      record, never a computed cache (invariant §11's spirit).*
      *Evidence: S-MODE green 13/13 (`test/scenarios/s-mode.test.ts`), with the
      passing ledger BUILT by driving the shipped endpoint and verdict path —
      three proposals through proposed → verdict → landed → measured, two
      validated, one citing `RB-001` — so the gate reads a ledger the company
      actually produced. Every clause covered: an empty ledger refuses listing
      what is missing; two-through-the-loop still refuses; four non-architect
      actors are refused on a PASSING ledger; no filing at the Odeon reaches the
      mode at all; the Stoa cadence does not fire in `directed` and its record
      carries `mode: improving` when it does (FR-14.1); a rung-3 revert lands on
      the ledger document attributed to `breaker` and preserves `everEnabled` so
      restoring is not a re-proof. 45 unit cases (`test/shared/mode.test.ts` 32,
      `test/main/modes.test.ts` 13) + 2 scheduler-gate cases + 3 ledger
      regressions. **Latent defect found and fixed:** `Gymnasium.append()`
      deleted everything below its table, so FR-14.5's mode section would have
      vanished at the next proposal — the M5 close-out finding-1 class one row
      further down (DECISIONS-LOG). Local suite 2104 passed; the 12 failures are
      the documented Windows worktree/PTY + TZ set and load-flakes.*
- [x] **M5b.4 Brief → proposal flow + E-STOA** — Artemis's ranking playbook
      (`prompts/`), proposals citing brief ids in evidence refs (FR-13.4), the
      standup brief's gym-slice section folds the Stoa in (FR-13.6); E-STOA
      eval per TEST-STRATEGY §6 over the fixture source.
      *Docs: ADR-0017, FR-13.4/13.6, UC-14 step 5. Tests: proposal-citing
      shape; brief-fact refs resolve; E-STOA fixture run recorded. Risk:
      Artemis ranks — the harness never files a proposal itself (ADR-0005).*
      *Evidence: the chain is real end-to-end — a brief archived through the
      shipped endpoint, a proposal citing it accepted, and a proposal citing
      `RB-404` REFUSED with the id named (S-STOA now 20/20). The link is the
      citation itself: `citedBriefIds` reads the evidence refs, the Gymnasium
      refuses ids not in the archive, and the `proposed` log event carries them
      so the proof gate counts Stoa-seeded proposals from the log alone.
      Artemis's ranking playbook is `prompts/stoa/rank.md` (rank, never decide;
      cite the brief; keep the internal evidence; file fewer than you found).
      FR-13.6: the standup's gym-slice section now reports sources watched and
      briefs archived, plus the company mode (FR-14.1) — omitted rather than
      zeroed when there is no Stoa (3 cases in `test/shared/brief.test.ts`).
      E-STOA: `test/fixtures/stoa-source/` carries two planted patterns, noise
      (a roadmap), and a planted injection; `test/evals/e-stoa.ts` scores a
      brief against them and `e-stoa.test.ts` (15/15) asserts the RUBRIC
      discriminates — a good brief passes, and uncited / noise-only / obeyed /
      silently-ignored each fail it. Local suite 2124 passed; the 12 failures
      are the documented Windows worktree/PTY + TZ set and load-flakes (the one
      unfamiliar name passed in isolation).*
      *Owed to a real-engine session (recorded, never faked): E-STOA's
      LLM-judged half — "is this applicability mapping honest?" and "does the
      prose match the file it cites?" — needs a rubric-scoring model over a
      real researcher run. The deterministic half runs in CI today.*
- [x] **M5b.5 Floor art intake (the purchased packs)** — drop the LimeZu
      **Modern Interiors v41.4** and **Modern Office Revamped** 16×16 sheets
      into the gitignored tileset drop; author their `*.tiles.json` layout
      maps (validated by `src/shared/tileset.ts`); retire the interim Kenney
      staging; `ATTRIBUTION.md` rows (licence terms + the required credit
      link) and the status-strip credit; §7 bar re-verified: 2× integer scale,
      pixel-snap, ≤8 colors per screen via the palette pass; floor screenshot
      to `docs/demo/`.
      *Docs: UI-DESIGN §7, ATTRIBUTION.md rules. Tests: token/contrast checks
      stay green; tile-map validator on both packs; scene-state assertions
      unchanged (art is presentation). Risk: the sheets NEVER enter the repo
      (licence forbids redistribution of the asset itself); characters stay
      *Evidence: the floor paints from the purchased pack —
      `docs/demo/m5b-floor-limezu.png` is a live Electron capture showing
      LimeZu walls, a cream/marble floor, tan paths and an indigo temple block,
      with the required credit on the status strip: `tileset: LimeZu Modern
      Interiors (Room Builder 16x16) — LimeZu — limezu.itch.io`. Two sheets in
      the gitignored drop (`Room_Builder_16x16` and the office
      `Room_Builder_Office_16x16`); the furniture sheets were extracted, found
      to be unmapped, and DELETED rather than left for `import.meta.glob` to
      bundle. Frame indices were measured, not guessed: candidates scored by
      colour variance + opacity, then each rendered back from its own index and
      tiled 3x3 to prove both the arithmetic and the seam (DECISIONS-LOG). The
      first mapping paired cream with mint and read as a chessboard; re-mapped
      to warm near-neighbours with indigo reserved for the temple, which is
      §1's ≤8-colour bar honoured rather than merely claimed. Kenney staging
      retired; ATTRIBUTION carries both LimeZu rows with the real licence terms
      (use yes, redistribute no, credit required), an exact restore path, and
      the do-not-use list (free tier, RPG-Maker build, and the character
      generator that is never run — rule 3). `*.tiles.json` is now committed
      while the sheets stay ignored, so the restore path is reproducible.
      `test/renderer/tileset.test.ts` ~~36/36~~ 33-or-35 depending on whether
      the local drop holds the sheets *(corrected at the close-out audit — the
      exit review's own drop-guard numbers, re-reproduced there)*, including a
      new block that
      validates the REAL drop when present — frame bounds, columns, integer
      scale, sheet existence — and is inert in CI where the drop is empty.
      Local suite 2136 passed with exactly the 9 documented Windows
      worktree/PTY + TZ failures and no flakes.*
      *Note for the build-state block: the interiors download is named by its
      itch slug (`moderninteriors-win.zip`), not "v41.4" as BUILD-PROMPT's note
      assumed — recorded in ATTRIBUTION's restore path.*
      procedural (rule 3).*
- [x] **M5b.6 Scenario suites + exit review** — S-STOA and S-MODE green in CI;
      E-STOA recorded; then the exit demo: **one real research cycle through
      the app** — a URL registered on the reading desk, a study producing an
      archived provenance-valid brief, and a GYM proposal citing it in the
      Architect's queue (IMPLEMENTATION M5b exit; SRS §6.8 as S-STOA, §6.9 as
      S-MODE). The proof gate itself is *met later by operation* — this
      milestone builds the machinery that will measure it.
      *Evidence: S-STOA green in CI (run 33186729216) and S-MODE green in CI
      (run 33188310155), both on ubuntu where the Windows worktree/PTY failures
      do not apply; E-STOA recorded (15/15, deterministic half). **The exit
      demo ran through the app**, end to end, on a fresh home:
      `docs/demo/m5b-cycle-1-registered.png` — a URL typed into the real
      reading desk and registered by clicking REGISTER (real inputs, real IPC,
      nothing written by the harness): `src-opencode-sdk-js`, MIT, pinned
      `9f3c1de`. `docs/demo/m5b-cycle-2-brief.png` — the study's brief archived
      as **RB-002**, with `log.jsonl` recording
      `brief-archived {findings: 2, directivesReported: 1}`: both findings
      cited, and the source's instruction to its reader REPORTED rather than
      obeyed. The artifact itself is exported to
      `docs/demo/m5b-cycle-brief-RB-002.md`.
      `docs/demo/m5b-cycle-3-proposal.png` — **GYM-006** waiting in the
      Architect's queue, with `gym proposed {briefs: ['RB-002']}` on the log:
      the citation link, machine-checkable. The brief and the proposal arrived
      as files in a real agent outbox, so Hermes, the Odeon endpoint, the Stoa
      archive and the Gymnasium each ran their SHIPPED path; only the
      researcher's engine is stood in for. The router refused three malformed
      attempts on the way (bad id, missing `needs_human`, `requires_reply:
      false` on a `propose` — ADR-0003's obligation table), each parked in
      `outbox/.rejected/` with its reason.*
      *Two defects found BY the demo and fixed (DECISIONS-LOG): the reading
      desk had no pin field, so every source registered from it was
      permanently unstudiable — M5b.1 deferred pin-setting to M5b.2 and M5b.2
      built a `plan()` that only reads it; and the proof gate read every
      SEEDED ledger row as a gating violation, which — a violation being
      absorbing — made `improving` unopenable on any company that inherited a
      build-phase archive. Every unit test had passed because each synthesised
      the log it wanted; only the running app read the real seeded ledger
      beside a real fresh log.*
- [x] **M5b exit review** — S-STOA + S-MODE green in CI; the real research
      cycle evidence; PROGRESS + docs synced.

### M5b exit review (2026-08-28) — verdict: DONE

Every exit criterion verified **by execution**, not by inspection.

| Criterion | How it was proved |
|---|---|
| S-STOA green in CI | run 33186729216 (ubuntu), 18 cases; 20 after M5b.4 added the brief-citing pair |
| S-MODE green in CI | run 33188310155 (ubuntu), 13 cases |
| E-STOA recorded | 15/15 — the rubric's own discrimination test, over `test/fixtures/stoa-source/` |
| One real research cycle through the app | ~~the three `docs/demo/m5b-cycle-*.png` captures + the archived `RB-002` + `GYM-006` on the ledger citing it~~ **AMENDED at the close-out audit:** the original demo was machinery-real but **source-fake beyond its disclosed stand-in** — pin `9f3c1de` does not exist in the repository the watchlist named, and the GYM-006↔RB-002 pairing survived in no artifact ("on the ledger" was inaccurate: it was in the queue of an ephemeral home). The row is satisfied by the close-out re-run against a REAL pin instead: [`m5b-cycle-real-source.txt`](demo/m5b-cycle-real-source.txt) — munder-difflin @ `b91a49f`, verified remotely (`gh api`) and locally in-run, register → plan → brief → citing proposal through the shipped path, the pairing in the log |
| PROGRESS + docs synced | this file, DECISIONS-LOG, SDD §2/§4.7/§9, ATTRIBUTION, and `docs/implementations/2026-08-28-m5b-stoa-and-modes.md` |
| The INTEGRATED stack green in CI | run **33192290049** on `feature/m5b-6-suites-exit` — all six packages plus the drop-guard fix, on ubuntu |

**Four defects found by running the thing, all fixed in-milestone:**

1. `Gymnasium.append()` deleted everything below its table (M5b.3) — FR-14.5's
   mode section would have vanished at the next proposal.
2. The reading desk had no pin field (M5b.6) — every source registered from it
   was permanently unstudiable. M5b.1 deferred pin-setting to M5b.2; M5b.2
   built a `plan()` that only reads it. Neither package owned it.
3. The proof gate read every SEEDED ledger row as a gating violation (M5b.6) —
   and a violation is absorbing, so `improving` could never be enabled on any
   company that inherited a build-phase archive. Every unit test passed because
   each synthesised the log it wanted.

4. The drop-validation block guarded every check on "a map exists" (M5b.6) —
   committing the maps meant CI had maps and, correctly, no sheets, so the two
   checks that open a PNG failed on ubuntu while passing locally. Found by CI
   on the push, fixed, and verified both ways: 33 cases with the sheets moved
   aside, 35 with them present.

The first three are the seam-blindness class the M3, M4 and M5 audits each found a
different way: correct halves that only disagree when the running system puts
them side by side. The M5b answer was the same one that worked before — run the
demo, and believe the demo over the suite.

**Carried, unchanged:** the 2026-09-11 metric sweep (GYM-002/003/004 ledger
checks + GYM-003's live-quit evidence run) did **not** fall inside this run —
today is 2026-08-28 — so it is carried to the next milestone window rather than
booked here. GYM-001's own check is due 2026-09-25.

**Owed to a real-engine session (recorded, never faked):** E-STOA's LLM-judged
half; a study whose checkout and pin are recorded by the researcher rather than
typed by the Architect (the "pin before study" path, which still has no
implementation — the desk's pin field is the Architect's route, not the study's).


**Standing due-dates to carry:** the 2026-09-11 metric sweep (GYM-002/003/004
ledger checks + GYM-003's live-quit evidence run) falls inside this
milestone's window — book it in the exit review if unmeasured by then.

### M5b close-out audit (2026-08-29) — verdict: DONE, with the record amended and audit fixes landed

Independent two-agent audit at milestone close, the M0–M5 pattern:

- **spec-verifier** (verification by execution): the machinery half VERIFIED —
  gate green (attribution over 121 commits) · S-STOA 20 / S-MODE 13 / E-STOA 15
  exactly as recorded · 194 M5b cases green together · all full-suite failures
  classified into the recorded environmental set, every extra green in
  isolation · three of four in-milestone defect regressions named and passing ·
  intake clean (sheets ignored, maps committed, ATTRIBUTION complete) · CI
  green on `ed46cad`. **But the "one real research cycle" exit row was
  NOT verified as written:** the demo's pin `9f3c1de` exists in no repository
  the watchlist named, the cited path is another repo's layout, and the
  GYM-006↔RB-002 pairing survived in no artifact. The disclosed stand-in
  covered the engine, not the source.
- **doc-guardian** (design conformance): **no invariant violations** — R1/R2/R3
  enforced mechanically, §6.9 verbatim and pinned, atomic/append-only/tokens
  clean, art intake fully conformant, characters procedural — plus five
  deviations and a tail of contained/nit findings, listed below.

**The record is amended, and the row re-proven** (evidence integrity is the
audit's first duty to itself): the exit-review row now says what the original
demo was, and the cycle was re-run at close against a REAL source — munder-
difflin @ `b91a49f`, verified on GitHub and against a local clone inside the
run — through the same shipped path, captured to
[`docs/demo/m5b-cycle-real-source.txt`](demo/m5b-cycle-real-source.txt).

**Findings FIXED at close (regression tests named; gate after fixes: typecheck
PASS · lint PASS · invariants PASS · touched suites 113/113):**

1. **`Stoa.brief(id)` skipped first-run seeding** — a fresh home whose first
   Stoa-touching action was a proposal citing a seeded brief false-refused it
   (the M5 audit's half-seeded-seam class, one method over). Seeds like
   `briefs()` now; first-call regression test.
2. **The cadence trigger's body was exercised by nothing** — S-MODE and the
   scheduler suite each rebuilt it inline (the rig's own copy-of-the-wiring
   defect class). Extracted to `stoa-cadence.ts`; the suites and `index.ts`
   run the same shipped tick, which also logs `sourceId`/`planned` asserted
   end-to-end.
3. **The FR-14.5 role heuristic was an untested substring test in `index.ts`**
   — `includes('improv')` would have reverted the mode over a stop on a
   mission hire named "process-improver-docs". Now `isImprovementRole` in
   `shared/mode.ts`: exact roles from ADR-0019's vocabulary, table-tested with
   the audit's own counter-example.
4. **`stoaWatchlist` leaked `registeredBy` past the view type** — field-picked
   projection now; the response is the `SourceView` and nothing more.
5. **SDD drift corrected:** §7.7's proof-gate location (modes.ts, not
   watch/gates.ts) + the cadence-heartbeat build-state note (an autonomous
   no-op must not read as work); §1.1 gains the `modes.ts` row;
   ATTRIBUTION's drop section no longer lists the committed maps as
   gitignored; M5b.3's "cadences" plural and M5b.5's "36/36" corrected in
   place above.

**Recorded, not fixed (DECISIONS-LOG, with reasons):** FR-14.1's mode tag
rides one record type until M7 gives it more autonomous acts to tag; the §6.9
`stoaSeeded` count reads log events only (a seeded archive under-counts — the
strict direction, waitable); Stoa spend attribution owed beside the gym-spend
deferral (M6.7); no path advances a pin yet ("Architect advances it" needs a
`stoa:pin` channel or the study-recorded pin — both on the owed list);
`prompts/stoa/rank.md`/`study-refused.md` are loaded by nothing until the
Artemis-ranking leg lands; the plan's `question` line is serialization-plus-
connective (invariant-§8-adjacent); the reading-desk pin fix has no renderer
regression test (no DOM harness exists — owed with M6.1's renderer work).

## M6 — The floor's face + the Herald (plan drafted 2026-08-29 at M5b close)

Derived per BUILD-PROMPT §5 from IMPLEMENTATION M6 + ADR-0007 + SDD §8 +
VOICE-DESIGN + UI-DESIGN v2 (§5.1–§5.7, §9 — landed at this close-out) +
TEST-STRATEGY §3/§4/§5. **Art first** (Architect decision 2026-08-29): the
company's face reaches the licensed-art bar before the voice lands. Execute in
order; every package tests against the fake engine per-PR.

- [x] **M6.1 Citizens v2 — the MD-grade procedural sprite** — implement
      UI-DESIGN §5.1 (anatomy, 8 drawn directions, 4-frame cycles, stepped
      ±1 px bob phased to the 250 ms tile walk) and §5.2 (status overlays as
      pure projections of the SDD §6 avatar states). Role silhouettes per the
      §5.1 table; `terracotta` stays Artemis-reserved. Characters remain
      procedural — ATTRIBUTION rule 3 untouched (Architect decision
      2026-08-29, the licensed-character alternative offered and declined).
      Owed from the M5b audit: the reading desk gets its first renderer-side
      regression coverage with whatever DOM/harness this package establishes.
      *Docs: UI-DESIGN §5.1/§5.2, SDD §6. Tests: state→overlay table total
      over every avatar state; ≤5 colors per direction/frame/role; silhouette
      distinctness; determinism; bob sampled at frame boundaries only. Risk:
      overlays are projections — none may own a timer-driven opinion.*
      **Done 2026-08-29** (`feature/m6-1-citizens-v2`). `citizen.ts` rewritten to
      §5.1: the M1 mirror table is GONE — eight authored views, each with its own
      head/torso/arm/leg geometry, `propSide` for shoulder-worn props and
      `hairSide` for the skull mass, so a westward direction is drawn, not
      flipped. 4 frames at `FRAME_MS = 125` (= 2 frames per the 250 ms tile,
      asserted against `MS_PER_TILE`); ±1 px bob indexed by frame, never by a
      clock; rows 0–7 clear at every bob phase; feet planted in 44–47. New
      `floor/overlay.ts` = §5.2, total over all ten §6 states plus both
      terminals, frame chosen by `nowMs − snapshot.sinceMs` so the overlay owns
      no timer (NFR-13 spirit); `ghost` 50 % opacity now read from that table
      rather than a literal `0.45`. **The live render found what the suite could
      not:** the first sprite passed all 20 cases and dissolved into the floor
      (`skin` = `sand` = `worldTerraceA`) — fixed with a 1 px ink silhouette
      backing and a redrawn anatomy (hairline, neck, hem, sleeve+hand).
      *Evidence:* `docs/demo/m6-1-citizens-v2.svg`, rendered from the shipped
      modules; `npm run dev` booted the real app (floor + LimeZu tileset live).
      *Tests:* `test/renderer/citizen.test.ts` 20 · `test/renderer/overlay.test.ts`
      14 · `test/renderer/stoa-panel.test.tsx` 11 — 91 green across
      `test/renderer/`. Both new regressions were MUTATION-CHECKED: reintroducing
      the runtime flip fails the anti-flip case, and re-hard-coding `pin: null`
      fails the pin case. *Owed item closed:* the reading desk's first
      renderer-side regression, on a `react-dom/server` static-markup harness
      that adds no dependency (a jsdom upgrade for interaction coverage is a
      must-ask in the session report, not taken here).
- [x] **M6.2 Stations & furnishings v2** — the §5.4 catalog from the purchased
      LimeZu maps (states idle/in-use/highlighted; the desk inbox-tray flag IS
      `pendingMailCount` made visible; the Watch brazier IS an open gate; the
      Odeon fills when a meeting gathers) + §5.7 furnishings as place
      identity, static, riding the `*.tiles.json` maps.
      *Docs: UI-DESIGN §5.4/§5.7, SDD §6 stations. Tests: station-state model
      pure and event-driven; tray-flag parity with `pendingMailCount`;
      brazier parity with open gates; map validation on the compositions.
      Risk: a station that animates without an event-plane fact is invented
      motion.*
      **Done 2026-08-29** (`feature/m6-2-stations`). `shared/stations.ts` is the
      §5.4 state model: `stationView()` cannot return anything but `idle`
      without also returning the `because` — the event-plane fact, in words —
      so "no station animates on a timer alone" is enforced by the return type
      rather than by discipline, and `stationCensus()` is the same facts as §8
      text. The three named facts are wired to the things they are: the tray
      flag IS `pendingMailCount` (new on `AvatarUpdate`, from ONE source in
      main that also feeds the autonomy loop and the `avatars:list` handler);
      the brazier IS `watch.approvals().length`; the Odeon fills one bench per
      attendee. `floorPlan()` now claims each station's whole FOOTPRINT — the
      Odeon was 96×64 in the document and 32×32 on the floor until this
      package. Compositions (§5.4) and furnishings (§5.7) are optional
      `*.tiles.json` fields validated against the catalog, so a pack swap never
      touches code and CI validates them with no sheets present.
      **The live floor found what the suite could not, again:** with footprints
      landed the painter still painted per tile, so a 64×32 desk came out as
      two desks (a row of them read as one slab) and a 2×2 station showed four
      markers — fixed by giving `PlanCell` a `part`. *Evidence:*
      `docs/demo/m6-2-stations.svg`, painted by the shipped painter and station
      art with real facts injected (1 gate open → brazier lit; desks 1–3 hold
      mail → flags up); `npm run dev` floor verified live, structures reading
      as structures, zero console errors. *Tests:* `test/shared/stations.test.ts`
      24 · `test/renderer/station-art.test.ts` 17 · `avatars:list` seam case in
      `test/main/ipc-handlers.test.ts` — 188 green across the touched suites.
      The seam case is MUTATION-CHECKED: dropping `pendingMail` from the
      listing path fails it.
- [x] **M6.3 Messaging & motion vfx** — §5.3 carrying tokens (keyed by tool
      CLASS, dropped with the 3-frame fade), §5.5 envelope flights
      (act-colored, 400 ms stepped arc, divert turns toward the temple,
      bounce wobbles), §5.6's three budgeted particles, §8 reduced-motion
      parity for all of it.
      *Docs: UI-DESIGN §5.3/§5.5/§5.6, §6 additions. Tests: pure vfx reducers;
      the reduced-motion information-parity suite covers envelope→tray-flash
      and walk→teleport; token↔tool-class table total. Risk: no vfx state
      `log.jsonl` cannot reconstruct (NFR-13 spirit).*
      **Done 2026-08-29** (`feature/m6-3-vfx`). `shared/vfx.ts` is the model:
      §5.3 tokens keyed by tool CLASS and total over `ToolClass` (the class is
      recovered from the station a citizen leaves, so the floor never learns a
      tool NAME — a regression checks that no Claude-ism resolves to a token);
      §5.5 envelopes built from LOG ENTRIES, identity from `msgId`, colour from
      `act`, start from `ts`, with the hop-cap divert turning to the temple at
      the halfway step and a bounce wobbling in wine; §5.6's three systems and
      a test that there is no fourth; §8 parity asserted as EQUALITY between
      `envelopeInfo(f)` and `reduceEnvelope(f).info`, not as the presence of a
      label. Reduced motion reads `prefers-reduced-motion`, live.
      **The seam is tested by running it:** `test/main/vfx-seam.test.ts`
      delivers real mail through the real Hermes into a real `log.jsonl` and
      asks the model what flies — and the mutation shows why it exists, since
      renaming Hermes's `msgId` leaves the 24-case unit suite fully green while
      three seam cases fail. *Evidence:* `docs/demo/m6-3-vfx.svg` (tokens,
      the 3-frame fade, an envelope per act, bounce/divert/broadcast, the
      stepped arc with the temple turn, the three particles, and the parity
      lines) rendered from the shipped modules; `npm run dev` floor live, zero
      console errors, the canvas label now reading both census halves.
      *Tests:* `test/shared/vfx.test.ts` 24 · `test/main/vfx-seam.test.ts` 6 —
      2237 passed overall.
- [x] **M6.4 Herald seam + policy** — ADR-0007's surface exactly: `seam.ts`
      (SpeechToText / TextToSpeech / DuplexVoice), `policy.ts` (PTT always;
      barge-in ≤ 250 ms; repeat-back for destructive/spend; failover
      healthy→degraded→cooldown).
      *Docs: ADR-0007 (normative), SDD §8, FR-8.1/8.3. Tests: voice
      conformance over recorded fixtures (TEST-STRATEGY §5); policy pure.
      Risk: transcribe the ADR interface, don't extend it (the M1.1 lesson).*
      **Done 2026-08-29** (`feature/m6-4-herald-seam`). `herald/seam.ts` is
      ADR-0007's three interfaces and nothing else — and carries no
      `shouldFailover`, `retry` or provider preference, which the conformance
      suite asserts by name: adapters classify a fault and hand it up, the
      policy decides. `herald/policy.ts` holds the four safety behaviours:
      push-to-talk always available (FR-8.3), barge-in unconditional at 250 ms
      keeping the unspoken remainder, repeat-back whose TOKEN is derived from
      the gate while the SENTENCE lives in `prompts/herald/phrasebook.md`
      (invariant §8 — a test greps the policy source for spoken prose), and a
      one-way failover machine (healthy→degraded→cooldown, manual failback,
      stale faults ignored). Persona and phrase book landed under
      `prompts/herald/`; FR-8.5's homage-not-clone clause is asserted.
      *Tests:* `test/main/herald-policy.test.ts` 24 · the conformance harness
      `test/conformance/voice-conformance.ts` run over both providers'
      RECORDED fixtures (`test/fixtures/voice/*.json` — real error shapes and
      measured latencies, no key, no network, and a case asserting no
      secret-shaped string got into a recording) via
      `test/fakes/fake-voice.ts`, 20 cases. The fake ships BEFORE the adapters
      for the M1.2 reason: a suite authored beside its first adapter agrees
      with it by construction. Two mutation checks: making a bare "yes"
      approve a destructive gate fails the FR-8.4 case; letting a stale fault
      through fails two failover cases. 2281 passed overall.
- [x] **M6.5 ElevenLabs adapter + persona** — streaming STT, cancelable
      streamed TTS; persona/phrase book as `prompts/herald/*` per VOICE-DESIGN
      (invariant §8).
      *Docs: ADR-0007, VOICE-DESIGN, FR-8.1/8.5. Tests: adapter conformance on
      fixtures; the §5 tripwire keeps key reads inside herald/. Risk: keys via
      the broker only; absent keys = visible text-only degradation.*
      **Done 2026-08-29** (`feature/m6-5-elevenlabs`). Provider SDKs added on
      an ARCHITECT-APPROVED must-ask (the alternative was hand-rolling two
      streaming protocols with no key here to verify either). The adapter is a
      dumb pipe: streaming TTS with cancel, streaming STT whose endpointing
      stays the provider's, an error taxonomy (401/403 → auth, 5xx → transient,
      timeout → latency-breach), and no method through which it could decide
      anything about failover. `spokenSoFar()` is a MEASUREMENT — the SDK's
      character alignment, not a 150-wpm estimate — so VOICE-DESIGN §2's
      "unspoken from here" mark is a fact. A missing key is a visible
      degradation (`health()` reports `auth`, `speak()` refuses by name), and
      the key arrives through an injected getter: `check-invariants.cjs`
      permits `process.env` under `herald/`, so a test strips comments and
      asserts the code does not use the permission. Voice id and model ids load
      from `prompts/herald/*.md`, asserted absent from the adapter source.
      **Two findings landed with it:** my own M6.4 seam was incomplete —
      ADR-0007 says "streamed audio" and there was no sink, found by writing
      the first adapter against it — and the voice-SDK lint tripwire was a
      false positive on our own `herald/elevenlabs.ts` (gitignore glob
      semantics), fixed and then verified in BOTH directions.
      *Tests:* `test/main/herald-elevenlabs.test.ts` 23 · the conformance suite
      now runs the SHIPPED adapter beside the fixture fakes, 28 cases, with
      cancel latency measured on the real cancel path. 2311 passed overall.
- [x] **M6.6 OpenAI Realtime adapter + failover** — duplex fallback;
      mid-session failover ≤ 3 s with the one-line notice (FR-8.2); both down
      → text-only banner, zero non-audio loss (FR-8.6).
      *Docs: ADR-0007, FR-8.2/8.6, SDD §7.4. Tests: scripted S-FAILOVER
      halves; the budget on fixture clocks. Risk: failover is the POLICY's
      decision — adapters report health, never decide.*
      **Done 2026-08-29** (`feature/m6-6-realtime-failover`). The Realtime
      adapter implements `DuplexVoice` and only that — it does not fake TTS to
      look complete, because ADR-0007 assigns the mapping to the policy layer,
      where `HeraldSession.speakWith` now holds it. `session.ts` is where the
      two halves meet: the policy decides (an adapter throws a classified
      fault, `reduceFailover` says what happens), failover is mid-utterance and
      CONTINUOUS (the fallback speaks the remainder), and every line reaches the
      transcript whether or not audio carried it — FR-8.6's "functions fully in
      text" as a guarantee rather than a banner.
      **S-FAILOVER is green** (`test/scenarios/s-failover.test.ts`, 11 cases)
      and runs the SHIPPED adapters and reducer, not a rig's copy: scripted
      failure mid-utterance → Realtime continues inside the 3 s budget on a
      fixture clock with one notice; all three fault classes fail over; no
      self-failback after an hour; both down → text-only with the phrase-book
      banner and zero non-audio loss.
      **A defect the first green suite hid:** the mid-utterance failure was
      losing what ElevenLabs HAD said, so the fallback re-spoke the whole line
      — and every case still passed, because "the whole line reached the
      transcript" is true either way. The suite was asserting the wrong half of
      "continuous". Fixed, and the case now asserts what the fallback was ASKED
      to say; mutation-checked. 2320 passed overall.
- [x] **M6.7 The spoken company + carried items** — briefings spoken from the
      SAME archived artifact the card shows; voice approvals with repeat-back;
      meeting narration; optional local wake word. Closes the carried items:
      the `odeon:queue` status-strip badge; **gym metric-check scheduling**
      (SDD §7.6's booking); **gym-spend + Stoa-spend attribution** (the
      honest-null from the M5/M5b close-outs gains its real source) — all on
      this package's scheduler work.
      *Docs: FR-7.1, FR-8.4, SDD §7.2/§7.6. Tests: brief-read-not-recompiled;
      repeat-back required for destructive/spend; metric check booked on
      `landed`; `slice()` reports a number again with its source named. Risk:
      the Herald narrates records — an invented sentence is the E-BRIEF-FAITH
      failure.*
      **Done 2026-08-29** (`feature/m6-7-spoken-company`). `herald/narration.ts`
      parses the ARCHIVE — `narrationOf(markdown)` reads the sentences back out
      of the artifact the Briefs card shows, so no path exists by which a
      sentence absent from the archive could be spoken (E-BRIEF-FAITH made
      structural, not trusted); the `## Source refs` appendix is excluded as
      audit trail rather than narration. Voice approvals require the token for
      destructive AND spend even when the gate itself did not ask, and a
      refusal returns the line to say while leaving the gate open. Meeting
      narration splits chair announcements (always) from replies (on request).
      **All three carried items closed.** (1) `gym-cadence.ts` is SDD §7.6's
      missing arrow: the tick raises every landed row whose window has closed,
      on the record with its declared metric — it does not measure, because
      booking a check and deciding what the number was are different jobs.
      (2) `shared/attribution.ts` gives `slice()` a real number and a NAMED
      source, folded from the durable ledger (invariant §11) by exact role;
      ~~the brief prints both~~ *(**CORRECTED at the close-out audit — the brief
      printed only the number.** `slice()` emitted `source`; `BriefInput.gymSlice`
      read `spendSource`; nothing set it, so the true branch in `brief.ts` was
      dead code and this carried item was half closed. Object spread bypassed
      excess-property checking, and both halves had passing tests because none
      spanned the seam. Fixed on `fix/m6-closeout-audit` with a regression that
      drives the real slice into the real compiler.)* (3) The `odeon:queue` push
      is finally consumed above the panels:
      a `memos:` badge on the status strip, driven by the push AND the slow
      poll, with `null`/`'error'`/`0` distinct so an unknown count never reads
      as reassurance.
      *Owed, not faked:* the wake word is a SETTING (`config.wakeWordEnabled`,
      FR-8.3) and not a detector — no local wake-word engine is an approved
      dependency, and one that only pretended to listen would be worse than the
      gap. Push-to-talk is unaffected.
      *Evidence:* `npm run dev` — the `memos:` badge is live on the strip
      beside `gates:`, in the unread state with no bridge, which is the
      invariant §7 behaviour the test pins. *Tests:*
      `test/main/herald-narration.test.ts` 14 · `test/main/carried-items.test.ts`
      ~~15~~ **16** *(corrected at the close-out audit: M6.8 added the GYM-003
      note case and narrated it without updating the count above it)* ·
      `test/renderer/status-strip.test.tsx` 4. 2357 passed overall.
- [x] **M6.8 Suites + exit review** — S-FAILOVER green in CI; ~~SRS §6.2 (spoken
      standup ≤ 90 s, every claim traceable) and §6.5 (key pulled
      mid-conversation → Realtime continues ≤ 3 s) demonstrated live; a floor
      screenshot at the v2 bar beside the M5b one~~; **book the 2026-09-11
      metric sweep** (GYM-002/003/004 + GYM-003's live-quit evidence — it
      falls inside this milestone's window; GYM-001's check is due
      2026-09-25). *(**AMENDED at the close-out audit.** The struck clauses were
      ticked and are not met: §6.2 and §6.5 were never demonstrated live, as the
      exit review's own prose said four lines below this box; and the owed floor
      SCREENSHOT does not exist — the only M6 floor artifact is a procedural
      SVG, which is honest evidence of a different kind. The metric-sweep
      booking, the one clause that was genuinely done, stands.)*
- [x] **M6 exit review** — ~~SRS §6.2 + §6.5 live; S-FAILOVER scripted pass~~;
      the v2 floor evidence; PROGRESS + docs synced. **UNTICKED at the close-out
      audit (2026-08-29)**, when two of the three criteria in
      `docs/IMPLEMENTATION.md` proved unmet and the third had never been
      addressed. **RE-TICKED 2026-08-30 against AMENDED criteria** (Architect
      decision: close M6 when every test and conformance suite passes). M6.9
      stays deferred, so the three live-voice clauses were unreachable by
      construction; IMPLEMENTATION's M6 exit now reads as the mechanical bar,
      and **SRS §6.2 / §6.5 / the voice-driven day are NOT satisfied — they are
      unchanged v1 acceptance criteria, owed, and attached to M6.9.** The
      milestone closed; the voice subsystem was not demonstrated, and this
      record says so.
- [ ] **M6.9 Wire the Herald into the application** — **DEFERRED INDEFINITELY by
      Architect decision (2026-08-30): the Herald is not an important function
      for now.** Deferred, not cancelled and not descoped — the finding stands
      exactly as the close-out audit recorded it, and this package is the fix
      whenever the Architect calls for it. Nothing here is lost: the seam,
      policy, adapters, session and narration are all built, tested and
      conforming; they simply have no caller.
      **Consequence, recorded rather than absorbed:** all three of M6's exit
      criteria in `docs/IMPLEMENTATION.md` are voice-live, so while this is
      deferred M6 cannot close on its criteria as written. How M6 closes is an
      open Architect decision (see the deferral note under the close-out audit).
      ~~until it is taken, **M6.10 is the only remaining M6 work**~~ **M6.10
      landed 2026-08-30, so no M6 work remains at all** — the milestone now waits
      on that one decision and on nothing else.
      *Original scope, unchanged and still owed:* the subsystem M6.4–M6.7 built
      has NO production caller: 1 406 lines under `src/main/herald/`
      imported only by tests, no IPC channel, no preload surface, no
      construction in `index.ts`, no UI. Register SDD §5's `herald` IPC group
      (`pttStart`/`pttStop`/`speakBrief`/`config`) and the `herald:transcript`
      push; construct both adapters in `index.ts` with `apiKey()` bound to the
      ADR-0010 broker; add the Herald state chip to the UI-DESIGN §4 status
      strip (no keys / healthy / degraded+provider / cooldown); give
      `HeraldSession` the barge-in entry point ADR-0007 calls sacred, which
      today has no caller either.
      *Docs: SDD §5 + §8, ADR-0007, UI-DESIGN §4, VOICE-DESIGN §6, FR-8.3/8.4,
      invariant §3.7. Tests: the IPC group's validated round-trip; a build with
      NO key renders a visible text-only state rather than nothing (§3.7); a
      barge-in cancels the live handle within 250 ms and the transcript keeps
      the remainder; the shipped Realtime adapter joins the conformance suite,
      which its own comment has promised since M6.6. Risk: the seam is clean —
      wire it without teaching the adapters anything about failover.*
- [x] **M6.10 Close the false guarantees** — the adversarial pass ran 22
      mutations against M6's recorded claims and 18 survived. Each survivor is
      a test that cannot fail when the thing it protects breaks: the
      E-BRIEF-FAITH property asserted against one hard-coded archive (an
      invented summary, a punctuation rewrite and the appendix rule all
      survive); `stationView` sampled over no clock, so a station may animate
      on a timer; the overlay frame and the walk bob both accepting `Date.now()`;
      "never learns a tool NAME" as a six-name blocklist; reduced-motion parity
      asserted as a tautology (`reduceEnvelope` returns `envelopeInfo` — the
      equality cannot fail) AND unimplemented in the renderer, where the walk
      path has no reduced-motion branch and `FloorCanvas` overwrites the log
      entry's timestamp with a wall clock.
      *Docs: UI-DESIGN §5.2/§5.3/§5.5/§5.6/§8, TEST-STRATEGY §5. Tests: parity
      restated independently of the function under test; a property test over
      generated archives for E-BRIEF-FAITH; a `check-invariants` tripwire
      banning `Date.now`/`setInterval` under `renderer/src/floor/` outside
      `FloorCanvas.tsx`; `deliverFromHarness` joins the vfx seam. Risk: fixing
      the TEST without fixing the renderer would make the guarantee more
      convincing and no more true.*
      **Done 2026-08-30** (`feature/m6-10-false-guarantees`), in the audit's
      three groups. **A — three REAL renderer defects**, not weak tests: §8's
      walk→teleport had no renderer branch at all (`reduceWalk` was never
      imported by `FloorCanvas`); the tray flash computed `reduceEnvelope(…).info`
      and dropped it; and `vfx.ts` promised "replay the log and the same
      envelopes fly at the same moments" while the renderer re-anchored every
      flight. The first two now land their labels on the census behind the canvas
      `aria-label` — the floor's declared parity surface, ONE surface because two
      cannot drift (Architect decision 2026-08-30) — through a new pure
      `floor/parity.ts`. The third was the COMMENT's fault: a flight lasts
      400 ms, so a delivery observed later than that would arrive already
      finished and never be seen. The contract now says replay is faithful
      because `envelopePose` is pure in `startedMs`, while the live floor anchors
      at observation and every FACT still comes from the record — ADR-0014 holds.
      **B — six guarantees that could not fail.** E-BRIEF-FAITH was asserted
      against ONE hard-coded archive and is now a property over generated ones
      (verbatim, AND the count); the `## Source refs` exclusion turned out to be
      dead code, so its case writes the appendix as plain sentences, which is
      what makes the exclusion load-bearing. `StationView` became a discriminated
      union whose live arms carry a branded `StationReason` — `reasonFor('')` no
      longer compiles, and weakening the field back to `string` fails
      `npm run typecheck` with an unused-`@ts-expect-error`. `stationView` is
      sampled across an hour. A `check-invariants` tripwire bans `Date.now`/
      `new Date`/`setInterval`/`requestAnimationFrame` under
      `src/renderer/src/floor/` outside `FloorCanvas.tsx`, comments exempt for
      that rule alone — a tripwire that fired on its own rationale would teach
      the next author to delete the rationale. The tool-NAME ban and the
      invariant-§8 prose check were a six-name and a three-string blocklist;
      both are structural now.
      **C — the coverage gaps.** Continuity was asserted on one fault class, and
      `auth` — the class SRS §6.5 names in as many words — was not it; every
      class now asserts the fallback was asked for the REMAINDER. `failoverMs`
      was `!= null && <= 3000`, which cannot tell a measurement from a zero: it
      is asserted exactly, with a new case advancing past the budget to prove a
      slow switch can fail it. `deliverFromHarness` joined the vfx seam. And the
      renderer half of §5.4's facts, which had **no test of any kind**, got both
      halves of the Architect's "both": the fold moved into a pure
      `floor/facts.ts` (the component's three refs became one `FloorState`), and
      `jsdom@^26` landed dev-only on an approved must-ask so `FloorCanvas` is
      mounted for real — pinned to 26 because 30 cannot start a vitest worker on
      this toolchain's Node 20.
      *Every fix mutation-checked with the audit's OWN mutations.* The
      re-speak-on-auth, the zeroed `failoverMs`, the harness `msgId` rename, the
      phase-derived tray flag, the carried-maximum brazier, the timer-driven
      station, the tool-name alias table, the symmetric parity gut and all three
      E-BRIEF-FAITH mutations now fail. *Tests:* `test/renderer/parity.test.ts` 8
      · `test/renderer/facts.test.ts` 10 · `test/renderer/floor-canvas.test.tsx`
      3 (jsdom) · strengthened cases in `stations` (+5), `vfx`, `vfx-seam` (+2),
      `s-failover` (+1), `herald-narration` (+4), `herald-policy`, `tileset`.

### M6 exit review (2026-08-29) — verdict: ~~DONE, with two live proofs OWED~~ **SUPERSEDED by the close-out audit below**

> **Read the close-out audit first.** This review was written by the session
> that built M6 and its framing did not survive independent verification. Its
> central claim — that the two live voice proofs were owed because no
> `ELEVENLABS_API_KEY` was present — is wrong in a way that matters: there is no
> path by which a key could reach an adapter, because the Herald has no
> production caller at all. The review is kept verbatim below, unedited, because
> the record of what a session believed at the time is part of the audit trail.

Every criterion below was checked **by execution**, not by reading the diff.

**S-FAILOVER — GREEN.** `test/scenarios/s-failover.test.ts` 11/11 locally and in
CI on `feature/m6-6-realtime-failover` (and every branch after it). It runs the
SHIPPED adapters, reducer and session — scripted ElevenLabs failure mid-utterance
→ Realtime continues inside the 3 s budget on a fixture clock with exactly one
notice; all three fault classes fail over; no self-failback after an hour; both
down → text-only with the phrase-book banner and zero non-audio loss.

**CI green on every M6 branch**: m6-1 · m6-2 · m6-3 · m6-4 · m6-5 · m6-6 · m6-7,
each confirmed on the pushed head SHA, not assumed.

**The floor at the v2 bar.** Three levels of evidence, each labelled for what it
is:
- the REAL Electron app, live: the v2 floor with stations at their §5.4 sizes,
  §5.7 furnishings and the LimeZu credit on the status strip (M6.2/M6.7 runs);
- the SHIPPED `FloorCanvas` rendering six citizens with role silhouettes,
  §5.2 overlays, §8 badges, desk tray flags, the Watch brazier lit by an open
  gate and the Odeon filled by a meeting of three — captured live in the browser
  through a scratch harness page that stubbed only the bridge;
- [`docs/demo/m6-floor-v2.svg`](demo/m6-floor-v2.svg), the same floor rendered
  from the shipped modules and COMMITTED. It paints procedurally on purpose:
  committed evidence must not depend on the licensed sheets (the drop rule).
- **OWED:** the same floor with a REAL company on it — real agents, real
  engine — needs a session with an engine binary. Recorded, not faked.

**SRS §6.2 (the standup test) — HALF VERIFIED, half owed.** The traceability
half is mechanical and green: `checkNarrative` already refuses any sentence
whose refs no fact supports, `speakBrief` reads the ARCHIVED artifact and can
speak nothing else (`test/main/herald-narration.test.ts` asserts every spoken
string is verbatim in the archive), and the ≤ 90 s budget is computed by
`spokenSeconds` and asserted. **OWED:** the brief spoken ALOUD by a real
provider — there is no `ELEVENLABS_API_KEY` in this environment.

**SRS §6.5 (the failover test) — SCRIPTED GREEN, live owed.** S-FAILOVER covers
it end to end on the shipped path. **OWED:** pulling a real key mid-conversation.
Neither owed proof was simulated and called live.

**The 2026-09-11 GYM sweep is BOOKED — and booking it found two defects.**
`gym-cadence.ts` now books what SDD §7.6 always said the scheduler books. Run
against the REAL `docs/gymnasium/LEDGER.md` rather than rows a test wrote for
itself, it raised only GYM-002 and GYM-004:
1. **GYM-003 was never bookable.** Its Measured cell reads `due 2026-09-11
   (live-quit evidence owed with the metric check)`, and the anchored match
   skipped it — so the one row the M6 window singles out was the one row that
   would never have been raised. Match relaxed; regression added naming the real
   cell.
2. **GYM-001 carried no due date where the scheduler reads.** Its window
   (2026-09-25) lived only in the metric prose; its Measured cell was `—`. The
   ledger now records `due 2026-09-25`.
Re-verified after both fixes: **2026-09-11 raises GYM-002, GYM-003, GYM-004**;
2026-09-25 additionally raises GYM-001. GYM-003's live-quit evidence rides its
row's note, so the sweep carries the obligation with it.

**Windows-local baseline unchanged:** 9 deterministic failures (agent-worktree 4,
s-crash 3, claude-transcripts 1, cost 1) plus parallel-load flakes that pass in
isolation. Ubuntu CI is the gate, and it is green.

**Owed to a local session (recorded, never faked):** the two live voice proofs
above; the v2 floor with a real company; wake-word DETECTION (the setting ships,
the detector does not — no local engine is an approved dependency); and the
jsdom question for interaction coverage on the renderer harness.

### M6 close-out audit (2026-08-29) — verdict: **M6 art DONE; M6 Herald BUILT BUT NOT INTEGRATED. Milestone REOPENED.**

Three independent audits at milestone close, on the Architect's instruction —
the two-agent pattern M0–M5b used, plus an adversarial third that attacks the
record's claims by mutation rather than reading them.

- **spec-verifier** (verification by execution): ran every owed suite, the gate,
  the CI history, the GYM sweep against the real ledger, and re-derived all four
  committed demo SVGs from today's source.
- **doc-guardian** (design conformance): the M6 diff `e2eb397..8f1ddf0` against
  UI-DESIGN v2 §5.1–§5.7/§8, ADR-0007, VOICE-DESIGN, SDD §5/§8, and the
  BUILD-PROMPT §3 invariants.
- **adversarial pass** (mutation, in an isolated worktree): 22 mutations against
  the record's strongest claims. **Four were caught. Eighteen survived.**

All three converged on the same headline, which no single reading had found.

#### The headline: the Herald has no production caller

`src/main/herald/` is 1 406 lines across seven modules — seam, policy,
phrasebook, both adapters, session, narration — and **every importer is a test
file.**

```
$ grep -rn "herald/" src/ --include=*.ts --include=*.tsx | grep -v "^src/main/herald/"
(no output)
$ grep -cin "herald" src/main/index.ts src/main/ipc.ts src/preload/index.ts
src/main/index.ts:0
src/main/ipc.ts:0
src/preload/index.ts:0
```

No IPC channel, no preload surface, no construction, no UI affordance.
`speakBrief`, `voiceApprovalAsk`, `checkVoiceApproval`, `meetingLines` and
`activeModes` are never called outside tests. SDD §5's `herald` IPC group does
not exist; the one mention in `src/shared/ipc.ts` is a comment describing paths
that were never built. UI-DESIGN §4's status strip has no Herald state.
ADR-0007's "barge-in is sacred" has no implementation path — `policy.bargeIn()`
is a pure calculator nothing calls, and `HeraldSession` exposes no cancel.

The consequence for the record: M6.7 is titled "The spoken company" and
IMPLEMENTATION scopes M6 as "spoken briefings + voice approvals + meeting
narration". Those are **library capabilities** here, not company capabilities.
The exit review disclosed the two live-provider proofs as owed; it did not
disclose that no key could have reached a provider.

#### The exit criteria: 0 of 3, against a ticked box

`docs/IMPLEMENTATION.md` is authoritative: *"SRS §6.2 standup test and §6.5
failover test pass **live**; S-FAILOVER passes scripted; **a full day driven by
voice without touching the keyboard for status**."*

| Criterion | Recorded | Verified |
|---|---|---|
| S-FAILOVER scripted | ticked | **MET** — 11/11, shipped adapters, CI green |
| §6.2 + §6.5 **live** | ticked "demonstrated live" | **NOT MET** — the review's own prose four lines below the box says both are owed |
| a full day driven by voice | — | **NOT MET, and never mentioned anywhere in the review** |

Two boxes asserted what the prose beneath them retracted. BUILD-PROMPT §5: never
start N+1 while N's exit criteria fail. **M6 is reopened**; M6.9 and M6.10 close
it.

#### A live safety defect, proved by running it (FR-8.4)

Not a weak test — the shipped policy, at HEAD, before any mutation:

```
delete branch release/9        → "confirm delete branch release"
delete branch release/10       → "confirm delete branch release"   ← identical
raise the daily cap to $80     → "confirm raise the daily"
raise the daily cap to $8000   → "confirm raise the daily"         ← identical
checkRepeatBack("no, do not confirm delete branch release 9", …) → { confirmed: true }
```

Three defects in the one safety behaviour ADR-0007 says the policy layer exists
to hold. The token kept the gate's first three words, so gates differing only in
their tail shared one token and **a spend gate's amount was never in the words
approving it**. And `checkRepeatBack` matched by substring, so **a spoken
refusal — which necessarily quotes the token it refuses — approved the gate.**
There was no nonce and no expiry, so the same words approved indefinitely.

Fixed on `fix/m6-closeout-audit` at the Architect's direction (the strongest of
three options put as a §8.3 must-ask): whole-subject token, exact match, and a
single-use challenge that lapses after two minutes. FR-8.4 and VOICE-DESIGN §3
were amended with the change. Mutation-checked both ways.

#### Eighteen surviving mutations — the false-guarantee inventory

The adversarial pass is the finding this audit would not have had without it. A
suite that stays green when its subject breaks is worse than no suite, because
the record cites it as proof. Caught: the `avatars:list` seam case, the failover
continuity fix on the transient path, the Hermes `msgId` seam, asymmetric
reduced-motion parity. **Survived**, among others:

- an invented summary sentence appended to a spoken brief — E-BRIEF-FAITH is
  "structural" only against one hard-coded 3-sentence archive;
- a punctuation rewrite of a spoken sentence, and the `## Source refs`
  exclusion, which turns out to be dead code (the appendix is filtered by an
  unrelated bullet rule);
- a station animating on a wall clock — `stationView` is never sampled across
  time, and `because: ''` satisfies the type, so "enforced by the return type"
  is not true as written;
- the overlay frame and the walk bob both reading `Date.now()`;
- a tool-NAME→token alias table, since "never learns a tool name" is a six-name
  blocklist;
- reduced-motion parity, which is asserted as `reduceEnvelope(f).info ===
  envelopeInfo(f)` — a tautology, since `reduceEnvelope` returns exactly that.

And three over-claims found by reading rather than mutating: `FloorCanvas`
overwrites each envelope's log timestamp with a wall clock (contradicting
`vfx.ts`'s own "replay the log and the same envelopes fly at the same moments");
the reduced-motion tray flash drops the entire parity payload, so it renders
with no label; and `reduceWalk` is not imported by the renderer at all, so §8's
walk→teleport exists in the model and not on the floor, despite M6.3's record
claiming the parity suite covers it. **M6.10 closes these.**

#### Also found, and fixed here

- **A silent degradation (invariant §7).** `validateCompositions` had only test
  callers while its own contract comment claimed a bad composition "degrades …
  and says so". The degrading half was real; the saying-so half was never wired.
  A pack shipping a wrong-sized station lost it in silence. Fixed with a
  regression; mutation-checked.
- **A dead seam.** `Gymnasium.slice()` emitted `source`; `BriefInput.gymSlice`
  read `spendSource`; nothing set it. Carried item (2) was half closed and the
  record's "the brief prints both" was false. Object spread bypassed
  excess-property checking, so typecheck stayed green across two milestones, and
  both halves had passing tests because none spanned the seam. Fixed; the
  regression now drives the real slice into the real compiler.
- **The audit trail had become unreviewable.** `docs/PROGRESS.md` entered the
  index with CRLF at `5b9ff87`, so M6's PROGRESS diff read as 6582 changed lines
  where 248 had changed. Nothing was wrong with the content — the only real
  deletions are the nine `- [ ]` boxes becoming `- [x]`, verified with
  `--ignore-all-space` — but this is the document a close-out audit reads BY
  DIFF, and it is where a substantive edit to an earlier milestone would hide.
  `.gitattributes` added; three files renormalized.
- **A count and an artifact.** `carried-items.test.ts` is 16 cases, not 15.
  M6.8 owed "a floor screenshot at the v2 bar"; no M6 PNG exists — the only M6
  floor artifact is a procedural SVG, which is honest evidence of a different
  kind, ticked against a row that asked for something else.

#### What verified exactly as recorded — cleared

1. **The gate.** typecheck · zero-warning lint · `invariants ok` ·
   `attribution ok (141 commits)`.
2. **CI on every M6 branch**, all eight `completed/success`, each run's
   `headSha` identical to the local branch head — checked, not assumed. The
   record credits m6-1…m6-7; **m6-8 (`8f1ddf0`, run 33256759350) is green too**,
   and it is the SHA carrying the milestone. The record understates itself.
3. **The Windows-local baseline is exactly as recorded**: 9 deterministic
   failures (agent-worktree 4, s-crash 3, claude-transcripts 1, cost 1); every
   other failure passes in isolation. Ubuntu CI is the gate and it is green.
4. **The committed demo evidence is HONEST.** Independently re-derived from
   today's source: 192/192 citizen cells and 23/23 overlay cells match
   `citizenSprite()`/`overlayPixels()`; the station census line is byte-identical
   to `stationCensus()`; 240/240 floor plan tiles at identical coordinates; 6/6
   citizens reproduce, one per silhouette, terracotta on the orchestrator alone.
   *Standing gap:* the generator is a scratch file, not committed
   (DECISIONS-LOG 2026-08-29), so no command in the repo reproduces these and a
   future refactor will orphan them silently.
5. **ADR-0007's seam is the cleanest ADR transcription in the repo.** `seam.ts`
   carries the three interfaces and no `shouldFailover`, `retry` or provider
   preference; both adapters expose none; asserted by name in three independent
   places. The Realtime adapter implements `DuplexVoice` only and does not fake
   TTS to look complete. The M1.1 lesson was not repeated.
6. **UI-DESIGN v2 §5.1, §5.2, §5.4, §5.5, §5.6, §5.7 and §8 conform clause by
   clause** — eight authored directions with no mirror table, `FRAME_MS` 125 =
   two frames per 250 ms tile, the §5.2 table transcribed exactly, station sizes
   matching the catalog cell-for-cell, exactly three particle systems with a
   test that there is no fourth. The `working` overlay row is the one unmet
   clause (M6.10).
7. **Secrets, prompts-as-config, renderer isolation, tokens-only UI, `any`-free,
   `schemaVersion`, atomic writes, append-only, ADRs untouched** — all verified
   clean on the M6 diff.
8. **The GYM sweep booking is exactly as recorded**: 2026-09-11 raises
   GYM-002/003/004; 2026-09-25 adds GYM-001; GYM-005 correctly skipped.
9. **The owed items are genuinely owed, not faked.** No wake-word detector
   exists behind the setting; nothing in `src/` simulates a provider and reports
   it live; `spokenSoFar()` is a real measurement off the SDK's character
   alignment. M6.3's mutation claim is if anything **understated** — the record
   says three seam cases fail; five do.

#### Standing lessons

- **A green suite is not a wired feature.** Three milestones of tests passed
  against code the application cannot reach. Every future milestone's exit
  review states, for its headline subsystem, the production call path — file and
  line — or records that there is none.
- **Test the seam, not the halves.** The `spendSource` defect is the M5b lesson
  recurring with a new shape: object spread hides a key mismatch from the
  compiler, so two well-tested halves stayed unconnected across two milestones.
- **An assertion that cannot fail is not evidence.** Parity asserted as
  `f(x) === f(x)` reads exactly like parity asserted properly. Mutation is the
  only way to tell them apart, and it belongs in every close-out from here.


### M6 close (2026-08-30) — verdict: CLOSED against amended criteria

The close-out audit reopened M6 on 2026-08-29 with 0 of 3 exit criteria met. All
three were live-voice demonstrations, and M6.9 — the package that wires the
Herald into the application — was **deferred indefinitely** on 2026-08-30. That
made them unreachable by construction rather than merely unperformed, so the
Architect amended the milestone gate to the mechanical bar and closed M6 on it.

**Verified by execution on `4d831e4`, each suite run in ISOLATION** so no result
is a load artefact:

| Group | Result |
|---|---|
| Scenario suites (20) | **19 green**; `s-crash` 3 failed — a recorded Windows-local deterministic failure, green on Ubuntu |
| Conformance suites (3) | **all green** — engine-adapters 72 (+2 skipped), recall-smoke 15 (+1), voice-adapters 28 |
| M6 unit suites (14) | **all green**, 259 cases |
| Full suite | 2402 passed / 11 failed / 6 skipped (2419) |
| **Ubuntu CI (the gate)** | **green** — run 33340182591, Typecheck · Lint · Invariants · Test · Docs integrity · Attribution all success |

The 11 local failures are the baseline recorded since M6.1: 9 deterministic
(`agent-worktree` 4, `s-crash` 3, `claude-transcripts` 1, `cost` 1) plus 2
`s-stoploop` load flakes that pass 8/8 alone. None touch M6, and all pass on
Ubuntu. **Green on the gate, not green on this laptop** — stated that way
deliberately.

**What this close does NOT claim.** SRS §6.2 (the spoken standup), SRS §6.5 (the
key pulled mid-conversation) and the voice-driven day were **not demonstrated**
and are not waived. They are v1 acceptance criteria, unchanged in the SRS, owed,
and now attached to M6.9. The Herald remains built, tested, conforming and
**unreachable from the application** — exactly as the close-out audit found it.
A milestone may close with work deferred; it may not close by quietly deleting
the bar it failed. This paragraph is the difference.

**Carried into M7** (full list at the head of the M7 plan): the Herald wiring and
its three live proofs; the v2 floor with a real company; a committed generator
for `docs/demo/*.svg`; the M6 floor screenshot; wake-word detection.

**Also found while closing:** `main` is documented in ENGINEERING-STANDARDS §2 as
"protected: PRs only, CI green, one review", and the GitHub API reports **no
branch protection on `main` at all** (`404 Branch not protected`). The rule is
real in prose and absent in the mechanism — the same shape as the invariant-§7
gap this milestone's audit found in `validateCompositions`. Recorded for the
Architect; enabling protection is a repository-settings decision, not a code one.

## M7 — The Harbor + the two outward missions (plan drafted 2026-08-29 at M6 close)

Derived per BUILD-PROMPT §5 from IMPLEMENTATION M7 + ADR-0012 + SDD §7.5 +
SRS FR-9.1–9.4/FR-10.1/FR-10.3/FR-10.4 + UC-09/UC-10 + TEST-STRATEGY §3
(S-PROFILE, E-PLAYBOOK). **The Architect split M7 at the mission seam**
(decision 2026-08-29, mirroring the M5/M5b precedent): M7 builds the profile
machinery and the two OUTWARD missions that face the Architect's other
repositories; **M7b** builds the INWARD one — the company improving itself
under its own GitHub identity — plus the chat bridge and shipping. Each
milestone's exit is then independently verifiable, which a single M7 holding
the one-hour test, the recursive test, packaging and a chat bridge behind one
gate would not have been.

Execute in order; every package tests against the fake engine per-PR.

**Carried into M7, from the M6 close-out audit and earlier.** These are owed and
recorded, never faked. *Blocking M6's own close (M6.9/M6.10, not M7):* the
Herald's production wiring; the eighteen surviving mutations. *Owed to a local
session with the right access:* the two live voice proofs (a brief spoken by a
real provider; a real key pulled mid-conversation) and the voice-driven day, all
three unreachable until M6.9 lands; the v2 floor with a REAL company on it;
wake-word DETECTION (the setting ships, no local engine is an approved
dependency); a committed generator for the `docs/demo/*.svg` evidence, so the
art artifacts stop being unreproducible; the M6 floor SCREENSHOT M6.8's row
asked for. *Older, still open:* the Memory panel screenshot; codex/gemini hook
wiring post-trust; a real-engine respawn demo; E-STOA's LLM-judged half; a study
that records its own pin from a real checkout (`stoa:pin` stays owed until then);
the jsdom question for renderer interaction coverage; and BUILD-PROMPT §10's
pre-approved dependency list, which never gained the two voice SDKs the
Architect approved at M6.5.

- [x] **M7.1 Profile schema + loader** — ADR-0012's bundle exactly:
      `profiles/<name>/` with `profile.json` (name, version, `schemaVersion`,
      target binding, autonomy levels), `hires/*.json`, `triggers/*.json`,
      `playbooks/*.md`, `memo-policy.json`, `harbor.json`. The loader validates
      against the schema and REFUSES an invalid bundle by name rather than
      degrading to defaults. Playbooks are prose agents read; everything
      mechanically enforced is JSON the harness reads — the ADR-0005 split.
      *Docs: ADR-0012 (normative), FR-9.1, SDD §2 on-disk layout. Tests:
      schema validation table incl. every refusal reason; `schemaVersion`
      present with a migration path exercised; a playbook is never parsed as
      policy; loading is pure — no activation side effects. Risk: the schema
      is a PUBLIC CONTRACT from the day it ships — transcribe ADR-0012, do not
      extend it (the M1.1 lesson, restated).*
      *Evidence: `typecheck && lint && check-invariants` green; 50 new cases
      (`test/shared/profile.test.ts` 35, `test/main/profiles.test.ts` 12,
      `test/main/ipc-handlers.test.ts` +3 seam cases); full suite **2453 passed /
      6 skipped**. Failures are the recorded 9 Windows-local deterministic ones
      (agent-worktree 4, s-crash 3, claude-transcripts 1, cost 1) plus
      `s-stoploop`, which fails 1–2 cases under parallel load and passes 8/8 in
      isolation — so consecutive runs report 10 and 11, and both numbers are
      given here rather than the kinder one.*
      **Production call path** (the M6 standing lesson — stated, not assumed):
      `src/main/index.ts:580` constructs the `ProfileStore` over
      `<home>/profiles` and the bundled `profiles/`; `src/main/index.ts:1631-1632`
      binds it to `profilesList`/`profilesInspect`; `src/main/ipc.ts:409-413`
      registers `profiles:list` and `profiles:inspect`;
      `src/preload/index.ts:138-142` exposes them as `window.eph.profiles`.
      **No renderer caller yet** — the panel is M7.2's activation UI, and that
      gap is recorded here rather than left to be discovered.
      *Proved by RUNNING the real app, not by reading it:* built, then booted
      `npx electron .` against a temp `EPH_HOME` holding one valid bundle and
      one broken one. `profiles.list()` returned both — `broken-crew` present
      and `valid: false`, `skeleton-crew` `valid: true, version: 3`;
      `inspect("skeleton-crew")` returned the whole bundle including the hire's
      budget and the playbook text; `inspect("broken-crew")` refused by name
      with *both* reasons (`memo-policy.json: missing from the bundle`,
      `harbor.json: missing from the bundle`). After the boot the profiles tree
      was byte-for-byte what it had been — **loading wrote nothing**, so purity
      holds in the app and not only in the rig. The temporary `EVIDENCE` log was
      removed before commit (BUILD-PROMPT §10.7).
      *Mutation-checked, 21/21 killed:* the refusal table, the name/directory
      match, `byKind`'s strictness, all four migration refusals and the ladder
      walk, both trigger-binding checks, the playbook-is-not-policy claim (a
      mutation that genuinely parsed a fenced JSON block out of the prose), the
      every-reason-at-once claim, the list's invalid rows, home-shadows-builtin,
      the no-seeding claim, and the three IPC-seam mutations. Two of the first
      draft's mutations were duds that changed no behaviour and were rewritten
      until they bit — recorded because a dud mutation proves nothing and
      reports as success.
- [x] **M7.2 Activation, targets, and autonomy composition** — instantiate a
      profile's hires as agents bound to a TARGET (repo/app); the same profile
      activatable per-target more than once; multiple profiles coexisting on
      one floor (FR-9.4). Autonomy composes with the global Watch defaults so
      the **stricter setting always wins** (FR-11.1, deny-by-default). The
      activation UI shows what the profile MAY DO before it is activated —
      inspectability is the safety story ADR-0012 chose profiles for.
      *Docs: ADR-0012, FR-9.4, FR-11.1, SDD §9 Watch enforcement points.
      Tests: stricter-wins composition table over profile×global pairs
      including the cases where the profile is LAXER; per-target instantiation
      keeps ledgers and budgets separate; deactivation disarms triggers; two
      profiles on one floor never share an agent. Risk: an autonomy level that
      composes by "profile wins" is a silent privilege escalation — assert the
      direction of composition, not merely its presence.*
      *Evidence: `typecheck && lint && check-invariants` green; 38 new cases
      (`test/shared/profile-activation.test.ts` 16,
      `test/main/profile-activation.test.ts` 22, four of them a REAL
      `GateManager` wired to a REAL `ProfileActivations`); full suite **2489
      passed / 6 skipped**. Failures: the recorded 9 Windows-local deterministic
      ones, unchanged, plus `s-stoploop` (2) and `hermes` (1) under parallel
      load — hermes passes 40/40 and s-stoploop 8/8 in isolation, and neither
      touches this package.*
      **Production call path:** `src/main/index.ts:1421` constructs
      `ProfileActivations` over the AgentManager, the scheduler and the real
      `gate-policy.json`; `src/main/index.ts:641` gives `GateManager` its
      `profileAutonomy` seam; `src/main/index.ts:1687-1697` binds the four deps;
      `src/main/ipc.ts:414-434` registers `profiles:preview|activate|deactivate|
      instances`; `src/preload/index.ts:141-153` exposes them. **No renderer
      caller yet** — the activation SCREEN is not built; `preview` returns
      everything it needs and nothing renders it. Recorded, not hidden.
      **Two things this package made reachable that were not:** `effectivePolicy`
      and `GateRequest.profileAutonomy` shipped at M3 and had no production
      caller at all — the composition was correct arithmetic nothing could
      invoke. `GateManager` now resolves it for EVERY submission rather than
      trusting each call site to pass it, because a field the caller must
      remember is a field that gets forgotten, and forgetting it silently gives
      an agent whose profile TIGHTENED a class the looser company default.
      *Proved by RUNNING the real app:* booted `npx electron .` against a temp
      `EPH_HOME` carrying a real `gate-policy.json` (`autonomy: supervised`) and
      a bundle asking for `autonomous` with `destructive: manual`.
      `preview` returned `destructive → effective manual, clamped false` (the
      profile's tightening honoured) and every other class
      `requested autonomous → effective supervised, clamped true` (the profile's
      widening refused and SAID SO). The temporary `EVIDENCE` log was removed
      before commit.
      *Mutation-checked, 18/18 killed*, including both directions of the
      composition — "profile wins" (the escalation this line names) and "global
      wins" (which would silently drop a profile's own tightening) — plus id
      collisions across targets and across profiles, id truncation, the failed
      -spawn unwind, deactivation leaving triggers armed, `autonomyFor` answering
      after deactivation or defaulting to `autonomous`, and the Watch ceasing to
      consult the profile at all. One survivor was found and closed: an event
      trigger could be REPORTED as armed while nothing armed it, because no
      assertion compared `instance.armed` against what the scheduler was
      actually given — the UI would have shown a watcher on duty that no clock
      would ever fire.
- [x] **M7.3 Harbor: GitHub ingestion** — issues, PRs and CI runs for
      registered repos ingested via the `gh` CLI under the agent's own auth
      (FR-10.1); every remote-originated directive tagged `remote` in
      `log.jsonl` (FR-10.3). A scripted `gh` seam, so the suites never touch
      the network.
      *Docs: FR-10.1/10.3, SDD §1.1 (`harbor/github.ts`), §4.3 log kinds.
      Tests: ingestion → ledger/log projection over recorded `gh` fixtures;
      `remote` tagging total over every inbound path; a `gh` failure is a
      VISIBLE degradation, never a silent empty queue; no secret reaches the
      ingestion path (the S-SECRETS pattern). Risk: ingestion that invents a
      task the API did not report is the E-BRIEF-FAITH failure wearing a
      Harbor hat.*
      *Evidence: `typecheck && lint && check-invariants` green; 41 new cases
      (`test/shared/harbor.test.ts` 22, `test/main/harbor-github.test.ts` 19);
      full suite **2530 passed / 6 skipped**, failures unchanged — the recorded
      9 Windows-local deterministic ones plus `s-stoploop` (2) and `hermes` (1)
      under parallel load, both green in isolation and neither related.*
      **Production call path:** `src/main/index.ts:1465` constructs
      `GitHubHarbor` whose registered repos are the ACTIVE profiles'
      `harbor.json` entries (M7.1's schema, M7.2's instances — one list, not a
      second that could disagree); `src/main/index.ts:1478` probes and ingests
      at boot; `:1480-1490` adds the `harbor-github` scheduler cadence
      (10 min, `enabled` only while some profile actually watches a repo);
      `src/main/ipc.ts:410` registers `harbor:repos`; `src/preload/index.ts:138`
      exposes it. **No renderer caller yet** — no Harbor panel is built.
      Recorded, not hidden.
      *Proved against the REAL `gh` CLI and the REAL GitHub API,* because the
      parsers were written against an assumption of `gh --json`'s shapes and an
      assumption is what a fixture would have re-tested: booted the built app
      with the driver pointed at `mertefesensoy/Ephesus`. `gh 2.92.0`,
      `unavailable: null`, **50 items, 0 dropped, failure null**, and **50
      `remote` log entries — one per item, tagging total (FR-10.3)**. Zero rows
      needed repairing, so the schemas match what GitHub actually returns. The
      repo has no open issues or PRs, and that read as `items: 50, failure:
      null` rather than as a fault — which is the distinction `RepoQueue.failure`
      exists to make. (Incidentally: the two newest runs are this session's own
      `feature/m7-1-profile-schema` and `feature/m7-2-activation-autonomy` CI
      runs, both `success` — Ubuntu CI is green on both pushed branches.) The
      temporary `EVIDENCE` block was removed before commit.
      *Mutation-checked, 16/16 killed*, headed by the invention the risk line
      names: a malformed row REPAIRED into the queue as `#0 ""`. Also killed —
      dropped rows uncounted; a running CI job given a `failure` conclusion; a
      non-array response read as "no rows"; the `remote` projection skipping a
      kind or losing its tag; a cancelled run counted as a failure; a draft PR
      reported ready; a `gh` failure yielding an empty queue with no failure
      recorded; a failed repo forgetting what it last knew; ingestion without a
      probe; an unrecognised `--version` accepted; one failing repo aborting the
      others; calls unscoped from `--repo`; dropped rows raising no degradation.
      One survivor found and closed: failing only the FIRST `gh` call left
      nothing in flight to leak, so nothing tested whether a LATER failure would
      still log the items collected before it — half a repo tagged `remote` in
      the book of record that the queue never showed.
- [x] **M7.4 Skeleton Crew profile (built-in)** — FR-9.2 as an ORDINARY
      ADR-0012 bundle exercising no private API (the dogfood rule, NFR-12):
      health-check watcher, CI babysitter (watch runs, triage failures, open
      fix PRs), dependency-update agent (batched PRs), and incident-response
      playbooks with severity-based escalation (UC-09). A severity-1 reaches
      the Herald immediately (UC-09 step 4).
      *Docs: FR-9.2, UC-09, SDD §7.5 incident sequence. Tests: S-PROFILE
      (fixture repo + fake CI webhook → triage task auto-created → playbook
      path, stricter-wins asserted); severity→escalation table total;
      E-PLAYBOOK's incident drill measuring time-to-triage. Risk: a built-in
      that reaches past the schema invalidates ADR-0012's central claim — this
      profile must be buildable by an Architect with a text editor.*
      *Evidence: `typecheck && lint && check-invariants` green; 61 new cases
      (`test/main/skeleton-crew.test.ts` 9, `test/shared/incident.test.ts` 16,
      `test/main/incidents.test.ts` 19, `test/scenarios/s-profile.test.ts` 10,
      `test/evals/e-playbook.test.ts` 7) plus 3 on the extracted trigger wake;
      full suite **2593 passed / 6 skipped**, failures unchanged — the recorded
      9 Windows-local deterministic ones plus `s-stoploop` (2) under parallel
      load, green in isolation (8/8) and unrelated.
      **ADR-0012's dogfood claim HOLDS, and is now checked rather than stated:**
      the bundle needed no field M7.1's frozen schema lacks, and
      `skeleton-crew.test.ts` runs against the REAL shipped bundle through the
      REAL loader — a private sidecar or a schema reach turns it red. One case
      pins the directory listing itself.
      **Production call path:** `src/main/index.ts:1195` constructs
      `IncidentEndpoint`; the `harbor-github` cadence's `run` feeds it the
      ingest result (repositories that ANSWERED only — a failed repo keeps its
      stale queue, and re-raising from it would be news that is not new);
      `src/shared/routing.ts:172` → `src/main/hermes.ts:587` carries the triage
      report back; `onTriggerFired` now WAKES its agent through
      `triggerWakeMessage` (through M7.2 it appended a log line and stopped, so
      the health watcher and dependency updater were spawned and never asked for
      anything — two of FR-9.2's four components inert behind a green suite).
      **The harness never writes `tasks.json`:** a CI failure is mailed to
      Artemis from `agent.harbor` and she proposes the task (FR-5.2's single
      scribe); S-PROFILE asserts the ledger is UNCHANGED after `raise`.
      **The harness never grades severity** — the escalation table is driven by
      the severity the AGENT reported, and an unreadable report is refused, not
      defaulted to the mild rung.
      **9 mutations applied, 9 killed** (M1 drop the routing branch · M2 flatten
      the ladder · M3 drop the dedupe · M4 misroute by repo · M5 default an
      unreadable report · M6 invent a conclusion · M7 widen env grants · M8 ask
      for `autonomous` on `destructive` · M9 announce silently). Two defects
      found by writing them: `'reproduce'` CONTAINS `'prod'`, so the eval's
      substring match scored playbook compliance as an un-gated production
      action (the M6 repeat-back shape — now a closed vocabulary compared by
      equality); and `agent.sk-<target>-<hire>` matches check-invariants'
      OpenAI-key pattern, so the tests now use the id production actually mints.
      **UC-09 step 4's spoken announcement is OWED, not faked:** M6.9 is deferred
      and the Herald gains no caller here, so a severity-1 logs
      `incident-announce-owed` and reports an unmet obligation through the
      degradation channel while the gate queue takes the escalation. Mutation M9
      proves that leg is load-bearing.*
- [x] **M7.5 Front Office profile (built-in)** — FR-9.3: issue/PR triage,
      reply drafting with CONFIGURABLE autonomy (draft-only → auto-post),
      docs/changelog sync, and release-prep checklists (UC-10). Outbound
      comments above the configured level require Architect approval, batched
      into the standup by default.
      *Docs: FR-9.3, UC-10. Tests: the autonomy ladder as a table — every rung
      asserted for what it does AND what it refuses; a draft-only profile has
      no code path that posts; batching into the standup preserves the gate.
      Risk: "auto-post" is the first outward-facing irreversible act the
      company can take on its own — that gate belongs in the harness, not in a
      playbook's prose.*
      *Evidence: `typecheck && lint && check-invariants` green; 39 new cases
      (`test/shared/outbound.test.ts` 16, `test/main/frontoffice.test.ts` 14,
      `test/main/front-office-profile.test.ts` 9); full suite **2636 passed /
      6 skipped**, 11 failed — an IDENTICAL set to before this package (the
      recorded 9 Windows-local ones plus `s-stoploop` (2) under load). **No
      existing gate test broke**, which is the evidence that adding a seventh
      gate kind was additive rather than a change of meaning.
      **ONE SCHEMA CHANGE, ASKED BEFORE IT WAS MADE:** `outbound` joins
      `GATE_KINDS` by ARCHITECT DECISION (BUILD-PROMPT §8.3 must-ask, three
      options). M5.3's recorded rule — borrow a kind, never invent a seventh —
      carries the qualifier "the mapping loses nothing", and here it does lose
      something: borrowing `prod-facing` would mean enabling auto-post on issue
      replies also granted autonomous PRODUCTION actions, with no way to write
      "may reply, may not touch prod". **SRS FR-11.1 was amended in the same
      change** to name outbound public communication. Safe by construction: a
      policy that never mentions `outbound` denies it, so the addition can only
      tighten an existing deployment.
      **ADR-0012's dogfood claim HELD a second time:** the Front Office needed no
      change to M7.1's profile schema. The gate kind is the WATCH's vocabulary,
      not the bundle's. `front-office-profile.test.ts` runs against the real
      shipped bundle through the real loader and pins the directory listing.
      **The risk line is answered structurally, not by a guard:**
      `GitHubHarbor.postComment` takes a branded `PostPermit` whose only two
      constructors refuse everything below `autonomous` or unapproved — so a
      draft-only profile has no code path that posts, asserted on the API
      surface (the S-SECRETS pattern) rather than by inspection.
      **Batching IS the gate:** `supervised` opens an ordinary `outbound` gate
      and `BriefInput.openGates` is what the standup already reads, so there is
      one record seen from two angles rather than a digest that could drift from
      the approval it summarizes. The WHOLE draft reaches the gate — approving a
      comment without its text is signing a blank page.
      **Production call path:** `src/main/index.ts:1258` constructs
      `FrontOffice`; the Harbor endpoint dispatches on `OUTBOUND_SUBJECT`
      (one address, two filings — the ADR-0008 Odeon pattern);
      `GateManager.onSettled` at `:695` routes an `outbound` verdict to
      `onVerdict`; `:1271` posts. **10 mutations applied, 10 killed.**
- [x] **M7.6 Shareable hires and profiles** — export/import a role template or
      a whole bundle via file/link (FR-10.4); **import only PRE-FILLS the
      spawn/activation form — a human always confirms.** Bundles are plain
      files, so a shared profile is diffable in review.
      *Docs: FR-10.4, ADR-0012 (shareability). Tests: an imported bundle
      cannot activate without a human confirmation step (asserted by API
      surface, the S-SECRETS pattern); import of a bundle carrying a secret,
      an undeclared env grant, or a widened autonomy level is refused by name;
      export→import round-trips losslessly. Risk: an imported profile is
      UNTRUSTED CONTENT (invariant §13's spirit) — it may not raise its own
      privileges on the way in.*
      *Evidence: `typecheck && lint && check-invariants` green; 56 new cases
      (`test/shared/share.test.ts` 25, `test/main/hires-exchange.test.ts` 19,
      `test/shared/secret-shapes.test.ts` 12); full suite **2692 passed /
      6 skipped**, failures an identical set to before the package.
      **FIVE REAL PRIVILEGE ESCALATIONS FOUND BY AN ADVERSARIAL PASS AGAINST MY
      OWN CODE, ALL FIXED, EACH WITH A NAMED REGRESSION.** (1) **Path traversal**
      — payload record KEYS were bare `z.string()` and `install` writes through
      `path.join`, so a playbook named `../../../gate-policy.json` overwrote the
      WATCH'S OWN POLICY, which SDD §2 says "can only ever loosen, never
      tighten" — a complete bypass of the approval system, found by a probe that
      asserted the import SUCCEEDED while the happy-path suite stayed green.
      (2) **A JSON backslash-uXXXX escape walked past the secret scan**, which read the
      raw blob text — the raw text matches nothing while `JSON.parse` yields a
      real token; the scan now walks decoded values AND keys. (3) **`install`
      merged instead of replacing**, so a v2 that dropped a hire left the old one
      on disk and the loader read back the UNION — the Architect confirms two
      hires and gets three, with the third still armed. (4) **The widening check
      was skipped when the installed copy did not parse**, so a bundle arriving
      while the installed profile happened to be broken got MORE latitude than
      one arriving while it was healthy. (5) **The manifest disclosed NAMES but
      not PROSE** — every name identical, every runbook rewritten, and a playbook
      is the agent's task list on a timer with the profile's autonomy.
      **The design:** the envelope carries FILES (ADR-0012's "diffable in
      review" — round trip asserted byte-for-byte), and the manifest is
      RECOMPUTED from the payload on import by the same function that produced
      it, so a human confirms a derived fact rather than an author's claim. That
      is what gives "an undeclared env grant" a mechanical meaning. Every gate
      class is declared, including ones the bundle never mentions, so a
      permissive DEFAULT cannot arrive undisclosed.
      **Production call path:** `src/main/index.ts` constructs `HireExchange`
      beside the `ProfileStore`; `harbor:import-inspect` -> `inspect` ->
      `inspectImport` -> `secretShapeIn`; `harbor:import-install` -> `install`
      -> `writeFileAtomic`. **Nothing here activates** — asserted on the API
      surface (S-SECRETS pattern): the four sharing channels are pinned, and
      `HireExchange` has no spawn, scheduler or activation seam to call.
      `inspect`'s purity is asserted by a CENSUS of the file tree, not a claim.
      **The runtime secret list cannot drift from the M0 build gate:**
      `secret-shapes.test.ts` reads `check-invariants.cjs` as text and compares
      element by element. **14 mutations applied, 14 killed** — two survived a
      first pass and both were fixed rather than accepted (an assertion that
      could not distinguish the key-scan from the strict schema's own refusal;
      and an install-side guard that was unreachable dead code, now an exported
      function with its own test — the M6 lesson restated).*
- [x] **M7.7 Suites + exit review** — S-PROFILE green in CI; **the one-hour
      company test (SRS §6.1) run on a REAL repo** with its evidence captured;
      E-PLAYBOOK's drill recorded; the M6 carried items closed or re-recorded
      with their reason.
      *Evidence: CI **green on the whole M7 stack** —
      `feature/m7-6-shareable`, run `33438533520`, success, 1m57s — which is
      S-PROFILE's "green in CI". `typecheck && lint && check-invariants` green;
      full suite **2697 passed / 6 skipped**, 12 failed (the recorded 9
      Windows-local ones plus `s-stoploop` (2) and `hermes` (1) under parallel
      load, each verified green in isolation — `hermes` 40/40).
      **A DEFECT THE EXIT REVIEW EXISTS TO CATCH, FOUND AND FIXED:**
      `compileFacts` had NO INCIDENT BRANCH, so the incident entries the endpoint
      has written since M7.4 reached the standup only sideways — as an open gate,
      or as whatever task Artemis happened to create. **SRS §6.1's "the next
      briefing narrates the incident accurately from the log" was unreachable BY
      CONSTRUCTION while every suite was green.** VOICE-DESIGN §4 had specified
      it all along ("Health — … breaker trips, **incidents**, Harbor queue
      depth"), so this was an unimplemented requirement, not a new feature. The
      agent's summary is carried VERBATIM, every fact carries a `log#<seq>` ref,
      and the OWED announcement is narrated too — an obligation recorded only in
      `log.jsonl` is one the Architect must go looking for. **5 mutations, 5
      killed**; the owed-announcement branch survived the first pass and the
      assertion was added rather than the branch accepted.
      **Evidence, with a COMMITTED generator** (M6's standing complaint):
      `test/scenarios/m7-evidence.test.ts` writes
      `docs/demo/m7-onehour-chain.txt` and `docs/demo/m7-eplaybook-scorecard.md`,
      reproducible with `npm test`. Both artifacts state in their own text what
      they are NOT — the transcript that it is not the acceptance criterion, the
      scorecard that its drill record is a fixture rather than a live agent run.
      **`test/scenarios/s-onehour.test.ts`** walks §6.1's chain end to end over
      the SHIPPED components (real git, real incident endpoint, real Hermes
      router, real ledger endpoint, real gates, real briefing compiler) with only
      the `gh` process and the ENGINE replaced at their seams.*
- [ ] **M7 exit** — SRS §6.1 demonstrated on a real repo (the crew detects a
      broken test, fixes it or opens a fix PR, files the memo if policy was
      crossed, and the next briefing narrates the incident accurately from the
      log, with zero un-gated destructive actions); S-PROFILE pass; PROGRESS +
      docs synced.

### M7 exit review (2026-09-01) — verdict: **M7.1–M7.7 DONE; the milestone's exit criterion is NOT met, and how it closes is an OPEN ARCHITECT DECISION**

Every package is built, tested, mutation-checked and documented. The milestone's
exit criterion is not met, and this review does not pretend otherwise: **SRS §6.1
has not been demonstrated on a real repo.** What follows is what was verified by
execution, what was not, and the decision that is the Architect's.

**What M7.7 owed, and what it delivered.**

1. **S-PROFILE green in CI — MET.** The whole M7 stack is on
   `feature/m7-6-shareable` (each branch cut from the previous, since M7.1 never
   reached `main`), pushed and green: run `33438533520`, `success`, 1m57s. That
   run carries S-PROFILE, S-ONEHOUR and every other suite.
2. **The one-hour company test on a REAL repo — NOT MET.** The CHAIN is
   demonstrated end to end over shipped components (below); the real-repo,
   real-engine half is owed. See the decision at the end.
3. **E-PLAYBOOK's drill recorded — MET**, with the qualifier stated in the
   artifact itself: `docs/demo/m7-eplaybook-scorecard.md` scores a well-run
   drill through the shipped scorer, from a FIXTURE record. E-PLAYBOOK is a
   weekly/pre-release eval against real engines (TEST-STRATEGY §6); the live run
   is owed with §6.1.
4. **Carried items closed or re-recorded — MET.** Re-recorded accurately below;
   two of them had already been closed at M6.10 and the M7 paragraph still
   listed them, which is the kind of staleness this row exists to catch.

**A defect found by the exit review, and fixed.** `compileFacts` had **no
incident branch at all**. The incident endpoint has written `incident-raised`,
`incident-triaged` and `incident-announce-owed` to `log.jsonl` since M7.4, and
the briefing compiler had never heard of any of them — so an incident reached
the standup only sideways, as an open gate or as whatever task Artemis happened
to create. The Architect was never told that something broke, in which
repository, or what the on-call agent concluded. **SRS §6.1's last clause — "the
next briefing narrates the incident accurately from the log" — was unreachable
by construction**, and every suite was green. VOICE-DESIGN §4 had specified it
all along ("Health — budgets vs burn, breaker trips, **incidents**, Harbor queue
depth"); it was simply never implemented. Fixed, with the agent's summary
carried verbatim and every fact carrying a `log#<seq>` ref, and mutation-checked
five ways. This is the M6 shape a third time: two halves that had never met.

**What was demonstrated, by execution.** `test/scenarios/s-onehour.test.ts`
walks SRS §6.1's chain over the SHIPPED components — real git in a temp home,
the real `IncidentEndpoint`, Hermes router, `LedgerEndpoint`, `GateManager` and
briefing compiler. Two things are replaced at their seams (TEST-STRATEGY §1's
"determinize the boundary, not the world"): the `gh` process, and the ENGINE.
The transcript is committed at `docs/demo/m7-onehour-chain.txt`, and its
generator is committed too — `test/scenarios/m7-evidence.test.ts`, re-runnable
with `npm test`, which is the answer to M6's standing complaint that the demo
generator was a scratch file.

The chain, as it actually ran: CI reports run #4021 failed → the incident is
raised and mailed to Artemis while **`tasks.json` is unchanged** (FR-5.2's single
scribe) → Artemis proposes → the task lands assigned → the on-call agent files a
triage report from its own outbox through the real router → a severity-1
escalates now and opens a gate → the announcement the Herald cannot make is
recorded as owed → **and the standup narrates all three, from the log, with
refs**.

**What was NOT demonstrated, and why the milestone does not close on it.**
SRS §6.1 asks whether a REAL agent, given a REAL broken test in a REAL
repository, actually detects it, triages it correctly, and fixes it or opens a
sound fix PR — within an hour, unattended. That is *judgment*, and no fake
engine stands in for it. What M7 has proved is that every arrow between "CI went
red" and "the standup says so" exists, is wired, and carries the truth. What
remains unproved is the half the harness cannot supply.

The gap is not for want of tooling: `gh` is authenticated on this machine and
`claude` is on PATH. It is that running §6.1 means **deliberately breaking a
test in one of the Architect's repositories and leaving autonomous agents with
`GH_TOKEN` grants running unattended against it for an hour**. Choosing that
repository, and consenting to that, is the Architect's call and nobody else's.

**Therefore M7 does not close on its criterion as written**, and — exactly as at
M6 — the options are the Architect's: run §6.1 and close on it; amend the
criterion on the record; or hold M7 open. What this review will not do is tick
the row and call the chain the criterion. That substitution is the failure the
M6 close-out audit was convened to catch, and committing it here would make this
review worthless.

**Carried items, re-recorded accurately (2026-09-01).**
*Already closed at M6.10, and the M7 paragraph was stale in still listing them:*
the jsdom question (answered — dev-only, pinned `^26`), and BUILD-PROMPT §10's
dependency list (it does now carry both voice SDKs and jsdom — verified).
*Closed here:* a committed generator for demo evidence — for M7's artifacts
(`test/scenarios/m7-evidence.test.ts`); the M6 SVGs still have none, so the
pattern is established and that specific debt stands.
*Still owed, unchanged, and blocked on a session with the right access:* the two
live voice proofs and the voice-driven day (all three unreachable while M6.9 is
deferred); the v2 floor with a real company on it; wake-word detection; the M6
floor screenshot; the Memory panel screenshot; codex/gemini hook wiring
post-trust; a real-engine respawn demo; E-STOA's LLM-judged half; `stoa:pin`
from a real checkout (verified: no such channel exists). *Newly owed:* SRS §6.1
itself, and E-PLAYBOOK's live drill.

### SRS §6.1 — the live run on `mertefesensoy/MUSAHIT` (2026-09-01) — verdict: **the DETECTION half passed; the ACTION half did NOT**

The Architect named a real repository, chose to add CI to it, activated the
Skeleton Crew from the panel, and approved gates by hand. `mertefesensoy/MUSAHIT`
had no CI at all; a pytest workflow was added on `ci/add-pytest-workflow` and
**failed on its own first run** (`33440874791`) — so the crew had a genuine
failure to find rather than a planted one. Real `claude` 2.1.195 throughout.
The record is `docs/demo/m7-onehour-live-musahit.txt`.

**What passed, on real rails.** The Harbor ingested the failed run and tagged it
`remote` (FR-10.3). The incident was raised, mailed to Artemis from
`agent.harbor`, and **`tasks.json` was left untouched** — FR-5.2's single scribe
held under live conditions. A re-ingest ten minutes later did **not** duplicate
it: M7.4's idempotency cursor held on a real repository, which is what stops the
crew being woken every ten minutes forever. Every gated action was held; the
Architect approved one spend gate and the log records who, when and through
which channel.

**What did not pass, and it is the important half.** Artemis read the incident
and replied to `agent.harbor` with the words **"Task opened…"**. No task was
ever created. `tasks.json` holds zero and the log contains no `task` event at
all. **The orchestrator reported work that did not happen**, and nothing in the
harness noticed — the refusal that caught it was incidental, rejecting her prose
for failing to be triage-report JSON. That is the E-BRIEF-FAITH failure class
arriving in the one place M7 had not instrumented for it, and it is exactly what
a scripted engine can never show: the fake engine always does what its script
says.

**Three defects behind it, all in M7's own code.**

1. **`agent.harbor` refuses legitimate mail.** `submitToHarbor` treats every
   inbound message as a triage report, so an orchestrator's ordinary courtesy
   reply — legal under ADR-0003's act table — is refused by name. The endpoint
   needs to distinguish a triage report from an acknowledgement instead of
   assuming.
2. **The incident prompt is ambiguous.** `prompts/harbor/incident-body.md` asks
   Artemis to open a task and then prints the triage-report JSON schema in the
   same message, addressed to her, describing what the ON-CALL agent should
   send. Two audiences in one message; she reasonably read the schema as hers.
3. **Nothing reconciles a claim against the ledger.** An agent may say it opened
   a task, and no mechanism compares that to `tasks.json`. The incident stays
   open with no work attached and no alarm. This is the serious one — the other
   two are plumbing.

**Five defects the run found before it got that far**, none of which any suite
could see, and four already fixed: `agora.log(-1, …)` was always refused, so the
floor's mail envelopes had never flown; M7.4's incident binding filtered
`when === 'ci'` against a plan that renders `"on ci"`, so **every** CI failure
was dropped as `incident-unclaimed`; `cmd.exe`'s 8,191-character command line
made the orchestrator unspawnable at 10,908 bytes of identity, with the whole
crew inside 250 bytes of the same cliff; and the wake nudge could be lost in a
race between consuming an inbox and observing it empty. The fifth is identified
and **not** fixed: **an avatar phase that never returns to `idle` makes an agent
permanently unnudgeable**, which is what stalled this run for twenty minutes; a
restart masks it, and the cause is not yet known.

**Budget.** Artemis exhausted a 2,000,000-token daily allowance on *briefing*
work before reaching the incident, and opened three gates in twenty-five
minutes. Whether that is a budget too small, a briefing loop too expensive, or a
priority the ledger should express is unresolved and worth its own look.

**So §6.1 is not met, and this review does not round it up.** The criterion asks
for a crew that detects a failure, fixes it or opens a fix PR, files the memo if
policy was crossed, and has the next briefing narrate it accurately — with zero
un-gated destructive actions. Two of those clauses passed outright (detection;
zero un-gated actions, deny-all having held every time). One is now known to
fail (the crew did not open work, and said it had). Two were never reached.


**Checks.** `typecheck`, `lint`, `check-invariants` green. Full suite **2697
passed / 6 skipped**, 12 failed — the recorded 9 Windows-local deterministic
failures plus `s-stoploop` (2) and `hermes` (1) under parallel load, each
verified green in isolation (`hermes` 40/40) and none related to M7. Ubuntu CI
green on the stack.

### M7 exit re-review (2026-09-02) — verdict: **still NOT MET; the three defects behind the failed half are closed, §6.1 has not been re-run, and a fourth defect is confirmed open**

Run after the M7 line was merged to `main` (`5728862`) and pushed. This review
re-verifies the 2026-09-01 verdict against the current tip rather than repeating
it: three of the defects that broke the live run are fixed, the suite is green
for the first time, and the criterion is **still not met** because the thing it
asks for has not happened again.

**Verified by execution, at `5728862`.**

| Criterion / claim | Command | Result |
|---|---|---|
| S-PROFILE passes | `vitest run test/scenarios/s-profile.test.ts` | pass (in the 25 below) |
| The §6.1 chain over shipped components | `vitest run test/scenarios/s-onehour.test.ts` | pass |
| Committed evidence regenerates | `vitest run test/scenarios/m7-evidence.test.ts` | pass, artifact byte-stable |
| Briefing narrates the incident | `vitest run test/scenarios/s-brief.test.ts` | pass |
| Named M7 suites together | the four above | **25 passed** |
| Whole suite | `vitest run --no-file-parallelism` | **3182 passed, 8 skipped, 0 failed (173 files)** |
| Gate | `typecheck` · `lint` · `check-invariants` · `check-attribution` | all green, 243 commits |
| Stub debt | `grep -rnE "TODO\|FIXME\|XXX\|HACK" src/ shims/` | **0** |

**The 2026-09-01 "Checks" paragraph is superseded, in the milestone's favour.**
It recorded 2,697 passed / 12 failed. The suite is now **0 failed**, and none of
the twelve was a flake in the useless sense: nine were two real bugs (a version
probe that never quoted its command, so any binary under a spaced path probed as
absent and every spawn took the FR-1.6 install branch; and `dayKey` read as UTC
by a test that straddled the wrong midnight), and the rest were a 5-second
default `testTimeout` under tests TEST-STRATEGY §2 deliberately puts on real fs
and real git. They had been recorded as "Windows-local" on 2026-08-29 and read
as environmental for three days.

**Three of the live run's defects are closed** — verified at the seam, not by
reading the fix:

1. **`agent.harbor` refusing legitimate mail** — closed. `src/shared/endpoints.ts`
   now declares each reserved address's contract (sends / accepts / handles /
   deaf) and routing reads it instead of repeating it; `test/shared/endpoints.test.ts`
   iterates `RESERVED_AGENT_IDS` and executes `routeMessage`, so an eighth
   endpoint fails closed. **24 passed.** The audit found the fault wider than the
   run showed: `refuse` — the act PROTOCOL.md tells every agent to use when it
   cannot comply — bounced off all five endpoints that ask questions.
2. **The two-audience incident prompt** — closed. `prompts/harbor/incident-body.md`
   now separates *What you are being asked to do* from *What you are NOT being
   asked to do*, which is the ambiguity Artemis reasonably resolved the wrong way.
3. **Nothing reconciles a claim against the ledger** — closed, and this was the
   serious one. `checkTriage` refuses a report whose narrative claims a task that
   `tasks.json` does not support, porting E-BRIEF-FAITH's precedent to triage.
   **29 passed.**

**A fourth defect is confirmed OPEN, and it is the one that stalls an unattended
run.** The 2026-09-01 record listed it as identified and not fixed; it is still
present, and the mechanism is now traced end to end:

- `src/main/hermes.ts:1135` — `if (this.options.isIdle && !this.options.isIdle(agentId)) continue`
- `src/main/index.ts:1700` — `isIdle: (agentId) => avatarDirector.get(agentId)?.phase === 'idle'`
- `src/shared/avatar.ts` — the phase leaves `idle` on `prompt-submitted` and
  returns only on a terminal hook event.

So **the floor's animation state gates message delivery**. A dropped or missed
terminal hook leaves an agent permanently unnudgeable, which is what cost the
live run twenty minutes, and a restart masks it. A presentation concern is
load-bearing for the company's communication path — the wake decision should
rest on the delivery plane, not on what the avatar is drawing.

**The exit criterion is NOT met.** SRS §6.1 asks for a crew that detects a
failure, **fixes it or opens a fix PR**, files the memo if policy was crossed,
and has the next briefing narrate it accurately, with zero un-gated destructive
actions. On 2026-09-01 detection passed and zero un-gated actions held; the
action half failed — Artemis said "Task opened…" and no task existed. Fixing the
three defects behind that failure is **not** evidence that the next run
succeeds; only a run is. §6.1 has not been re-run since, and this review will not
tick the row on the strength of the repairs. That substitution is what the M6
close-out audit was convened to catch.

**Gaps blocking M7's close, as unchecked items:**

- [ ] **Re-run SRS §6.1 on a real repo** — the action half specifically: the crew
      opens real work for a real failure, and the standup narrates it. Requires
      the Architect to name the repository and consent to autonomous agents
      holding `GH_TOKEN` grants running unattended against it. Nobody else's call.
- [x] **Wake must not depend on the avatar phase** — CLOSED 2026-09-02 (`8152068`).
      `isIdle` now composes `canDeliverWake(ptyManager.has, wakeClock.runningMs)`,
      two delivery-plane facts, both BOUNDED: `WakeClock.ended` closes on `stop`
      OR `session-end` with no phase guard, and the cap timer force-closes an
      overrunning wake even when every hook is lost. The phase had no such bound
      — `avatar.ts`'s `stop` is inert unless the agent was mid-tool, so any turn
      calling no tool stranded the agent for the life of the process.
      *Shipped with its second half, which is not optional: the nudge went
      through `commandQueue.submit`, which consults the same phase, and
      `wakeCheck` archives the mail BEFORE nudging — so fixing the predicate
      alone would have HELD the nudge on an already-archived message (silent
      loss) or THROWN and skipped every agent after it in `knownAgents()` order.
      Now a `wake()` path that does not consult the floor, and a failed nudge
      recorded as `wake-undelivered` before the sweep continues.*
      *Evidence: full suite 3192 passed / 0 failed; four mutations red (4/2/1/1);
      the predicate is a NAMED function because the one it replaced was an inline
      expression in the composition root, which is how it went untested —
      `s-wake.test.ts` stubs `isIdle` and is structurally blind to it.
      Doc: `docs/implementations/2026-09-02-wake-asks-the-delivery-plane.md`.*
- [ ] **E-PLAYBOOK's live drill** — the recorded scorecard scores a FIXTURE
      record through the shipped scorer; the real-engine drill (TEST-STRATEGY §6)
      is owed with §6.1.

**Unchanged and still owed** (not re-litigated here): the two live voice proofs
and the voice-driven day, all three unreachable while M6.9 is deferred and none
of them waived; the v2 floor with a real company on it; wake-word detection; the
M6 floor and Memory panel screenshots; codex/gemini hook wiring post-trust; a
real-engine respawn demo; E-STOA's LLM-judged half.

**Recorded as unresolved, not as gaps:** the budget question from the live run
is now partly answered — ADR-0023 replaced the projection-trip with usage-aware
pacing, and the 91.4% of a 24.47M-token day spent re-reading context at wake is
the measurement that matters and is untouched.

**Correction, same day (2026-09-02).** This review first recorded `s-closing`,
`s-livelock`, `s-stoploop` and `s-wake` as one family of "parallel-load races
against wall-clock deadlines", inheriting the grouping from the 2026-08-29 M6
doc that lists them on one line. **They are two problems, not one**, and the
grouping was never checked:

| suite | `setTimeout` / deadline / timing constant | actual cause |
|---|---|---|
| `s-closing` | 3 | a real race: a 500 ms deadline against a live spawn |
| `s-livelock` | 0 | merely slow — 4.65 s |
| `s-stoploop` | 0 | merely slow — 10.89 s |
| `s-wake` | 0 | merely slow — 3.84 s |

The three siblings carry no deadline at all. They were failing against vitest's
old 5-second default, which `39aad30` already raised to 30 s, and nothing in
them is broken. Only `s-closing` was a race, and it is now **fixed** (`4143464`):
`ClosingTime` already accepted `now?()`, but the deadline was a bare
`setTimeout`, so injecting the clock changed only what the log SAYS and not when
the deadline FIRES. A `schedule?()` seam closes it, `unref` preserved. Verified:
`company(1)` failed 100% with the identical assertion before and passes after —
the duration no longer matters, which is the evidence a bigger constant could
never provide. `test/scenarios/` now **202 passed** under parallel load.

Being listed on one line made four suites look like one bug for four days. The
error is the one this milestone keeps finding: a grouping accepted as a property
of the things grouped.

**Load verification of `4143464`, and two qualifications (2026-09-02).** The fix
was green on a drained machine — the condition that never reproduced the bug —
so it was re-run under three concurrent `test/scenarios/` suites with identical
load on both arms: **control (`3d5fbfa`) failed 3 of 3** with the exact
assertion, **fixed (`4143464`) failed 0 of 3**. The control arm is what makes
that evidence rather than another silent no-op.

1. **`s-stoploop`'s margin is ~2.4×, and the CONDITION is the whole finding.**
   Five people-hours went into one number and produced five answers, each a
   correct measurement of the wrong thing. The sequence is recorded because the
   lesson is not "measure carefully":

   | answer | what was actually measured | why it was wrong |
   |---|---|---|
   | 2.2×, then 1.7–1.8× | whole FILE duration | no timeout governs a file — `testTimeout`/`hookTimeout` are 30 s **per unit** |
   | 6× | slowest test, ONE run | right metric, single sample |
   | ~3× | slowest test, 4 isolated runs | right metric, distribution — **wrong condition** |
   | **~2.4×** | slowest test under a full parallel suite | the condition CI actually has |

   **Cold-start was proposed and is refuted.** Six controlled isolated runs in
   one shell — 2.96, 3.40, 3.08, 3.20, 3.07, 3.35 s — put position 1 at the
   *fastest*, so the outliers are not a cold cache. **Load is the mechanism**,
   demonstrated directly: the same test measured *during* a concurrent full
   suite gave **9.37 s**, against ~3.1 s isolated on the same machine minutes
   earlier. Under default 16-worker parallelism it reaches **12.3 s** — sixteen
   workers contending for disk and git — which is ~2.4× under the 30 s ceiling.

   So every isolated figure above, including the distribution this review
   recorded an hour ago, flattered the margin by measuring a condition CI never
   runs in. **`s-livelock` is not in better shape either**: its 1.98 s isolated
   becomes **11.0 s** under the same parallel condition (~2.7×), so the two
   files are indistinguishable and the "s-livelock has 6× headroom" line this
   review carried is withdrawn.

   **No change is needed today**, and the reason matters: the realistic
   condition is green at 2.4×, not the ceiling being unreachable. It *is*
   reachable — a 3× overload produced three genuine `Test timed out in 30000ms`
   failures (plus one `agora: git init failed`, which is apparatus starvation
   and not a timeout). Those two arguments agree now and come apart if the suite
   grows or a runner slows, so what is recorded is: **30 s was measured against
   12.3 s under real parallelism.**

   **Settled at n=12, and the figure now lives in ONE place.** Twelve full
   parallel runs give a body of **10.2–13.4 s and a single excursion at 17.3 s**
   not reproduced in the seven runs after it — so ~2.2× against the body, ~1.7×
   against the excursion, and one excursion rather than a tail. That supersedes
   every number above, including this review's own ~2.4×, which was two samples.
   The distribution and its condition are recorded in `vitest.config.mts` beside
   the timeout itself, and **this review deliberately stops restating it**: a
   figure duplicated into a second document is how six of these came to disagree.
   Read the config.

   The practical rule, which cost five wrong answers to learn: **record the
   condition beside the figure — once.** Every one of those measurements was
   correct, four were caught by someone other than their author, and the last two
   were caught only by sampling past the point where the answer looked stable.
2. **The `writeFileAtomic` retry has a reachable ceiling.** `s-deckgate` failed
   in the control arm with `EPERM … .tasks.json.tmp -> tasks.json` — the exact
   error the retry exists to absorb — with the retry live. Independently
   confirmed by instrumenting a full suite here: 2 renames recovered (284 ms and
   311 ms, six attempts each) and **1 gave up at 508 ms** against the 500 ms
   budget. So "the retry absorbs transients" is true only up to a ceiling a
   saturated machine can reach. Widening it is NOT proposed off these events: it
   blocks the main process and NFR-2's 500 ms delivery p95 is why the ceiling is
   where it is. The real fix is upstream — `Agora.commitSoon`'s fire-and-forget
   `git add -A` holds the very files the Hermes sweep renames over (reproduced
   at 1.9% and 0.55%), so the harness is contending with itself and no budget
   wins that race.

## M8 — The company you can leave running (plan drafted 2026-09-02)

**Sequence: M7 → M8 → M7b.** M8 is inserted BEFORE M7b, and that ordering is the
plan's first claim: M7b ships signed builds of a company that improves itself,
and today that company cannot survive a restart, cannot tell the Architect it
has stopped, and runs every hire in the Architect's own working tree. Shipping
that is worse than not shipping it. *(The numbering is inherited — M5b and M7b
already broke strict sequence. If the Architect prefers, M7b renames to M9; the
order is what matters, not the label.)*

**Derived from** the 2026-09-02 MVP register: five independent read-only
investigations plus direct verification against this machine's book of record.
Item ids below (B1–B17, D1–D13, DD-1–DD-7) are that register's, kept so the
evidence stays traceable.

**The standing instruction that shapes every package, in the Architect's own
words (2026-09-02):** *"our goal is not the plan for the smallest but the most
reliable and testable fix… everything reliable, maintainable and testable… we
will also work on our test coverage so we won't jump on errors and bugs on the
fly."* So M8 does NOT take the register's "minimum set". Where the register
offered a cheap fix and a correct one, these packages take the correct one, and
every package owes tests at the SEAM rather than on either half.

**Why this milestone is mostly wiring, not features.** Every M8 item is setup,
wiring or disclosure. The tree is green — 173 files, 3192 tests — and that is
precisely the problem M8 exists to fix: a suite that passes while Closing Time
has never once run, while the standup reads the oldest 500 log entries, and
while the dock renders the company's first 300 events after an overnight run.
**The recurring defect of this codebase is a check that cannot fail**, and five
separate instances of it were found in one day. M8.0 exists to make that
structural rather than a habit.

- [x] **M8.0 Coverage baseline and the seam rule** — there is NO coverage
      tooling in this repository today (`vitest.config.mts` has no `coverage`
      block, no provider is installed, `npm test` is a bare `vitest run`), so
      "improve coverage" currently has nothing to improve against. Establish the
      baseline first, then make the rule that M8 enforces: **a wiring seam with
      no test is a defect, not a gap.** Record the starting numbers per
      subsystem so later packages can be held to them.
      *ARCHITECT DECISION FIRST: a coverage provider is a NEW DEPENDENCY and
      BUILD-PROMPT §3 requires a decision memo before one lands. ~~Options: v8
      (bundled with vitest, no new package), istanbul (a package, better
      branch data), or none — measure by hand at the seams. Recommendation: v8,
      because it needs no new dependency at all.~~ **DECIDED 2026-09-02:** v8,
      as `@vitest/coverage-v8` pinned exact `4.1.11`. The struck premise was
      FALSE — it is NOT bundled; `vitest run --coverage` fails without it — and
      the choice was put to the Architect with that corrected first.*
      *Docs: ENGINEERING-STANDARDS §Definition of Done, TEST-STRATEGY §1–2.
      Tests: the gate itself — a coverage floor that fails CI when a seam
      regresses. Risk: a coverage NUMBER is the classic check that cannot fail;
      the floor must be per-subsystem and the rule must be about seams, or this
      package produces a metric that rises while the wiring stays untested.*
      *Evidence (2026-09-02): the seam rule is mechanical from BOTH sides.
      `node scripts/check-invariants.cjs` walks the import graph from the three
      electron-vite entry points (`scripts/reachability.cjs`, value edges
      only) → 158/166 src modules reached, 8 unreachable by recorded decision
      (the Herald ×7, M6.9 deferred; `contrast.ts`, its own header), 6
      type-only; the real-tree test names all seven Herald files against an
      empty allowlist. `npm run test:coverage && node scripts/check-coverage.cjs`
      gates 17 subsystems against `scripts/coverage-floors.json` — the ONLY
      place a coverage figure is written, per platform, with its condition:
      win32 measured three times at the baseline (identical to the hundredth
      every time, once under load), linux recorded from CI's own artifact.
      Full suite under coverage 3266 passed / 8 skipped (176 files) on the
      hardened tree. Tests:
      19 (reachability) + 37 (checker), over real files in temp directories;
      twenty-one mutations in two passes (nine against the first draft, twelve
      against the hardened one) each killed by a named test and reverted. CI: run
      `33615249038` on `57d4f51` failed BY DESIGN at the floor check ("no
      coverage floors are recorded for platform linux") with every earlier
      step green on Linux — which is also the Linux proof of the `which.ts`
      fix, `follows an npm-style %dp0% shim` passing where it had failed on
      every prior run — and uploaded the measurement; run `33615569423` on
      `6bfdf0f`, with the linux floors recorded from that artifact, is GREEN
      on all three jobs. After the refutation pass the same shape repeated
      under schema 2: run `33632864541` on `2080f98` red BY DESIGN at the
      floor check with every earlier step green, its artifact seeded the
      linux block (`--seed --from`), and run `33633139125` on `95dac31` is
      GREEN on all three jobs with "coverage floors ok (17 subsystems on
      linux; 24 untested modules, all recorded)"; the tree hash recorded on
      linux equals the one recorded on win32, so both blocks describe the
      same production tree. What the baseline says (figures in the file): boot
      wiring is the least-covered row, four of its five files reached by no
      test; none of the four mechanisms TEST-STRATEGY names meets its ≥ 90 %
      branch target; 24 production modules are entered by no test on either
      platform, thirteen of them renderer panels — the twenty-fourth,
      `src/main/config.ts`, surfaced only when "untested" was tightened from
      "no line run" to "no function entered". **REFUTED, THEN HARDENED, BEFORE
      CLOSE:** three adversarial refuters broke the first draft on three
      counts (a value barrel classified type-only; a deleted floor metric
      silently disabling its comparison; a deleted platform block turning
      `--update` into a re-seed) plus a dozen weaknesses, all listed in
      DECISIONS-LOG; both scripts were rewritten (exact-file allowlist,
      conservative classifier, schema-2 record with `--seed`, tree hash, stale
      report and report-equals-tree refusals, stale-floor rule) with a fixture
      case per finding. One finding stands and is the Architect's: `main` has
      NO branch protection and PR #6 merged over a red code job, so every CI
      gate is advisory until required checks are enabled. **Production call path:**
      `.github/workflows/ci.yml`, steps "Invariant tripwires" and "Coverage
      floors and untested modules", and BUILD-PROMPT §4's TEST line — this
      package's product IS the gate, and those are its callers. Docs:
      ENGINEERING-STANDARDS §6.7, TEST-STRATEGY §2, GYM-006 (ledger row,
      metric due 2026-09-16), the M8.0 implementation doc. Owed, recorded not
      built: export-level dead code (the M3 `effectivePolicy` shape) is
      invisible to both halves. Branch `feature/m8-0-coverage-seam-rule`,
      pushed, UNMERGED — merging is the Architect's. FOUND BY CI, RECORDED
      NOT FIXED: runs `33629903392` and `33633478191` (both docs-only
      commits — two of the branch's six runs) failed
      `pacing-wakes.test.ts › interrupts a wake that outruns the cap` by one
      millisecond — `WakeClock` fires on the monotonic timer and reports from
      `Date.now()`, and the test asserts `≥ cap` with no tolerance. Product
      code under ADR-0023, owed to M8.9 as a rate (about one ubuntu run in
      three; never in nine win32 runs); both jobs passed on re-run. The
      seam-rule gates did not fire either time — the floor check was skipped
      behind the red suite.*

- [x] **M8.1 The quit path, and the rig that hid it** — B1. `mainWindow` is
      assigned once and never nulled (`src/main/index.ts:611`), so after the
      window closes every send throws and BOTH quit-path subsystems die:
      Closing Time on its first log line, `AgentManager.shutdown` on its first
      agent. Verified against this machine: the book of record holds exactly one
      shutdown event (`closing-begin`, no ack, no complete, ever) and the roster
      shows `agent.artemis: ghost` with all three crew still `archived` — their
      unwind never ran. In-flight tasks stay `in_progress` on agents that no
      longer exist and worktrees are never released.
      *The rig is part of the package, not a follow-up (D12): the closing-time
      scenario copies production's handler MINUS the line that throws, which is
      why S-CLOSING is green against a protocol that has never once run. A test
      that cannot fail is the defect here, equally with the missing null.*
      *Docs: SDD §GYM-003, ADR-0011. Tests: a scenario that genuinely quits with
      an agent, a gate and an activation live, driving the REAL handler; per-agent
      failure in `shutdown` must not skip the agents after it. Risk: the fix is
      one line and the test is the whole package — resist shipping the line alone.*
      *Evidence (2026-09-03): the cause was ONE thing with three victims, read
      rather than assumed — `mainWindow` held a DESTROYED window, not a null one,
      so `?.` proceeded and all 43 sends threw. Closing Time died on its first log
      event (after the log line landed, which is exactly the `closing-begin`-and-
      nothing-else in the book of record); `AgentManager.shutdown`, an unguarded
      `for await` loop, died on its first agent; and the PTY sink WAS the window's
      `webContents`, so killing the terminals threw too. **Two seams, per the
      Architect (all four M8.1 decisions taken 2026-09-03):** `src/main/ui-bridge.ts`
      owns the window, forgets it on `closed`, checks `isDestroyed()` on both
      objects and never throws at a caller — with `check-invariants` rule 5 failing
      on a `webContents.send` written anywhere else (proven by a planted probe);
      `src/main/shutdown.ts` owns the ordered, isolated, idempotent quit sequence,
      which `index.ts` and the scenario rig now BOTH construct. **Every quit
      gesture runs it once** (`before-quit` holds the exit): menu Quit and Cmd-Q
      used to skip closing time entirely, and on macOS the old handler tore the
      company down while leaving the app alive. SDD §1.1 gained both modules and
      §612's quit row is amended with the new coverage and the phase isolation.
      `AgentManager.shutdown` isolates per agent and returns a report naming who
      failed. **The rig can no longer be production-minus-a-line:** its closing
      time sends through the same bridge, and the two leaves it still substitutes
      (`liveAgents`, a null `agents` seam — a scenario company has no
      `AgentManager`) are named in the rig with the reason, with that class's own
      isolation proven directly in `agents.test.ts`. Tests: 14 (bridge) + 18
      (sequence) + 3 (agent isolation) + 4 (S-CLOSING over real fake-engine
      processes with the window already destroyed). **Eleven mutations, each
      killed by a named test and reverted** — the destroyed check, the closed
      listener, the stale-close guard, the fault report, the phase order, the
      idempotence, per-agent isolation, per-step isolation, the agent-shutdown
      catch, the empty-floor guard and the reentry guard. Gate: typecheck, lint,
      invariants (reachability 160/168) green; suite **3305 passed / 8 skipped**
      across 178 files under coverage; `npm run build` green, which is what
      exercises the rewired boot path beyond typecheck. The M8.0 stale-floor rule
      FIRED on its own first real occasion — `boot` rose past its ratchet lag
      because the extracted modules are tested — and the floors were ratcheted
      (figures live in `scripts/coverage-floors.json`, never in prose).
      **Production call path:** `src/main/index.ts` `before-quit` → `QuitSequence`;
      `createWindow` → `ui.attach(win)`; `ptyManager.attachSink(ui)` once at boot.
      CI: run `33795362973` on `a283ee1` failed BY DESIGN on the M8.0 stale-floor
      rule (boot past its ratchet lag on linux too) with every other step green,
      its artifact ratcheted the linux block, and run `33795656144` on `c0b431b`
      is GREEN on all three jobs.
      OWED, RECORDED NOT FIXED: gates and activations are in-memory, so a quit
      still loses an open gate while `tasks.json` may hold its id (B17) — carried
      as a CHARACTERIZATION case in S-CLOSING that passes today because the loss
      is real, for M8.8 to flip. Branch `feature/m8-1-quit-path`.*

- [x] **M8.2 The degradation channel** — B2, D9. `reportDegradation` is a console
      line plus a 50-entry in-memory ring surfaced only in a tooltip: it never
      reaches `log.jsonl`, it is gone at restart, and the wake-deferral emitter
      feeds it undeduped at a measured ~1/s so it self-evicts within a minute.
      Every setup failure and every runtime degradation in this milestone reports
      through it, so this package PRECEDES the rest — until it lands, a
      first-time user cannot see why anything else failed.
      *Docs: BUILD-PROMPT §3 (every degradation visible), invariant §7.
      Tests: each degradation SOURCE reaches the log with its reason; the ring
      survives a flood without evicting unrelated entries; an undelivered wake
      reports as itself and not as a generic sweep failure. Risk: dedupe that is
      too aggressive hides a real repeat — dedupe by cause, not by text.*
      *Evidence (2026-09-03): three Architect decisions shaped it — a new
      `degradation` LOG KIND (a condition the company runs under, not an event:
      only a condition can be cleared or replayed, so `error` would have been a
      bucket answering neither well); a BOUNDED LADDER into the append-only file
      (first occurrence, then each power of ten, then the clear — an hour of a
      once-a-second condition costs five lines instead of 3,600, with the exact
      count always live in the UI); and a BOOT REPLAY marking a surviving
      condition `carried`, so a morning no longer looks healthy whatever the
      company is missing. **Dedupe is by CAUSE and the cause is a type:**
      `<source>/<slug>` over a closed source list, so a typo is a compile error
      and the source is derived rather than passed beside it. Assigning 61 causes
      was the bulk of the package and its point — `library` alone had four
      conditions a source-keyed dedupe would have collapsed, and per-agent
      conditions carry the agent because two agents stuck is two problems. The
      ring now holds CAUSES, so the pacing flood (D9) cannot evict anything:
      the test asserts an unrelated entry SURVIVES 500 reports rather than
      asserting a count. Also landed: `eventlog.tailOf` / `agora.tailLog`,
      because `readLog` pages FORWARD from a cursor and a replay wants the
      newest — that is B3, and M8.3 inherits the tool rather than a workaround.
      Reporting cannot fail: `report` never throws, the append is best-effort,
      and rows raised before the Agora opens are buffered and flushed in order.
      Tests: 22 (channel, including the 600-entry tail-vs-head case and the
      overflow cases below) + 4 (the line the Architect reads, typed against
      the IPC shape) + 2 (the Agora tail the boot replay calls). Suite **3333
      passed / 8 skipped** across 180 files under coverage; CI run
      `33799028254` GREEN on all three jobs, first try. **Eight
      mutations, each killed by a named test and reverted** — dedupe by text,
      no ladder, replay marked live, replay overwriting a live entry, a cleared
      condition returning at boot, the carried marker dropped, the count
      dropped, and the tail reading the head. The M8.1 suite CAUGHT this
      package's own contract change (four assertions on the old bare sources),
      and the M8.0 FLOORS REFUSED THE PACKAGE TWICE before it landed: once
      because a new module at 93% dragged the `agora` row under its floor —
      the eviction path had never run, because the flood test used a limit
      larger than the number of causes it created — and once because
      `agora.tailLog` was a function no test called. Both were real holes;
      neither floor was lowered.
      which is the seam rule working in the direction that matters.
      **Production call path:** `src/main/index.ts` constructs `DegradationLog`
      at module scope; `reportDegradation` delegates at 61 sites; boot calls
      `degradations.replay(agora.tailLog(...))` after `agora.reconcile()`; the
      `agora:health` handler serves `degradations.list()` to `App.tsx`, which
      renders each entry through `degradationLine`. Docs: SDD §4.3 (the kind and
      its semantics) and §1.1 (the module). Branch `feature/m8-2-degradations`.*

- [x] **M8.3 The log-derived surfaces tell the truth** — B3, B4. `readLog()`
      defaults to the OLDEST 500 entries and three callers use the default, so
      the standup's cursor pins at 500 and every later brief filters to empty:
      measured, 676 of 1177 entries invisible, with a retro on disk reporting
      `log#1–log#499` against a highest seq of 1117. The Activity panel starts
      its cursor at zero and never loops, so an overnight run shows the company's
      FIRST 300 events; Hermes (282 of 1177 entries) appends directly and pushes
      nothing; 19% of rows render blank; and the breaker case reads `signal`
      where the emitter writes `signals`, blanking the reason on all 93 rows.
      *Docs: SDD §4.3, UI-DESIGN §Activity. Tests: a log with more than 500
      entries — the fixtures that hid this are all smaller than the default;
      a Hermes append reaches the panel; every log kind the harness emits has a
      case. Risk: none of these fail loudly, so the tests must assert on WHICH
      entries render, never on how many.*
      *Evidence (2026-09-04): five defects, one package, and every case runs
      against a log LARGER than the old window — that window IS the defect,
      and every fixture in this repository was smaller than it, which is why
      a green suite never saw any of this. **(1)** The renderer now learns
      that the book grew from the book itself: `Agora.onAppend` is a
      publish/subscribe on the single writer (the Architect asked for pub/sub
      rather than a hook, for the flexibility and the testing chances), so
      Hermes — 13 append sites, 282 of 1,177 entries, never pushed once — is
      covered by construction. Thirty-one hand-written pushes collapsed into
      one subscription; the one that survives is the company-mode `onChanged`,
      which fires for the Gymnasium LEDGER, a different file. Contract, each
      clause with a case: delivered after the entry is ON DISK, in order,
      synchronously, one subscriber never costing another its event nor
      failing the append, delivery over a snapshot. **(2)** `readLogAll` /
      `readLogSince` read to the END with the cost reported through the M8.2
      channel (`agora/log-size`, default 50 ms): the standup read the oldest
      500 and THEN filtered by a cursor that had passed it, so every later
      brief was compiled from nothing; the org metrics folded 500 of 1,177
      rows; the §6.9 proof gate could not see older evidence. **(3)** The
      Activity panel opens at the END of the book through `agora:logTail` —
      the reader M8.2 added for the degradation replay, reused rather than
      re-derived, which is the same defect B3 names. **(4)** `logRowSummary`
      moved to `shared/log.ts` beside the kinds, total over them with no
      `default` and a `never` check, and unable to return an empty string.
      **(5)** The breaker row reads `signals` (plural, an array) as every
      emitter writes it; `signal` had blanked the reason on all 93 rows while
      the row still looked populated. Tests: 10 (whole-log reads and the
      pub/sub) + 40 (the row, one realistic payload per kind plus the awkward
      shapes) + 5 (the REAL panel mounted against a 1,177-entry log). Six
      mutations, each killed by a named test and reverted. Gate: suite **3388
      passed / 8 skipped** across 183 files under coverage; floors green, and
      the untested-module count fell 24 → 23 because the panel is now entered
      by a test. The floors REFUSED the package once more, on branches this
      time: `logRowSummary`'s one-sided flow, boolean and non-list fields, the
      fallback bound, and the exhaustive arm — the last reached with a cast
      and documented as what it guards, an entry whose kind comes from a NEWER
      version. **Production call path:** `index.ts`
      `agora.onAppend(() => ui.send(LOG_APPEND_CHANNEL))` after the degradation
      replay; `BriefingJob.gather` → `readLogSince`; `OrgLayer.gather` and
      `CompanyModes.gymEvents` → `readLogAll`; `ipcMain.handle(agoraLogTail)` →
      the panel’s first read. Docs: SDD §1.1 (`agora.ts`, `eventlog.ts`).
      Branch `feature/m8-3-log-surfaces`.*

- [x] **M8.4 The setup cliff** — B5, B6, B8, B9, D11, D13. Four config files the
      harness requires, creates itself, and does not document; each absence is
      silent. `gate-policy.json` missing returns deny-all with `warning: null`,
      which makes autonomy `manual` and every agent sit at a permission prompt —
      unattended running is impossible out of the box, with no error anywhere.
      `authority.json` missing leaves Artemis with zero delegated authority on
      every install that has ever existed. A missing `github-app.json` is silent
      while the activation preview affirmatively promises `GH_TOKEN`. Nothing
      probes engine AUTHENTICATION, so a logged-out CLI spawns, parks at its
      login screen, and reports `running`. The README has no setup section and
      its status is two milestones stale.
      *ARCHITECT DECISION (DD-1): what the shipped gate policy grants. Deny-all
      is defensible and makes the product unusable on first run; permissive makes
      "the Watch held every gated action" untrue by default. This one decision
      most determines whether a stranger's first afternoon works.*
      *Docs: README, ADR-0010, ADR-0011, SDD §2. Tests: each absent file produces
      a VISIBLE, named degradation and not a silent default; the activation
      preview asks the broker whether a declared grant can actually be supplied,
      rather than asserting it. Risk: shipping example configs that drift from
      the schemas they illustrate — generate or test them against the schema.*
      *Evidence (2026-09-04): **DD-1 DECIDED — the shipped ceiling is a real
      ceiling.** Autonomy composes stricter-wins, so the old `manual` fallback
      did not make the company careful, it made every profile decorative: the
      Skeleton Crew ships `autonomous` with its irreversible classes at
      `supervised` and ran at `manual` for everything on every install that has
      ever existed. The shipped policy is `autonomous` with `destructive`,
      `prod-facing`, `scope-change`, `outbound` and `spend` at `supervised` and
      `needs-human` at `manual`; `tool-permission` is deliberately absent
      because `evaluateGate` refuses that kind by construction. Both shipped
      files are `schema.parse(...)` VALUES, so the package's own drift risk is
      a module-load failure rather than an unvalidated JSON literal, and a test
      asserts the round trip through the real loader. `home.ts` seeds them only
      when ABSENT — `~/.ephesus/` is the Architect's copy — and reports what it
      created through the M8.2 channel under a new `home` source. A missing
      policy now names its CONSEQUENCE instead of falling back in silence; the
      existing test that asserted the silence was reversed deliberately, with
      the reason in its body. **Artemis ships with FR-5.5's own example**:
      `route` and `task` everywhere (that is her job), `memo` on `test-code`
      and `docs`, and NOT `gate` or `spend` — the requirement names spend as
      what she may not have. **The activation preview asks the same resolver
      the spawn asks** (`resolveDeclaredGrants`), so `grantsUnavailable` is on
      the plan and the screen can no longer promise a `GH_TOKEN` the broker
      cannot supply; the parameter is required, because a default of "assume
      available" is the silent assertion it exists to remove. **A logged-out
      engine gets `needs-login`** (Architect decision) with the fix command on
      the card, is NOT started, and the dock says why instead of "no signal
      yet". The probe is the adapter's (ADR-0009), THREE-VALUED — cannot-tell
      is trusted, not refused — and reads the denial FIRST, because `Not logged
      in` contains `logged in`. README gained a setup section and a status that
      is no longer two milestones stale. Tests: 11 (setup cliff) + 6 (auth
      lifecycle) + 5 (the adapter predicate). Gate: suite **3410 passed / 8
      skipped** across 184 files; floors ratcheted (`home` rose past its lag).
      **Five mutations, each killed by a named test and reverted** — and the
      substring one SURVIVED its first pass, because the denial-first ordering
      caught it and the pattern itself was untested; the case that makes the
      pattern load-bearing was added and it then died. **Production call path:**
      `ensureHarnessHome` → `boot()` reports `seeded`; `loadGatePolicy` feeds
      the `GateManager` and `ProfileActivations.globalAutonomy`;
      `resolveDeclaredGrants` is the AgentManager's `resolveGrants` AND the
      activation's `missingGrants`; `AgentManager.spawn` calls `checkAuth`
      between the version probe and `start`. Docs: SDD §1.1 (`home.ts`), §3
      (the lifecycle), README. CI: run `33811602043` on `104b1c5` red BY
      DESIGN on the stale linux floor with everything else green, its artifact
      ratcheted the block, and run `33811944369` on `8998918` is GREEN on all
      three jobs. Branch `feature/m8-4-setup-cliff`.*

### M8.3 / M8.4 defect clearance (2026-09-04) — 2 defects, 7 surviving mutants

An adversarial pass over both merged packages, at the Architect's instruction
that nothing may survive. Both had landed green; 52 targeted mutations and a
read of the production code against what the world actually does found this:

- **The login probe could not read the engine it was written for.** The shipped
  matcher looked for `logged in as` / `account:`; the real CLI answers JSON by
  default (`{"loggedIn": true, …}`, verified on 2.1.252) and `Login method: …`
  in its opt-in `--text` mode. It matched NEITHER, always answered "cannot
  tell", and `needs-login` could not fire on any machine — while the README
  told the Architect Ephesus asks at every spawn. Forty-five tests passed, all
  of them fed strings we wrote ourselves. Third instance of the shape
  (`reproduce`/`prod` in M7.4; a spoken refusal confirming a gate in M6), so it
  is now a **rule**: ENGINEERING-STANDARDS §6.8, enforced by
  `scripts/check-invariants.cjs` rule 6 against
  `test/fixtures/engine-output/PROVENANCE.json`. **Six bypasses attempted, six
  caught** before the gate was believed.
- **The Activity panel's opening race could restore B4.** An append landing
  before the tail read answered issued a forward page from seq 0; if it answered
  second it appended the company's FIRST rows and rewound the cursor — the exact
  defect the tail read was added to fix, on that code path. Fixed with two
  independent guarantees (monotonic `absorb`, no page before the panel opens),
  each killed by its own test.
- **Seven surviving mutants, now dead.** `grantsUnavailable` gutted to `[]`
  (M8.4's "the preview asks the spawn's resolver" — asserted nowhere); the
  dock's whole `notReady` branch deleted, and its fix command deleted (M8.4's
  `needs-login` visibility — asserted nowhere); an adapter declaring no probe
  read as logged out; the shipped 200k spend ceiling changed to anything; the
  Agora's publish snapshot; the `×1` suppression.

*Evidence: 22 new cases. Mutation score on the same 40-mutation set 33/40 → 40/40,
plus 12 new mutations over the new code, 12/12 killed. `typecheck && lint &&
check-invariants && test:coverage && check-coverage` green. Branch protection on
`main` APPLIED (see AUTOMATION.md — the previous session's "the API answers 404"
was a misreading of GitHub's ordinary `Branch not protected`). Doc:
`docs/implementations/2026-09-04-m8-3-m8-4-defect-clearance.md`. Branch
`fix/m8-3-m8-4-defects`.*

- [x] **M8.5 The mission actually watches the repository** — B7. Shipped bundles
      carry `repos: []`; the activation plan is the only source of that list; and
      the ingest cadence disables itself entirely when every instance has zero
      repos. So activating the Skeleton Crew against a real repository watches
      nothing — no CI, issue or PR ingestion, therefore no incident can ever be
      raised. The flagship mission is inert on first use, and this machine works
      only because `harbor.json` was hand-edited.
      *Docs: ADR-0012, FR-10.3, SDD §7.5. Tests: activation with an empty
      `harbor.json` still ingests from the named target; the cadence stays armed.
      Risk: deriving the repo from the target guesses a remote — refuse and say
      so when the target has no unambiguous remote, rather than inventing one.*
      *Evidence: the checkout is asked which repository it is (`git remote -v`
      through `readRemotes`, the one module allowed to run git; the parse and the
      refusal are `src/shared/repo-remote.ts`), the answer is SHOWN on the
      activation screen with where it came from, and the **Architect may
      overrule it** — the three-part shape they chose over deriving silently
      (a wrong guess files incidents against somebody else's repository) and
      over asking them to type it (a setup step on the flagship first-run path).
      Precedence: architect → bundle → target → nothing WITH THE REASON, and the
      reason names the consequence. **Refusing is a first-class answer**: a fork
      names both candidates and says `name the one to watch`; several remotes
      naming one repository is not ambiguity; a non-github remote beside a
      github one is not either. A remote URL is NEVER echoed (`gh` writes
      `https://x-access-token:<token>@…`) and a Windows drive letter is not a
      host — a Windows path had parsed as scp-with-host-`c`. `watchedRepos`
      replaced two inlined expressions in `index.ts` — the Harbor's ingest list
      and the cadence's arming condition — for the M7.4 reason. `preview` is now
      async because the remotes are READ, never cached. An instance that comes
      up watching nothing is not refused (that would be a new cliff) but
      REPORTED, through the M8.2 channel and on the screen in the warning
      colour, and CLEARED when it starts watching something or is torn down —
      one callback carrying both directions, found by the adversarial pass on
      this package's own code, because a degradation raised and never cleared is
      the failure M8.2 exists to prevent. A repository override typed for one
      checkout is also dropped when the target changes, since letting it follow
      the Architect elsewhere is the wrong-repository outcome the derivation
      refuses to risk. Tests: 52 new cases — the parse and the refusal, `readRemotes`
      against REAL git in temp repositories plus an injected runner for the
      lines git will not print on demand, the precedence table, the seam through
      the shipped `ProfileActivations`, the screen, and **S-PROFILE end to end**:
      a real `git init` checkout with one GitHub remote + the shipped
      Skeleton Crew (`repos: []`) → an incident actually raised, and its
      opposite, a fork refused with nobody woken for either side. **33 mutations,
      33 killed** (4 survived the first pass — the fetch/push anchor, dedup,
      sort, and the warning colour, which the page carried elsewhere; each got
      the case that makes it load-bearing). **Production call path:**
      `index.ts` `resolveRepos` → `readRemotes(gitRunner, target.path)` →
      `deriveRepo` → `ProfileActivations.preview` → `activationPlan`;
      `watchedRepos` is the `GitHubHarbor.repos` source AND the
      `harbor-github` scheduler's `enabled`. Docs: SDD §1.1 (`git.ts`,
      `profiles.ts`),
      `docs/implementations/2026-09-04-m8-5-mission-watches-repository.md`.
      Branch `feature/m8-5-mission-watches-repository`.*

- [x] **M8.6 Crew isolation and survival** — B10, B11, B12. The profile spawn
      path never requests worktree isolation (verified: zero `worktree`
      references in it), so every hire runs git operations and file edits
      concurrently in the Architect's own checkout — **the one item in the
      register that can destroy the Architect's uncommitted work.** The breaker's
      state is dropped on every exit including the stop it just performed, so an
      exhausted budget cycles instead of stopping: measured, 21 climbs to rung 1
      and exactly one completed rung-3 stop across a 24.9M-token day. And nothing
      respawns a crew agent — 46 respawn-scheduled rows, all Artemis, zero crew,
      while crew logged terminal exits four, five and five times.
      *Docs: UC-01 alternate 2a, ADR-0011, ADR-0013. Tests: concurrent hires
      never touch the target checkout; a breaker-caused exit KEEPS its rung; a
      crew death surfaces a respawn offer. Risk: worktree-per-hire makes the
      orphaning in M8.1 real rather than vacuous — these two land together or the
      second creates the leak the first cleans up.*
      *Evidence (2026-09-04): **four Architect decisions taken before a line was
      written**, all recorded in DECISIONS-LOG. (1) Isolation is DECLARED in the
      shape autonomy already uses — hire template → profile document → built-in
      default, then the Architect's per-activation choice, then a clamp for a
      target with no repository — and **the built-in default is `worktree`**,
      because "declares nothing" described both shipped bundles for their entire
      production life. `PlannedHire.spawn.worktree` is DERIVED from
      `isolation.effective` in one expression, so the screen's sentence and the
      spawn's flag are the same decision; asserted for every hire under every
      choice. Both bundles now declare `isolation` and `onExit` and took a
      version bump for it (ADR-0012 makes the version a record). (2) **A spawn
      that cannot be isolated is REFUSED**, naming git's own reason and releasing
      the claimed id — the old code logged and continued in the Architect's
      checkout, calling isolation "a nicety", and that fallback IS the harm.
      (3) **A rung-3 stop outlives the exit it caused** (`BreakerStop`, recorded
      BEFORE the stop is performed, since `onChange` is about to call
      `forgetSession`); `forget` became `forgetSession` / `forgetAgent` /
      `clearStop`. Keeping the rung alone would have fixed NOTHING — spans go
      with the process, so `nextRung(3, false)` returns 0 on the next sweep.
      (4) The respawn offer is **rendered at last** (`RespawnOffer` had zero
      references outside main since M3, so SDD §10's crash row had never once
      been shown) with an `agents.respawn` IPC, AND a hire may declare
      `onExit: "respawn"` for the ladder automatically. The ladder was EXTRACTED
      from `artemis.ts` — one ladder, two callers — with her 653-line suite as
      the regression net, green unchanged throughout. **Found while building,
      not in the plan:** Artemis was exempt from her own stop; her ladder now
      asks the same predicate, or rung 3 is a pause rather than a rung.
      Gate: typecheck, lint, invariants (reachability 166/174) green; suite
      **3616 passed / 8 skipped** across 190 files; coverage floors ok on win32
      (17 subsystems, 23 untested modules) with **no floor lowered by hand** —
      `artemis` and `engines` ROSE. The gate caught the first draft diluting
      `boot` with untested wiring in `index.ts`, and the fix was M8.1's own
      precedent: the decisions moved into `createCrewSurvival` /
      `respawnBlockReason` where tests reach them. **REFUTED BEFORE CLOSE:**
      28 mutations, **two survived the first pass and both were real** — the
      rung-3 guard inside `AgentManager.respawn` (the path with no ladder: the
      Architect pressing "bring it back") and `RespawnOffer.blockedBecause` were
      each enforced only where something else already enforced them, which is a
      check that cannot fail; four tests closed them and the second pass killed
      28/28. **Production call path:** `activationPlan` → `ProfileActivations.activate`
      → `AgentManager.spawn({ worktree })` → `git.ts` `Worktrees.create`;
      `onChange` → `crew.noteCard` / `breaker.forgetSession`; `agents:respawn`
      → `AgentManager.respawn` → `respawnBlocked`. Docs: SDD §1.1 (`respawn.ts`),
      §3, §4.3 (the new `respawn` log kind), §9, §10 (three amended rows), the
      M8.6 implementation doc. Owed, recorded not built: the demo half — no
      profile has been activated on a real target repository in the shipped app
      under these rules, which is M7's still-open exit criterion. Branch
      `feature/m8-6-crew-isolation`.*

      **POST-CLOSE DEFECT CLEARANCE (2026-09-05, ADR-0025).** An adversarial
      audit of this package — 8 lenses, 58 findings — returned one that survived
      every refuter, and it was M8.6's own doing: **isolation silently re-opened
      the failure ADR-0021 exists to close.** ADR-0021 pre-trusts
      `request.target.path` in Claude Code's own trust store; M8.6 then moved
      every hire into `<home>/worktrees/<agentId>`, and the engine matches its
      trust key on the exact resolved path — so no crew agent's real working
      directory was ever trusted, every one met the first-run dialog (highlighted
      default `No, exit`) BEFORE any session existed, and therefore with no hook
      to report it. That is the live MUSAHIT parking failure, re-entered from the
      other side. **No test could have caught it: nothing related the directory
      the trust record NAMES to the directory the agent is spawned INTO** —
      `claude-trust.test.ts` only ever passed a bare directory and no activation
      test opened `.claude.json`. The same shape as the two defects M8.6's own
      mutation pass found. Fixed at activation time, because ADR-0021 forbids the
      obvious wiring by name ("never from spawn, respawn, or a wake", with
      pre-trust-at-spawn listed as a rejected option): `ProfileActivations` gained
      a `beforeHires(plan)` seam, and `plannedWorkspaces(plan, worktreePathFor)`
      names the target plus one entry per isolated hire. **The anti-drift property
      is the fix** — it reads the same plan object the hires spawn from and asks
      the same path function the lifecycle spawns with, because a trusted path one
      character off is a record nothing reads whose only symptom is a hung agent;
      `index.ts` had three independent copies of the worktree root and now has
      one. `realpath` cannot guard a directory git has not made, so
      `WorkspaceExistence` makes the two cases explicit: `must-exist` (the
      default, so every pre-existing caller is bit-identical) resolves the whole
      path, `will-be-created` resolves the PARENT and appends the leaf — the
      parent is harness-owned, so nothing an attacker controls is left unresolved,
      and a test proves both modes produce the SAME key once the directory
      exists. Tests: 6 (trust) + 7 (workspaces). **13 mutations, 13 killed**,
      including the original blocker, a partial set, a `beforeHires` that never
      runs, one that records consent for a refused plan, and a default flipped to
      the weaker mode. **Method note, recorded because it cost two passes:** `src/**`
      is CRLF, so a mutation anchored across a line boundary never applies and the
      harness prints NOT-APPLIED, which reads like a mutation that ran — five of
      ten silently did not run the first time, including the blocker's. Single-line
      anchors only. Docs: ADR-0025 (extends 0021 — ADRs are append-only and this
      widens an accepted security decision), SDD §1.1 `engines/` row and §3, the
      M8.7 trust implementation doc. OWED, RECORDED NOT FIXED: no profile has been
      activated against a real repository in the shipped app under these rules, so
      SECOND CLEARANCE, same audit: the quit's DISARM
      phase. M8.6 registered `crew.stop()` among the quit's `steps` with a
      comment reading "Before the unwind, not after"; `QuitSequence.execute`
      runs closing → unwind → `steps`, so `steps` is LAST and every ladder was
      armed while the unwind killed the agents it watched. Nothing caught it
      because no test related the phase a step is REGISTERED in to the phase it
      RUNS in. `disarm()` now runs between closing time and the unwind, isolated
      like `steps` and with its own degradation cause; `Artemis.stop()` joined
      it, having had zero production callers. 5 tests, 3 semantic mutations
      killed (2 survivors were deliberate no-op anchor controls). the end-to-end claim rests on the key-equality test rather than observation
      — M7's exit, still open.

- [x] **M8.7a Engine isolation, and whose autonomy hinge it is** — B13, first
      half. Every hire now runs its OWN engine install: one config directory per
      agent under `~/.ephesus/engines/<engine>/<agent>/`, the Architect's
      credentials borrowed rather than copied, and the harness as the **only**
      author of the hooks that install runs. Built on the CONTROL claim, not the
      cost one — the 64.8–67.4k token floor was measured on a machine with an
      unusually large personal config, but six Stop hooks per turn of which five
      were foreign is not machine-specific, and any of them could answer
      `{"decision":"block"}` outside the harness's decision: uncounted by the
      block cap, invisible to the breaker's stop-loop signal, unaffected by
      pacing. THIS repository is an instance — `.claude/settings.json` here ships
      a Stop hook that blocks on a red typecheck, and the company's standing
      mission points crews here first.
      *Evidence: ground truth established by EXECUTION before any code —
      `CLAUDE_CONFIG_DIR=<fresh> claude auth status` reports `loggedIn:false`
      (isolation alone parks every hire on a login prompt), adding
      `CLAUDE_SECURESTORAGE_CONFIG_DIR` reports `loggedIn:true` with the config
      still isolated, and `projectsDirectory` moves with the config dir. The
      obvious mechanism — `CLAUDE_CODE_MANAGED_SETTINGS_PATH` +
      `allowManagedHooksOnly` — is INERT in this host mode (tested in both its
      directory and file forms; foreign hooks still fired), so the lockdown is
      two CLI flags: `--setting-sources=` and `--settings <harness file>`.
      END-TO-END on the adapter's REAL composed spawn plan (bundled with esbuild
      and executed): harness hook fired, repository hook did NOT. REFUTATION
      CONTROL, the identical plan with exactly that one flag removed: repository
      hook fired — the defect reproduced, so the check can fail. Gate: typecheck,
      zero-warning lint, invariants (reachability 168/176), **3678 passed / 8
      skipped** across 193 files, coverage floors ok with none lowered. 14 new
      isolation tests. Docs: ADR-0026 (extends ADR-0013, narrows ADR-0009's
      settings hygiene; ADR-0025 was also missing from the ADR index and was
      added), the M8.7a implementation doc. Branch
      `feature/m8-7-engine-isolation`.*
      **Four Architect decisions, taken 2026-09-05, do not re-litigate:** one
      config dir PER AGENT (not per company — the engine rewrites its config file
      wholesale and a crew is the concurrent case); LOCKDOWN (not isolation-only,
      which would have sounded like it closed the hole); SHARED credentials (an
      agent runs as the same OS user and can read the credentials file anyway, so
      a separate one buys accounting, not containment); and the harness
      RE-SUPPLIES a curated tool set per profile.
      **Consequences recorded, not discovered:** a target repository's hooks no
      longer run for hired agents (here: `on-stop-check.sh`, `post-edit.sh`); its
      `.mcp.json` no longer reaches an agent (and neither does the `Pending
      approval` gate that came with it); the settings file left every checkout,
      so `settings-install.ts`'s hardest case cannot arise. **Noticed, not
      fixed:** the engine warns that the mailbox grant's `Write(<dir>/**)` rule
      "is not matched by file permission checks — only `Edit(...)`" — predates
      this package, owed to whoever next touches `mailboxPermissions`.

- [x] **M8.7b The harness re-supplies the tools, by name** - B13, second half.
      The M8.7a lockdown also hides a target repository's own skills and
      subagents from a hired agent (MEASURED). A hire template now declares
      `tools` - a named root (`target`, or `home` for `~/.ephesus/tools/`) plus a
      relative path - which the harness resolves and hands over as one
      `--plugin-dir` per directory. ONE mechanism, not two: `--agents` is
      deliberately unused, because a directory already carries skills, subagents
      and commands together and two ways to say one thing is two code paths to
      keep in step.
      **REFUSES on escape, REPORTS on absence** - different failures. A path
      outside its root is a bundle asking for what it may not have, so the WHOLE
      set is refused (honouring seven of eight would be a security decision taken
      by a loop); a directory simply not there is the `envGrants` case, so it is
      a visible degradation. Containment is judged on REALPATHS with the root
      resolved too - a string-prefix check passes every test written for it and
      then fails on the OneDrive junction the harness home actually sits under.
      *Evidence: the mechanism measured before the schema was designed -
      `--plugin-dir` works under the lockdown AND accepts a directory with no
      plugin manifest, which is what makes granting a repository's bare `.claude`
      possible without asking the Architect to add one. END-TO-END through the
      harness's own resolution (bundled with esbuild and executed): with the
      grant the engine reports the repository's skill available, without it, not.
      Gate: typecheck, zero-warning lint, invariants (reachability 170/178),
      **3700 passed / 8 skipped** across 194 files, coverage floors ok with none
      lowered. 15 new grant tests + 4 `toolsFor` + 3 spawn-window. Docs:
      ADR-0026 clause note (the ADR named this owed and it landed the same day),
      SDD 3, the M8.7b implementation doc.*
      **A LIVE PRE-EXISTING DEFECT, found while wiring this and fixed here.**
      `AgentManager.spawnConfig` asks `ProfileActivations` for a hire's autonomy
      DURING the spawn, and the instance was registered only AFTER the spawn
      loop - so the answer was always `null`, and `null` means `manual`, and
      `claudePermissionMode` maps `manual` to `--permission-mode default`. **Every
      agent that arrived through a profile spawned with the engine's permission
      prompt fully armed, whatever autonomy the Architect had granted** - exactly
      the complaint `AgentSpawnConfig.autonomy` was added at M7.7 to answer. The
      suite was green either side of it because every test asked AFTER
      `activate()` returned, which is a different question. Fixed with one seam:
      an `activating` SET (two activations can overlap) held in a `finally` (a
      flag cleared on the happy path leaks on every failure), and one private
      `planFor` both callers read. The three tests that pin it FAILED on the old
      code first - `expected null to be 'autonomous'`.
      **THE SUITE COUNT NEEDS ITS CONDITION — two sessions already disagreed
      about it on the SAME commit and the same machine.** `test/renderer/
      tileset.test.ts`'s "installed tileset drop" block collects **three extra
      cases when the Architect's licensed art packs are restored in that tree**,
      and none when they are not. The sheets are gitignored (their licence
      forbids redistribution), so a fresh git worktree and CI both run it empty.
      At `1da4b81`: **3703 passed / 8 skipped WITH the drop** (the Architect's
      main checkout), **3700 WITHOUT** it (a fresh worktree, and CI). Same tree
      hash, same machine, both numbers correct. A session that compares its own
      count against a recorded one WILL conclude the suite shrank; record the
      condition or the number is not evidence. Established by diffing
      `npx vitest list` between the two trees, which names the three cases.

      *OWED: the autonomy defect deserves a SCENARIO test asserting the spawn's
      `--permission-mode`, not only a unit one; nothing reaps
      `~/.ephesus/engines/<engine>/<agent>/` yet.*
      *CI FLAKE, a NEW class, recorded so it is not re-diagnosed: run
      `33965218754` on `05ba1f8` failed in the **Install** step, not the suite —
      `npm ci` → `better-sqlite3` → `node-gyp rebuild` died with
      `AssertionError: assert(!this.paused)` inside undici while downloading the
      node headers. Nothing to do with the commit; `gh run rerun --failed`
      passed. This is DISTINCT from the M8.0-era ubuntu flake owed to M8.9 (a
      one-millisecond timing assertion in `pacing-wakes.test.ts`) — that one is
      product code, this one is the toolchain, and only the second is fixed by
      re-running.*

- [x] **M8.8 A restart is survivable** — B16, B17, D1, D7, D8. Activation state
      is one in-memory map with no boot replay, so a restart silently un-hires
      the company: the Harbor stops watching, every armed trigger is gone, no
      crew respawns, and profile autonomy stops composing into gates — with
      nothing in the UI saying the watch stopped. Gates are in-memory while the
      BLOCK is durable (the gate id is written into `tasks.json` and a task
      cannot reach *done* while it holds one), so a gate opened at 3am and
      unanswered at restart blocks its task forever, with an empty approvals
      queue and no way back but hand-editing the file. Trigger last-fired times,
      incident correlation, breaker rungs and capacity parks all evaporate too.
      *Docs: NFR-5 ("on restart, restore exactly"), SRS §6.6, ADR-0012.
      Tests: S-BLACKOUT must restart with an agent, a gate, an activation and an
      armed trigger LIVE — today it restarts with none of them, which is why this
      class was invisible. Risk: replay spawns fresh agents unless the session id
      is recovered; `--resume` is a follow-on and must be stated as owed, not
      quietly skipped.*
      *Evidence (2026-09-05): **two Architect decisions shaped it** — per-subsystem
      stores plus one replay module (not a single `session.json`, which would tie
      fast-changing state to slow-changing state permanently and lose everything
      to one corrupt file; not a rebuild from `log.jsonl`, which is a good
      milestone but needs rotation that is M8.10 and unbuilt); and **restore the
      activation without respawning the crew**, because without engine session
      recovery a respawned agent re-reads its mailbox and redoes in-flight work,
      which is the double-processing SRS §6 criterion 6 forbids.
      **THE REGISTER WAS HALF WRONG, AND READING THE CODE IS WHAT SHOWED IT.**
      Of the five items listed as lost, THREE are not, and each refutation is a
      decision already recorded in the tree: incident correlation is in memory
      *deliberately* (`incidents.ts` argues a restart SHOULD re-raise a
      still-failing incident, because a duplicate is cheap and a dropped one is
      the subsystem not working); capacity parks are DERIVED — `CapacityWatch`
      re-reads each transcript tail every tick and re-parks from the same refusal
      record, and it iterates LIVE agents, of which a restart has none; and
      breaker rungs 1–2 are observations about a process's own turn spans, so
      restoring one onto a fresh process would assert a condition untrue of it —
      rung-3 STOPS are a standing decision about an identity, which is exactly
      why M8.6 persisted those and only those. Building five stores would have
      added state the tree already answers better. What was genuinely lost:
      activations, open gates and their verdicts, and the trigger clock.
      `ProfileInstance.crew` is the load-bearing addition and it is a FIELD
      because two things depend on it and both are silent when wrong: an armed
      schedule trigger wakes `trigger.agentId`, so arming one for an absent
      agent is a wake into the void once per interval forever; and `activate`
      refuses a duplicate, so without it the restore would block the very
      reactivation that brings the crew back — replacing one stuck state with a
      worse one. Gates restore their SETTLED half too, which is what stops a
      repeated verdict being processed twice; `reconcileGates` names any task
      held by a gate that came back from no record, and REPORTS rather than
      releases, because auto-clearing would approve an action no human ever saw
      (NFR-9). Checks: typecheck green; lint green; **invariants ok, reachability
      170/178 → 173/181** — every new module loadable from the three entry
      points, which is the wiring proof and not another M6; **3771 passed / 8
      skipped (3779) across 199 files**, up 68 from the 3703/8 (3711) baseline at
      `2dfb0c6` *in the Architect's main checkout with the art packs restored*;
      `coverage floors ok (17 subsystems on win32; 22 untested modules, all
      recorded)`. **32 mutations, every one killed or resolved, each reverted** —
      and TWO of them found weaknesses in this package's own tests rather than in
      its code: an assertion that the settled list is *sorted* was true whether
      the bound kept the oldest or the newest and so could not fail, and the
      `add` precedence mutant survived because it was EQUIVALENT — `tick` wrote
      both copies of the clock to the same value, so no test could tell which one
      `add` preferred. Two fields that can never disagree are one field with a
      latent bug, so the duplicate was deleted rather than a test invented for an
      unobservable difference. A **compile-time shape proof** pins every plan
      schema against its interface (`test/**` is inside `tsconfig.node.json`, so
      drift fails the BUILD, not a test run); it caught `crew` missing from the
      schema while this was being written. The M8.0 seam rule fired once and was
      right: the three new modules belonged to no subsystem and the suite refused
      them until assigned — the same check that caught M8.7b twice. They went to
      `boot` rather than a new `restart` row, which was written first and
      reverted: `validateFloors` requires a floor per subsystem on every recorded
      platform, so the row could not land without a **linux** number this machine
      cannot measure, and inventing one is a figure without its condition.
      **RUN, NOT ONLY TESTED:** `npm run dev` twice over the Architect's own
      `~/.ephesus`. The first boot wrote `triggers.json` through the real store
      (four real triggers: standup, retro, library.reflection, gym-metric-check);
      the app was killed and started again, and the second boot restored them and
      said so in the book of record —
      `{"kind":"profile","event":"restored","detail":"restored the last-fired
      clock for 4 trigger(s)","seq":1224}`. Boot → replay → restore → log entry,
      in the shipped app rather than a rig. It does NOT close M7's exit, which
      needs a real profile activated against a real target, but it does close the
      question of whether this package's wiring works outside a test.
      **Production call path:** `src/main/index.ts` builds the three
      `JsonStateStore`s before any subsystem that writes to them, wires `persist`
      into `Scheduler`, `GateManager` and `ProfileActivations`, and calls
      `restoreCompany` after `activations` and `gates` exist but BEFORE the
      Harbor's first ingest — which reads `watchedRepos` off the live set, so
      restoring later would leave the first ingest of every restart watching
      nothing. Docs: the M8.8 implementation doc, NFR-5, SRS §6 criterion 6,
      ADR-0012. **Floors deliberately NOT ratcheted** (`boot` now measures 20.75%
      lines against a 17.03% floor because covered modules joined it; a raise
      needs three corroborating runs of one tree). Owed, recorded not built:
      `--resume` and the auto-respawn it unlocks; an explicit Architect release
      for a historical orphan block; the capacity retry `attempts` rung resets
      across a restart (bounded, self-correcting). Branch
      `feature/m8-8-restart-survivable`.*

- [ ] **M8.9 Seeing the work** — B14, B15, and the integration of
      `feature/usage-aware-pacing` (9d66df5), which is UNMERGED and conflicts
      structurally with the capacity UI landed since. There is no incident
      surface of any kind: the crew's actual work product — four CI incidents
      triaged with severity and root cause on this machine — is unreachable from
      the app. And a hung harness is indistinguishable from a healthy idle one:
      the bridge check is one-shot at mount, every poll holds its last value on
      failure, there is no heartbeat anywhere, and the pace verdict never reaches
      the renderer at all.
      *This package OWNS the pacing-UI merge rather than treating it as a
      chore. The branch and the current dock both restructured the same JSX and
      renamed a tone helper; a hand-splice was attempted on 2026-09-02 and
      abandoned deliberately in favour of doing it here with tests.*
      *Docs: UI-DESIGN §5, ADR-0023. Tests: renderer tests over the MERGED dock
      (both the capacity row and the pace strip); a stale poll renders as stale
      rather than as its last good value. Risk: the existing dock fixture was
      cast `as never`, which hid a missing required field until it threw at
      runtime — fixtures in this package must be typed.*

- [ ] **M8.10 The long run** — D3, D4, D5, D6, D10. No log rotation and every
      read parses from byte zero: a synthetic overnight measured 28.4 MB and
      306 ms per parse ON THE MAIN LOOP, with the Agora's git at 2547 loose
      objects, no packs and no `gc` anywhere. Session ids never trim, so the
      watchers re-read every transcript in full twice per tick — 72 ms today,
      about a second per agent per tick by day seven. Reflection has no per-agent
      try/catch, so one oversized memory stops reflection for everyone after it.
      Mail to a dead agent is written and silently never read. The roster's
      `profile` field is hard-coded null at both write sites.
      *Docs: SDD §4.3, ADR-0006, ADR-0013. Tests: a synthetic multi-day log
      (this class is invisible at fixture scale, which is why it was never
      caught); reflection survives one bad agent. Risk: rotation changes the book
      of record's shape — append-only must still mean append-only across a
      rotation boundary, and the reconcile must handle it.*

- [ ] **M8.11 Engine honesty** — DD-2, C1, C4. The highest-leverage decision in
      the register, and it collapses five separate blockers into one small fix:
      ADR-0009 already says Claude Code is the reference adapter and the only one
      that may gate a release, and SRS FR-1.2 requires only the seam. **The docs
      already hold the honest position; only the shipping surface disagrees.**
      The README advertises five engines, two of which have no adapter at all;
      the autonomy grant is silently dropped on codex and gemini; with no Stop
      hook there is no continuation loop, so such an agent stops after one turn;
      and the floor asserts a confident `idle` for it forever.
      **DECIDED 2026-09-02 — claude-only for the MVP, recorded as ADR-0024.**
      So this package is: refuse a non-reference engine at profile load with the
      engine named and the reason stated; correct the README; rename the
      `pty-heuristic` grade to `none`, which is what it is; drop the Watch
      panel's claim that codex/gemini are merely "blind to repetition,
      error-rate" (it implies burn-rate still protects them, and it folds
      transcript rows those adapters never produce); and name `'claude'`
      explicitly where Artemis is currently hired on `engines.list()[0]?.id`.
      *REFUSE, do not degrade — a company that silently runs at one turn per
      wake is worse than one that will not start. And this is NOT permission to
      collapse the seam: `codex.ts` and `gemini.ts` stay in the tree,
      unregistered, as the conformance suite's second implementation. If a change
      makes conformance pass by special-casing Claude, ADR-0024 has been
      misread.*
      *Docs: ADR-0024 (normative), ADR-0009, FR-1.2, README. Tests: the refusal
      asserted in BOTH directions (a reference engine loads; a non-reference one
      is refused and says why), and **the conformance table gains an autonomy
      case** — its absence is exactly why the silent drop survived two
      milestones, so that case is the part of this package that prevents a
      recurrence rather than merely recording one.*

- [ ] **M8.12 Exit review** — the milestone closes on a run, not on a checklist:
      SRS §6.1's action half on a real repository, performed by a developer who
      is not the author, from a clean clone, following only the README — and
      surviving a deliberate restart mid-run. PROGRESS and docs re-synced.
      *This is deliberately the same shape as M7's unmet exit: a criterion that
      can only be met by execution. M7's exit remains OPEN and M8 does not close
      it; the two are independent, and §6.1's action half is owed to both.*

**Design decisions carried into M8, all the Architect's** (register DD-1…DD-7):
the shipped gate policy's defaults (M8.4); claude-only or three engines (M8.11);
the shipped hire budgets, which measured a breach inside one working day for
every hire (M8.6/M8.7); whether a company-wide daily ceiling exists at all;
whether the block cap and pathology signal are dead code or a wrong early return
(both currently unreachable by construction); consent on first launch, since boot
starts an agent unconditionally and the first tick fires standup, reflection and
retro together sixty seconds later; and whether a settings surface is in scope at
all — its absence is *why* four separate packages are "hand-write a file you were
never told about".

## M7b — The recursive company + shipping (plan drafted 2026-08-29 at M6 close)

Derived from IMPLEMENTATION M7's inward half + ADR-0018 + ADR-0019 + ADR-0020 +
SRS FR-9.5/FR-10.2/FR-10.5 + UC-11/UC-16 + SDD §7.8 + TEST-STRATEGY §3
(S-RECURSE). This is the milestone where the company's primary standing mission
— improving itself — becomes an activatable bundle, and where the harness first
acts on the internet under an identity of its own. It is deliberately LAST:
everything it composes must already work.

- [ ] **M7b.1 Company GitHub identity** — ADR-0020: one Architect-owned machine
      account; a fine-grained PAT (contents + pull-requests on the named repo
      only) held WRITE-ONLY in the broker and env-injected at spawn solely to
      roles whose hire template declares the grant; agent commits authored as
      the company account with a per-agent `Co-authored-by:` trailer, never as
      the Architect and never as any vendor identity; the account holds write,
      never admin, with `main` PR-and-review protected so the HOST enforces
      what the harness promises. **`check-attribution.cjs` gains its carve-out
      here** — company-account authorship is legal only on `agent/*` branches,
      and a company-account commit on `main` that did not arrive by an
      Architect-merged PR fails the job (ADR-0020 names this as owed to the M7
      package that first exercises the identity).
      *Docs: ADR-0020 (normative), FR-10.5, ENGINEERING-STANDARDS §2. Tests:
      the carve-out asserted in BOTH directions — an `agent/*` company commit
      passes, the same commit on `main` fails, the Architect's own commits are
      unchanged, and a vendor identity anywhere still fails; the token reaches
      the improver role and NOT the researcher (NFR-17); revoking it disables
      delivery and nothing else. Risk: this loosens a rule that has held for
      every commit in the repository — the carve-out must be narrower than the
      thing it permits, and its test must fail if it widens.*
- [ ] **M7b.2 Recursive Improvement profile** — FR-9.5/ADR-0019 as the third
      built-in bundle: a researcher role running the Stoa cadence over the
      watchlist, improver role(s) implementing approved proposals in isolated
      worktrees, Artemis's ranking/pre-screen duties, and delivery playbooks;
      default target the company's own repository. **Activation is refused
      outside company mode `improving`**, naming §6.9's missing evidence; a
      mode revert or deactivation disarms its triggers. It runs inside the
      FR-12.5 gym budget slice and can never starve a coexisting profile.
      *Docs: ADR-0019 (normative), FR-9.5, ADR-0018, SDD §7.8. Tests: the
      refusal in `directed` names the missing evidence; a mode revert disarms
      triggers observably; the researcher's spawn plan carries no secret grants
      and a read-only checkout while the improver's carries the GitHub grant;
      the budget slice holds under contention. Risk: this profile modifies the
      harness that runs it — the strictest gate posture in the fleet, and no
      path in the bundle may widen it.*
- [ ] **M7b.3 PR delivery + the provenance chain** — SDD §7.8's arrow: approved
      proposal → improver's worktree → `agent/<name>/<topic>` branch → PR
      opened under the company identity via `harbor/github.ts`, its body citing
      the `GYM-<NNN>` and `RB-<NNN>` ids it descends from, logged `remote`-
      tagged → the Architect's queue. Rejection revises on the SAME branch; the
      proposal stays `approved`, never silently abandoned. **No auto-merge path
      exists anywhere in the profile or the code.**
      *Docs: SDD §7.8, ADR-0019, UC-16 incl. Alternate 5a. Tests: the absence
      of a merge/push-`main` path asserted by API SURFACE (the S-SECRETS
      pattern), not by a happy-path test; the PR body's citations are
      mechanically required, so an uncited PR cannot be opened; the full chain
      watchlist→brief→proposal→PR→merge→measured is reconstructible from the
      ledger and log alone. Risk: "the Architect merges" must be true because
      no code CAN merge, not because no code currently does.*
- [ ] **M7b.4 Chat bridge** — FR-10.2/UC-11: one Slack-compatible webhook/bot
      through which the Architect converses with Artemis remotely, receives
      briefings, and approves gates; inbound webhooks may spawn ephemeral
      workers torn down after replying. Every remote directive is echoed in the
      desktop activity log with the `remote` source tag (FR-10.3).
      *Docs: FR-10.2/10.3, UC-11. Tests: a gate approved over the bridge takes
      the SAME validated path a click takes (the ADR-0007 consequence, restated
      for chat); an ephemeral worker is provably torn down; inbound content is
      DATA, never instructions (invariant §13, NFR-17); the bridge being down
      is a visible degradation. Risk: the bridge is an inbound channel from
      outside the machine, it can approve gates, and it is the largest new
      attack surface in the project.*
- [ ] **M7b.5 Packaging and update check** — signed builds for macOS, Windows
      and Linux; a one-click update check. The licensed-art drop rule holds:
      what ships must not depend on sheets that are not redistributable.
      *Docs: IMPLEMENTATION M7, ATTRIBUTION. Tests: a build produced on each OS
      boots to the floor; the update check is a visible, refusable prompt,
      never a silent self-update; no licensed asset ships that ATTRIBUTION does
      not permit. Risk: signing identities are secrets — the broker's rules
      apply to the build pipeline too.*
- [ ] **M7b.6 Suites + exit review** — S-RECURSE green in CI; **the recursive
      test (SRS §6.10) landing one REAL chain** — a URL on the Stoa panel →
      watchlist entry → brief citing it → approved proposal descending from it
      → company-identity PR on an `agent/` branch citing both ids → Architect
      merge; a real overnight run producing a truthful morning brief ON THE
      PHONE; the Gymnasium and Stoa cadence triggers live under company-mode
      governance (ADR-0018 — autonomous only in `improving`); and the
      **two-week gymnasium acceptance test (SRS §6.7) BOOKED as the final v1
      acceptance gate**, its window recorded on the ledger the way the M6
      metric sweep was.
- [ ] **M7b exit** — SRS §6.10's real chain landed; S-RECURSE pass; the
      overnight remote brief demonstrated; cadences live under mode governance;
      SRS §6.7 booked with a date; signed builds on three OSes; PROGRESS + docs
      synced. **This is the v1 acceptance boundary** — after it the only gate
      left is §6.7's two-week run.
