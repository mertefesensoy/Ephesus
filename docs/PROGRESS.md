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
M3.3) · `pendingTasksFor` always 0 (→ M3.8) · breaker pathology signal
emitted but unconsumed (→ M3.5) · every seat `terrace` (→ M3.6) ·
`agora/human/` queue with no UI (→ M3.4) · claude adapter's missing optional
`resume` (→ M3.7) · badge color-only pairs and tilesheet rendering (→ M3.6).

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
      **All three SDD §9 choke points are wired and proven.** (1) The engine's
      `Notification` hook is mapped — a real fake-engine process emitting it opens a
      packaged gate, **closing the M1 carried item** where an agent stalled behind a
      permission dialog was invisible to the harness. (2) A real `needs_human` message
      is delivered *and* gated — escalation never swallows mail (FR-3.3). (3) A budget
      breach files a `spend` gate.
      Open gates now populate `task.gates`, so M2.2's `status→done` guard bites for the
      first time; the avatar's `gate-opened`/`gate-verdict` edges (implemented in M1,
      unreachable until now) are driven, and only the LAST gate on an agent walks it
      back to its desk.
      LIVE RUN under real Electron (xvfb) against a real harness home and real Agora:
      `no policy file: autonomy=manual rules=0` — an unconfigured Ephesus holds
      everything · `corrupt policy: autonomy=manual rules=0 warning="gate-policy.json
      unreadable, holding everything: …"` — **a policy the harness cannot read never
      becomes a policy that permits** · `policy permits spend only; destructive op:
      held=true because=no-rule` · `profile asks autonomous under a supervised global:
      held=true because=autonomy` · `notification hook → gate: held=true what="Claude
      needs permission to use Bash"`. The chain read back out of `log.jsonl` alone
      (NFR-13): `seq=4 opened kind=tool-permission` → `seq=5 approved`.*
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
      files. Carried to M3.9's S-GATE/E2E work.*
- [ ] **M3.5 Circuit-breaker ladder + span capture** — `watch/breaker.ts` per
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
- [ ] **M3.6 Floor layout v2 — seats, temple, sheet rendering** — the floor
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
- [ ] **M3.7 Artemis lifecycle** — `artemis.ts`: auto-spawn at startup into
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
- [ ] **M3.8 Task assignment + Artemis routing + Ledger tab** — SDD §7.1: the
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
- [ ] **M3.9 Scenario suites + exit demos** — implement S-GATE, S-BREAKER,
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
- [ ] **M3 exit review** — UC-02 + UC-08 demo evidence; S-GATE, S-BREAKER,
      S-LEDGER, S-SECRETS green in CI; PROGRESS + docs synced.

## M4 — The Library + engine breadth

- [ ] Package list derived at milestone start
- [ ] M4 exit — respawn-with-memory; recall smoke test; two extra engines conform

## M5 — The Odeon + Gymnasium v1

- [ ] Package list derived at milestone start
- [ ] M5 exit — S-DECKGATE, S-MEMO, S-BRIEF, S-MEETING, S-GYM pass; real retro report

## M6 — The Herald

- [ ] Package list derived at milestone start
- [ ] M6 exit — SRS §6.2 + §6.5 live; S-FAILOVER scripted pass

## M7 — The Harbor + missions

- [ ] Package list derived at milestone start
- [ ] M7 exit — one-hour company test (SRS §6.1) on a real repo; S-PROFILE pass
