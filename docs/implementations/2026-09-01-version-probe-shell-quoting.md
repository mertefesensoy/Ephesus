# The version probe that could not see an engine under `Program Files`

## Problem / motivation

Seven tests failed reproducibly, in isolation, on a tree where everything else
was green — `test/main/agent-worktree.test.ts` (4) and
`test/scenarios/s-crash.test.ts` (3):

```text
Error: worktree: timed out waiting for settings installed in the worktree
Error: worktree: timed out waiting for the agent to start
AssertionError: expected 'installing' to be 'running'
```

They had been carried for a while as "pre-existing", and this session had
attributed them to worktree/git contention — the same class of cause that
explained the *flaky* failures fixed in
[the temp-dir teardown](2026-09-01-flaky-temp-dir-teardown.md). That diagnosis
was wrong, and the thing that proved it wrong was cheap: contention cannot
survive running one file alone, and these do.

The mechanism is a spawn taking the wrong branch:

```ts
// src/main/agents.ts — spawn()
const version = await this.probe(spec)
…
if (version === null) {
  // FR-1.6: offer to install the engine, in the agent's own visible terminal.
  this.update(request.agentId, { lifecycle: 'installing' })
  this.options.spawner.spawnAgent(request.agentId, {
    argv: [spec.install.command, ...spec.install.args],
    …
    settings: []          // ← an installer gets no settings, correctly
  })
  return this.card(request.agentId)
}
await this.start(request.agentId)
```

A null probe means "the engine is not here", and FR-1.6 answers that with a
visible install offer instead of a crash. That is correct behaviour — for an
engine that is genuinely absent. Here the engine was present and the probe was
lying, so the agent sat in `installing` forever, running an installer for a
binary already on disk, and never wrote the settings the test was waiting for.
Both symptoms are the same bug: `settings: []` on that branch is exactly why
"settings installed in the worktree" never came true.

### Why the probe lied

`probeVersion` shells out on Windows:

```ts
{ timeout: 10_000, windowsHide: true, shell: process.platform === 'win32' }
```

The shell is load-bearing and must stay: an engine CLI on Windows is normally a
`.cmd` shim (`claude.cmd`), and `execFile` cannot start one directly. But with
`shell` set, Node hands `cmd.exe` a command *string*, which re-splits it on
whitespace. Measured on this machine:

```text
execPath = C:\Program Files\nodejs\node.exe
shell:true         -> ERR Command failed: C:\Program Files\nodejs\node.exe --version
shell:false        -> "v20.16.0"
quoted+shell:true  -> "v20.16.0"
```

`C:\Program Files\nodejs\node.exe` runs as `C:\Program`. Node does not quote the
command for you when `shell` is set — that is documented as the caller's job,
and this is the caller.

### Why it looked pre-existing and machine-specific

Both facts have the same explanation, and both are why this survived so long:

- **It is not a regression.** `git log -S` puts `shell: process.platform ===
  'win32'` at `1c0a10a`, an M1-era commit. It has been wrong since it was
  written.
- **It only bites some machines.** The failure needs a *space in the path*. A
  developer whose Node lives at `C:\nodejs\` or `/usr/bin/node` never sees it,
  which is why CI is green.
- **It only bites some tests.** `agents.test.ts`, `artemis.test.ts`,
  `seating.test.ts` and `stations.test.ts` all inject a stub via the
  `probe?: VersionProber` option, so they never reach the real prober.
  `agent-worktree.test.ts` and `s-crash.test.ts` are the two that use it for
  real — which is exactly the set that failed.

**Production impact is real but conditional.** The Claude adapter declares
`versionProbe: { command: 'claude', … }` — a bare name resolved off `PATH`, no
space, unaffected today. What breaks is any adapter naming an absolute path,
which `BinarySpec` explicitly permits and the fake adapter legitimately does. On
a machine where `claude` itself is installed under a spaced path, the shipped
app would offer to install an engine the Architect already has.

## What changed

| File | Change |
|---|---|
| `src/main/agents.ts` | New `quoteForShell()`; `probeVersion` quotes the command when — and only when — it is handing it to a shell. |
| `test/main/version-probe.test.ts` | New. Five tests over `probeVersion` against real shims on disk; it had no direct coverage at all. |

## Implementation approach

```ts
function quoteForShell(command: string): string {
  if (!/\s/.test(command) || command.startsWith('"')) return command
  return `"${command}"`
}
```

Two guards, each doing real work:

- **`!/\s/`** — a command with no whitespace is passed through untouched. This
  keeps the common path (`claude`, `echo`) byte-identical to what shipped
  before, so the fix cannot regress engines that were working.
- **`startsWith('"')`** — an adapter is allowed to quote its own command.
  Quoting it again yields `""C:\…""`, which breaks in precisely the way this
  fix exists to prevent.

The quoting is applied at the call, not stored on the spec, so the value an
adapter declares is never rewritten — `spec.versionProbe.command` still reads
back exactly as the adapter wrote it. Only the string handed to the shell is
adjusted, and only when a shell is actually being used (`shell ? … : …`), so
POSIX keeps `execFile`'s argv-array semantics with no quoting at all.

### Alternatives considered

- **Drop `shell: true`.** Simplest, and wrong: it breaks `claude.cmd`, which is
  how the engine is actually installed on Windows. It would trade a bug that
  bites spaced paths for one that bites every Windows user.
- **`spawn` with `windowsVerbatimArguments`.** Solves argument quoting, not
  *command* quoting, which is the half that is broken here.
- **Resolve the shim to its real target first** (an `unwrapWindowsShim`-style
  helper). More machinery, and it would put engine-installation knowledge in
  core, which ADR-0009/NFR-12 reserve for adapters.
- **Make the probe failure visible instead of quoting.** Worth noting as a
  *separate* latent weakness: `probeVersion` maps "errored" and "absent" onto
  the same null by contract, so a misconfigured probe is indistinguishable from
  a missing engine. That contract is deliberate (FR-1.6) and changing it is a
  spec question, not a bug fix — recorded here, not acted on.

## Verification

```bash
npx vitest run --no-file-parallelism test/main/version-probe.test.ts test/main/agent-worktree.test.ts test/scenarios/s-crash.test.ts
```

The seven routed failures pass, and the new file passes 5/5.

**Mutation-checked**, per the M6 close-out standing lesson — an assertion that
cannot fail is not evidence:

| Mutation | Result |
|---|---|
| Quoting removed (`spec.versionProbe.command` passed raw) | **2 red** — the spaced-shim and absolute-interpreter tests |
| `startsWith('"')` guard removed (double-quotes an already-quoted command) | **1 red** — the already-quoted test |

Both mutations were applied by asserted string replacement, so a mutation that
silently failed to apply would have been caught rather than scored as "survived".
Under the first mutation the two control tests — absent binary, unparseable
output — stayed green, which is what makes them controls: they are not passing
for the same reason the others are.

The test builds a real `.cmd` shim inside a directory named `Program Files`
rather than relying on where Node happens to be installed, so it reproduces the
bug on any machine instead of only on one with a spaced Node path.

## Related docs

- `docs/srs/SRS.md` — FR-1.6 (install offer), UC-01 alternate 2a (worktree isolation)
- `docs/adr/ADR-0009-engine-adapters.md` — why shim knowledge stays out of core
- [The flaky temp-dir teardown](2026-09-01-flaky-temp-dir-teardown.md) — the
  contention cause this was wrongly attributed to
- [Reserved-endpoint mail contracts](2026-09-01-reserved-endpoint-mail-contracts.md)
  — the session that separated these seven from the flakiness and routed them on
