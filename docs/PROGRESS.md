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
- [ ] **M1.4 Claude Code adapter** — `src/main/engines/claude.ts`: spawn plan
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
- [ ] **M1.6 Command bar** — bottom bar (UI-DESIGN §4): free prompt to the selected
      agent; queue-until-idle when the agent is mid-tool (FR-1.3) — queued text
      visibly held (status-typing token semantics), flushed on idle; interrupt button
      (adapter's KeySequence). *Docs: FR-1.3, UC-03, UI-DESIGN §2.4/§4. Tests:
      pure queue-decision logic (mid-tool → hold, idle → send, interrupt clears);
      E2E smoke later. Risk: keep the queue decision in main, renderer stays a
      projection.*
- [ ] **M1.7 Conformance suite v1** — table-driven suite every adapter must pass
      (TEST-STRATEGY §5): spawn/interrupt/kill lifecycle, identity injection
      observable in-session, hook grade honesty (declared grade matches demonstrated
      events), settings-file hygiene, transcript reader vs fixtures — green for
      fake + claude adapters. *Docs: TEST-STRATEGY §5. Risk: suite must run per-PR
      against the FAKE engine; claude live checks are nightly-only.*
- [ ] **M1 exit review** — UC-03 demo with a real `claude`: file edit → shelf walk →
      desk → idle; typing mid-run queues then flushes; conformance suite green for
      fake + claude. Evidence recorded here.

## M2 — The Agora + Hermes

- [ ] Package list derived at milestone start (BUILD-PROMPT §5)
- [ ] M2 exit — scripted two-agent collaboration unattended; S-BLACKOUT, S-LIVELOCK,
      S-BOUNCE, S-WAKE, S-STOPLOOP pass

## M3 — Artemis + the Watch

- [ ] Package list derived at milestone start
- [ ] M3 exit — UC-02 + UC-08 demos; S-GATE, S-BREAKER, S-LEDGER, S-SECRETS pass

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
