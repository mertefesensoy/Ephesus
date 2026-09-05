# A real activation run, in the shipped app

**What this is.** A mission profile activated against a real repository in
`npm run dev`, with every prediction written down *before* the run. Not a
scenario suite, not a rig — the running app, real `claude` processes, a real
git repository.

**What prompted it.** The last activation on this machine was **2026-09-01
19:40**. Everything since — M8.6 worktree isolation, M8.7a per-agent engine
config directories, M8.7b tool grants, the M7.7 autonomy-seam fix, and M8.8's
restore — had never been activated. Twelve activations are in the book of
record and *every one of them predates that work*.

## Method

- App: `npm run dev` at `b47c81b` (M8.8 merged), started with
  `--remote-debugging-port=9222`.
- Driven through the renderer's own `window.eph.profiles.*` — the real
  contextBridge → IPC → main path a button click takes. No production code was
  modified and nothing was stubbed; the only thing not exercised is the panel's
  own `onClick`. The request passed was exactly the panel's shape
  (`{profile, target}` with no `isolation`, which is the recorded M8.6 gap).
- Profile: `skeleton-crew`. Target: `mertefesensoy/MUSAHIT`, a real Python repo
  with pytest CI, chosen by the Architect.
- **Predictions were written first** (`P1`–`P8`), because a run whose expected
  result is decided afterwards cannot fail, and a check that cannot fail is this
  codebase's recurring defect.

## Results

| | Prediction | Outcome |
|---|---|---|
| **P1** | every hire spawns `--permission-mode auto` | **PASS** |
| P2 | one engine config dir per agent; `--setting-sources=` attached | PASS |
| P3 | no `--plugin-dir` (negative control — the bundle grants no tools) | PASS |
| P4 | a worktree per agent; the target checkout untouched | PASS |
| **P5** | three hires, matching the 2026-09-01 log | **WRONG — four** |
| P6 | the Harbor watches the repo; no `watches-nothing` | PASS (with a correction) |
| P7 | two schedules armed, the CI binding pending | PASS |
| P8 | `activations.json` written, restored on restart with the crew down | PASS |

### P1 — the headline, and the reason for the run

Composition predicted `tool-permission → autonomous → --permission-mode auto`.
Measured at the **OS process table**, not from a log line:

```
ci-babysitter        permission-mode=auto   --setting-sources=[]   no --plugin-dir
dependency-updater   permission-mode=auto   --setting-sources=[]   no --plugin-dir
health-watcher       permission-mode=auto   --setting-sources=[]   no --plugin-dir
verifier             permission-mode=auto   --setting-sources=[]   no --plugin-dir
```

**The M7.7 defect is fixed in production.** Before M8.7b, `spawnConfig` asked
`autonomyFor` *during* the spawn and got `null` → `manual` →
`--permission-mode default`, while the log recorded the correctly-composed
autonomy. That is exactly how it survived twelve activations: the log was right
and the process was wrong. Reading the process table is what settles it.

### P8 — a real activation across a real restart

The app was killed with the crew live, then restarted:

```
seq 1297  restored the last-fired clock for 7 trigger(s)
seq 1298  skeleton-crew@repo:musahit restored from 2026-09-05T19:09:42.771Z
          — 4 hire(s) are down and 2 schedule trigger(s) stay disarmed until it is reactivated
```

In-memory afterwards: `crew: "down"`, `armed: []`, four agent ids retained so
`planFor` still answers, repos still watched — and **zero crew processes
respawned**, which is ADR-0027 §2 behaving as decided.

Then the recovery path: activating again **took over** the `down` instance and
brought the crew back (`crew: "live"`, triggers re-armed). Before M8.8's `crew`
field this would have been refused as a duplicate, and the restore would have
blocked the very reactivation that fixes it.

### Isolation held

The MUSAHIT checkout was byte-identical before and after — the same three
uncommitted files — while four real git worktrees ran on their own `agent/*`
branches.

## Findings

**1. The home bundle shadows the shipped one, and it is stale. (New.)**

`ProfileStore` reads home first by design, and `~/.ephesus/profiles/skeleton-crew`
is **version 1** where the repo ships **version 3**:

| | shipped `profiles/` | home `~/.ephesus/profiles/` |
|---|---|---|
| version | 3 | 1 |
| `isolation` | `worktree` | absent |
| `onExit` | `respawn` | absent → defaults to `offer` |
| `harbor.repos` | `[]` | hand-edited to `mertefesensoy/MUSAHIT` |

Consequences, all observed in this run: hires came back `onExit: offer`, so
**no respawn ladder was exercised**; `reposFrom` reported `bundle` rather than
`target`, so **the M8.5 remote-derivation path was not exercised either**; and
`profileVersion: 1` is what got written into `activations.json`.

Nothing tells the Architect their copy is shadowing a newer shipped bundle.
Shadowing is the intended feature (ADR-0012); *silent staleness* is not.
Anyone reasoning about shipped-profile behaviour from this machine would be
wrong. **Owed:** surface a version skew between the home bundle and the shipped
one.

**2. Artemis has not been able to spawn since 2026-08-31. (Pre-existing.)**

`artemis: respawn attempt 4 failed: Cannot create process, error code: 216`,
live in the health list, **16 occurrences in the log going back to 2026-08-31**.
Not caused by this run — the four crew agents spawned fine beside it, so it is
specific to the orchestrator's spawn path (Windows error 216 is
`ERROR_EXE_MACHINE_TYPE_MISMATCH`).

The degradation channel reported it correctly and continuously for five days.
Nothing acted on it, which is worth noting on its own: M8.2 made the condition
visible, and visibility alone did not produce a fix.

**3. Deactivation removes the worktree but leaves the branch. (New, minor.)**

Four `agent/*` branches survived deactivation with no commits on them. SDD §2
promises a clean worktree is removed; the branch it was on is not mentioned.
Over many activations these accumulate in the target repository. Removed by
hand here.

## What this does and does not close

**Closes:** whether the activation path works on current code. It does —
spawn, per-agent engine config, lockdown flags, tool-grant negative control,
worktree isolation, trigger arming, Harbor binding, the restart replay and the
rehire path all verified against real processes.

**Does NOT close M7's exit.** SRS §6.1 is the one-hour company test: break a
test, walk away, and expect detection, a fix or a fix PR, a memo if policy was
crossed, and a briefing that narrates it. The crew here spawned and idled; it
was never given work. That remains the outstanding acceptance criterion, and it
is now the only part of M7's exit still unproven.

## Related

- `docs/adr/ADR-0027-what-survives-a-restart.md` — §2's restore-without-respawn, observed here
- `docs/adr/ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md` — the flags measured in P1/P2
- `docs/adr/ADR-0012-mission-profiles.md` — home-shadows-shipped, finding 1
- `docs/srs/SRS.md` §6 criterion 1 — the one-hour test, still owed
