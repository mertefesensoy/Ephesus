# M8.7 — the mailbox grant names the two rules the engine actually matches

## Problem / motivation

`mailboxPermissions` in [`src/main/engines/claude.ts`](../../src/main/engines/claude.ts)
composes the permission grant the harness writes into each agent's
`eph-settings.json`. It wrote seven allow-rules per agent:

```
Read(<dir>/**)  Write(<dir>/**)  Edit(<dir>/**)  Glob(<dir>/**)
Grep(<dir>/**)  LS(<dir>/**)     NotebookEdit(<dir>/**)
```

one per file tool the agent needs to work its own mailbox. A real `claude`
session run under the harness's composed spawn plan answered on stderr:

> Permission allow rule (…eph-settings.json): `Write(<agora>/agents/<id>/**)` is
> not matched by file permission checks — only `Edit(path)` rules are.

[2026-09-05-engine-isolation.md](2026-09-05-engine-isolation.md) recorded this as
"noticed in passing, not fixed". This closes it.

**The premise needed correcting before the fix could be scoped.** The obvious
reading — "the harness's grant does not grant, so agents get prompted to write
their own outbox, and ADR-0013's autonomy loop is broken" — is *wrong*, and
measurement is what showed it. `Edit(<dir>/**)` was already among the seven, and
`Edit` is precisely the rule the engine consults. The outbox write worked.

What was actually wrong is worse than a warning and better than an outage: five
of the seven rules were **inert**, and the one load-bearing rule was sitting
among four decoys and a fifth (`Write`) that looked more like the real thing
than the real thing did. That is a latent trap, not a live failure — the next
person to deduplicate that list deletes `Edit` as the redundant twin of `Write`
and takes every agent's outbox down, with a green unit suite the whole way.

## What changed

| File | Change |
|---|---|
| `src/main/engines/claude.ts` | New exported `CLAUDE_FILE_RULE_TOOLS = ['Read', 'Edit']`, carrying the engine-matcher ground truth in its docblock; `mailboxPermissions` maps over it instead of a seven-name literal. |
| `test/main/engines/claude.test.ts` | Grant test now asserts `Edit`/`Read` (the rules that match) rather than `Write`/`Glob` (rules that do not); new test asserts the **complement** — no rule may name a tool the matcher never consults; crew-merge count derived from the constant instead of the literal `21`; settings-merge probe changed from `Write(` to `Edit(`. |
| `docs/implementations/2026-09-05-engine-isolation.md` | The "noticed, not fixed" bullet now points here. |

No behaviour change for a running agent — see Verification. The change is to the
grant's *shape*, so that it can no longer be tidied into a broken state.

## Implementation approach

### Ground truth came from the binary, not from the warning text

Per the standing rule that the engine's behaviour is settled by evidence and
never guessed, the matcher was read out of the shipped binary
(`@anthropic-ai/claude-code` **2.1.252**,
`~/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`).
Two functions decide the whole question.

**1. Rule selection is exact string equality on the tool name.**

```js
function Gb(e, n, o) {            // (rule set, tool name, behaviour)
  let r = new Map, t = [];
  switch (o) { case "allow": t = s2(e); break; /* deny, ask … */ }
  for (let s of t)
    if (s.ruleValue.toolName === n && s.ruleValue.ruleContent !== void 0
        && s.ruleBehavior === o) r.set(s.ruleValue.ruleContent, s);
  return r
}
```

`toolName === n`. No aliasing, no tool-family expansion, no prefix match.

**2. A file check only ever asks for two names.**

```js
function cn(e, t, r) {                       // (context, kind, behaviour)
  let d = (() => { switch (t) {
      case "edit": return Kt;                // Kt = "Edit"
      case "read": return yt } })(),         // yt = "Read"
      b = Gb(e, d, r);
  …
}
```

`t` is the *kind* of file access, and it has exactly two inhabitants. The edit
check (`KT`) calls `cn(…, "edit", …)`; the read check (`$H`) calls
`cn(…, "read", …)`. There is no third case and no per-tool lookup anywhere on
the path.

Composing the two: **an allow-rule participates in a file permission decision if
and only if its tool name is the literal string `Edit` or the literal string
`Read`.** `Edit(<glob>)` authorises every file-*editing* tool — `Write`,
`MultiEdit`, `NotebookEdit` included — and `Read(<glob>)` authorises every
file-*reading* tool, `Glob` included. `Write(<glob>)` is not a narrower grant
than `Edit(<glob>)`; it is not a grant.

Two further details from the same read, both load-bearing for the fix:

- The engine's own rule validator carries
  `filePatternTools: ["Read","Write","Edit","Glob","NotebookRead","NotebookEdit","Cd"]`.
  **`Grep` and `LS` are not in it.** They were therefore worse than inert: the
  other three inert rules at least earn a warning on stderr; these two are
  dropped in silence.
- The read check delegates to the edit check first and returns its `allow`
  ("edit implies read"). `Edit(<dir>/**)` alone would in fact have sufficed.
  `Read(<dir>/**)` is kept anyway, because a grant should say what it means and
  not rely on a delegation the engine is free to stop doing.

### Matching semantics, in plain English

For a tool call touching path `p`, with `kind ∈ {read, edit}` fixed by the tool:

1. Let `N = Edit` if `kind = edit`, else `N = Read`.
2. Select `S = { rules r : r.toolName = N ∧ r.behaviour = allow ∧ r.content ≠ ⊥ }`.
3. Compile each `r.content` in `S` as a gitignore-style glob, rooted per rule.
4. Allow iff **every** directory candidate derived from `p` matches some glob in
   `S` (`h8e` folds with a logical AND and returns `null` on the first miss).

The tool's own name never enters steps 1–4. That is the entire finding.

## Design decisions

**Keep both `Read` and `Edit` rather than `Edit` alone.** `Edit` implies read
today; that implication is an engine internal, not a documented contract. Two
explicit rules cost nothing and survive the implication being removed.

**A named exported constant rather than an inline two-element literal.** The
constant is where the ground truth lives. A literal would put the *conclusion*
(two names) in the code and leave the *reason* nowhere, which is how the
seven-name list came to look correct in the first place. The test imports the
same constant, so code and test cannot drift into separately-plausible lists.

**Drop the inert rules rather than keep them as documentation of intent.**
Considered and rejected: they cost three warnings on every agent's stderr —
noise on the one channel the harness uses to surface real degradations
(invariant §7) — and they actively mislead, which is the defect.

**Fix the tests that pinned the old shape rather than leave them passing.** Three
existing assertions (`toContain('Glob(…)')`, `startsWith('Write(')`,
`toHaveLength(21)`) were green against a grant that was five-sevenths inert.
They are the reason this survived review: they asserted the shape the harness
wrote, never the shape the engine reads.

## Verification

### Three live measurements, one real agent each

Rig: an isolated harness home, agent directory `…/agora/agents/a-writer`
**outside** the working directory, engine config dir seeded exactly as
`prepareClaudeConfigDir` + `trustWorkspace` seed it, and the harness's own
composed argv —
`claude --permission-mode default --setting-sources= --settings <file>
--append-system-prompt <identity> -p …` — with `CLAUDE_CONFIG_DIR` isolated and
`CLAUDE_SECURESTORAGE_CONFIG_DIR` borrowing the Architect's session, as
`engineEnv` does. The task in every run: write `outbox/msg-1.md` with the `Write`
tool. `--permission-mode default` is `manual` autonomy — the mode that prompts,
so a missing grant is observable as a refusal.

| # | `permissions.allow` | Outbox written? | stderr |
|---|---|---|---|
| **A** | the seven rules as shipped | **yes** | 3 warnings (`Write`, `Glob`, `NotebookEdit`) |
| **A0** | the five inert rules **only** | **no — refused, no file** | same 3 warnings |
| **B** | `Read` + `Edit` only (the fix) | **yes** | **silent** |

A vs A0 is the control that isolates the cause: removing only `Read`/`Edit` and
changing nothing else turns a successful write into a refusal, so the five
remaining rules grant nothing. A vs B is the change this commit makes: same
outcome for the agent, three fewer warnings.

A0's refusal text is worth recording — the engine's own agent, asked what would
unblock it, proposed *"add `Write(<dir>/**)` to the allowlist"*: the exact rule
that does not work. The mistake this commit fixes is an easy one to make twice.

### Refutation — 6 mutations, 6 killed

The new test was attacked before it was trusted, on the rule that a gate is not
a gate until something has tried to walk past it.

| Mutation | Result |
|---|---|
| M1 re-add `Write` to the constant | KILLED (1 failed) |
| M2 restore the original seven names | KILLED (1 failed) |
| M3 drop `Edit`, keep `Read` — the tidy-up that breaks autonomy | KILLED (2 failed) |
| M4 swap `Edit` for `Write` — the original bug, exactly | KILLED (3 failed) |
| M5 smuggle a `Write` rule in past the constant | KILLED (2 failed) |
| M6 widen the grant to the parent directory | KILLED (3 failed) |

M1 and M2 are the ones the *first* test alone would have missed: growing
`CLAUDE_FILE_RULE_TOOLS` also grows the set the membership check validates
against, so the check passes itself. They are caught because the complement test
names the six inert tools individually rather than only comparing sets — a
failure says *which* decoy came back.

### Gates

```bash
npm run typecheck   # green
npm run lint        # green (eslint --max-warnings 0 + prettier)
npm test            # 194 files, 3700 passed, 8 skipped
```

### Not verified here

- Only the `claude` adapter is affected. `codex` and `gemini` compose no such
  grant; their permission models were not examined.
- Pinned to engine **2.1.252**. The matcher is an engine internal and can change.
  What protects the harness is that the shape is now asserted in one place
  against one named constant, so a future engine change is a one-line edit and a
  failing test, not a silent regression.
- The measurements used `--permission-mode default` (`manual`). `acceptEdits`
  and `auto` reach the same rule table by a shorter path; they were not measured
  because a grant that works in the strictest mode works in the looser ones.

## Related docs

- [2026-09-05-engine-isolation.md](2026-09-05-engine-isolation.md) — where this was noticed
- [ADR-0013](../adr/ADR-0013-stop-hook-autonomy.md) — the autonomy loop the outbox surface carries
- [ADR-0026](../adr/ADR-0026-engine-isolation-and-the-harness-as-sole-hook-author.md) — `--settings` / `--setting-sources=` and the isolated engine install
- [ADR-0009](../adr/ADR-0009-engine-adapters.md) — adapters own engine specifics
- [`docs/srs/SRS.md`](../srs/SRS.md) — FR-3.2, the requirement the grant exists to satisfy
