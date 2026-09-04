# Recorded engine output

Every string an engine adapter *matches on* — a version line, an auth status, a
capacity message — is a contract with a program we do not own. This directory
holds what those programs actually print, captured from a real installation, so
the matchers can be tested against the engine instead of against our idea of it.

## Why the rule exists

M8.4 shipped a `claude auth status` matcher that looked for `logged in as`,
`authenticated as` or `account:`. The real CLI prints JSON by default
(`{"loggedIn": true, …}`) and, in its opt-in `--text` mode, prints
`Login method: … / Email: …`. The matcher therefore matched **neither mode**,
always answered "cannot tell", and the `needs-login` lifecycle it exists to
raise could never fire on any machine. Forty-five tests passed, because every
one of them fed the matcher a string we had written ourselves.

That is the third time this shape has shipped here — `reproduce` matching `prod`
in the M7.4 scorer, and a spoken refusal confirming a gate in M6. So it is a
rule now, not a habit:

> **An engine adapter may not match on output that this repository has never
> seen.** Every declared probe carries a fixture captured from a real
> installation, and `scripts/check-invariants.cjs` fails without one.

## What a fixture is

- The **verbatim stdout** of the command, byte for byte, with one exception:
  values that identify a person or a machine are replaced, because this
  repository is public. Every replacement is listed in `PROVENANCE.json`
  under `redacted`, and a matcher must never key on a redacted field — if it
  did, the fixture would be testing our redaction rather than the engine.
- An entry in `PROVENANCE.json` naming the engine, the probe, the exact command,
  the engine version, the platform and the date.

A case we could not capture is recorded under `notCaptured` with the reason and
with whatever real evidence stands in its place — never invented and dressed up
as a capture.

## Re-capturing

```bash
claude --version                 > test/fixtures/engine-output/claude/version.txt
claude auth status               # → claude/auth-status.json      (redact, then update PROVENANCE)
claude auth status --text        # → claude/auth-status-text.txt  (redact, then update PROVENANCE)
```

Update `engineVersion` and `capturedAt` in `PROVENANCE.json` in the same commit.
A fixture whose provenance says one version while the file holds another is
worse than no fixture.
