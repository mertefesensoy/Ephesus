# The renderer can die and nothing notices

**Status: BUILT.** Found by the Architect looking at a white window on 2026-09-06 and asking why,
not by a test.

## Problem

The window went white. The renderer process was **gone**:

```
  Pid Type            MB  CpuSec  Responding
14020 main        246.00   370.1        True
71540 gpu-process  64.00  4357.7        True     ← 72 minutes of CPU
22424 utility      14.00     1.3        True
```

No `--type=renderer` process, no Crashpad report, and the CDP target still listed — a window with
nothing left to paint it.

**Nothing in the harness noticed.** An exhaustive grep of `src/main/` and `src/preload/` for
`render-process-gone`, `renderProcessGone`, `unresponsive`, `child-process-gone`, `did-fail-load`
and any `webContents.on(` returned **zero hits**. The app had no handler for its own UI dying.

Meanwhile the company carried on: **twenty engine processes still running**, scheduled sweeps still
firing on the minute, main still alive. The Architect had no way to see any of it.

### Why `UiBridge` could not catch this

`ui-bridge.ts` is the one door from main to the renderer, and it is deliberately silent about
sending to a window that is gone. Its docblock argues the case, and the argument is right for the
case it was written for:

> "this class is deliberately silent about exactly one thing: sending to a window that is closed or
> closing. That is not a degradation, it is the normal end of a session"

But `isDestroyed()` is true whether the window closed cleanly or the renderer died underneath it,
so the bridge cannot tell those apart — and a renderer that died is **not** the normal end of a
session. Every send became a no-op returning `false`, `onDropped` never fired, and a crash was
filed as a tidy shutdown.

The bridge is not the bug and is not changed here. The knowledge that separates the two cases is
Electron's `render-process-gone` event, which lives at the window lifecycle, and nothing was
listening for it.

### Why this is worse than a blank screen

Invariant §7 — every degradation visible in UI — has a hole exactly where it cannot be worked
around: the surface that would show the fault is the fault. Concretely, while the window was dead:

- agents kept running and kept spending against the Architect's account;
- triggers kept firing on schedule;
- **a gate raised in that window had nobody to answer it**, and SDD §9's choke points are the
  system's whole story about not taking irreversible action alone.

## What changed

| File | Change |
|---|---|
| `src/shared/renderer-health.ts` | new — `decideRelaunch` (a bounded ladder) and `describeRendererDeath` (the report's words), both pure |
| `src/main/index.ts` | `createWindow` now listens for `render-process-gone`, `unresponsive` and `responsive`; a session-lived `rendererDeaths` ledger feeds the ladder |
| `test/shared/renderer-health.test.ts` | 8 cases |

## Implementation approach

**Report, then relaunch, and bound the relaunching.** A renderer that dies because of what it loads
will die again on reload, and an unbounded relaunch turns one dead window into a spin competing
with the agents for the machine. `decideRelaunch` allows `RENDERER_RELAUNCH_LIMIT` (3) deaths inside
`RENDERER_RELAUNCH_WINDOW_MS` (60 s) and then stops and says so — the same shape M8.6 gave the
respawn ladder: try, and when trying is plainly not working, stop and report.

The window is deliberately one minute because the failure being bounded is a *loop* — load, die,
reload, die — which happens in seconds. A renderer that dies once an hour is not looping, and each
of those deaths has earned its own relaunch. A test pins that: twenty old deaths plus one now
relaunches, with `recent: 1`.

**The report carries Electron's own `reason` and `exitCode`, not a word of ours.** `oom`, `killed`
and `crashed` need different answers from the Architect, and only the engine's own reason separates
them. It also says what is still true — the company is running headless, agents keep working, and
any gate they raise has nobody to answer it — because that, not the white screen, is the thing worth
knowing.

**It is written to the Agora log as well as the degradation channel.** The log is the only place
this survives, since the surface that would show it is what just died.

**`clean-exit` during the quit sequence is not a fault.** `quit.hasStarted() || quit.hasFinished()`
guards the handler, so the window going away on purpose stays silent — and relaunching a window
during a shutdown, which would be its own bug, cannot happen.

**`unresponsive` is reported but not acted on.** It is the shape this defect wore first: before the
renderer died, its JS thread was wedged — `1+1` over CDP timed out while the process was alive. A
busy renderer usually comes back, and killing one that was about to finish would turn a stall into a
loss. `responsive` clears the degradation.

## Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npx vitest run test/shared/renderer-health.test.ts
```

8 cases green. `check-invariants.cjs` still passes, which matters here: it fails on `webContents.send`
outside `ui-bridge.ts`, and this change adds listeners rather than sends.

### Mutation testing — 8 / 8 killed

| Mutation | Killed by |
|---|---|
| never stop relaunching (the crash loop, restored) | STOPS once the limit is passed, and says why |
| refuse one relaunch too early (off by one) | keeps relaunching up to the limit |
| count every death ever, not just the recent window | forgets deaths older than the window (+1) |
| include a death exactly one window old | counts a death exactly at the window edge as outside it |
| report a count nobody can act on | reports how many deaths it counted either way |
| drop the engine's reason, keeping only our own words | carries Electron's own reason and exit code |
| stop saying the company is still running headless | says the company kept running, and that gates now have nobody |
| stop telling the Architect how to get the window back | STOPS once the limit is passed, and says why |

## What this does NOT fix

**Why the renderer died is unknown.** No Crashpad report was written, so it was not a classic crash;
OOM or an external kill are the candidates, and the GPU process sitting on 4357 s of CPU against
main's 370 s is the anomaly worth chasing next. This change makes the *next* death legible and
recoverable; it does not explain this one, and the doc says so rather than implying a root cause it
does not have.

**A relaunched window is a fresh projection, not a restored one.** That is correct by design — the
renderer holds no state whose loss means anything (ENGINEERING-STANDARDS §4) — but an Architect
mid-way through a form will lose what they had typed. Held command text lives in main
(`commands.ts`) and survives; nothing else in the UI does.
