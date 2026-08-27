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

- [ ] **M4 exit review** — respawn-with-memory demo evidence; recall smoke
      green; codex + gemini conform at honest grades; S-CRASH green in CI;
      PROGRESS + docs synced.

## M5 — The Odeon + Gymnasium v1

- [ ] Package list derived at milestone start
- [ ] M5 exit — S-DECKGATE, S-MEMO, S-BRIEF, S-MEETING, S-GYM pass; real retro report

## M6 — The Herald

- [ ] Package list derived at milestone start
- [ ] M6 exit — SRS §6.2 + §6.5 live; S-FAILOVER scripted pass

## M7 — The Harbor + missions

- [ ] Package list derived at milestone start
- [ ] M7 exit — one-hour company test (SRS §6.1) on a real repo; S-PROFILE pass
