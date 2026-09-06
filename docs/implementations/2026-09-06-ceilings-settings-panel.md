# The company ceilings become a setting

**Date:** 2026-09-06
**Requirement:** SRS FR-11.7 (new) · FR-11.1, FR-1.9 · ADR-0012, ADR-0029
**Branch:** `fix/mail-lost-when-a-woken-agent-dies`

---

## 1. Problem / Motivation

Ephesus has two company-wide ceilings, both real and both enforced:

- **Autonomy** (`gate-policy.json` → `autonomy`) — the maximum any profile may reach.
  Composed stricter-wins since ADR-0012, so a profile may sit under it and never above it.
- **Daily tokens** (`maxDailyTokens`) — the same shape for spend, added at M8.9 when ADR-0029 made
  hires unbudgeted by default.

Both were reachable only by hand-editing `~/.ephesus/gate-policy.json` **while the app was
running**. To cap the company before walking away, an operator had to know the file existed, know
the field names, and get the JSON right. The threat model says this out loud twice — §6.3 ("set
`maxDailyTokens` in `gate-policy.json` before you walk away") and §7 item 2 — which is an admission
that the safety story depended on an undocumented text edit.

A safety control nobody can find is not a safety control. The Architect asked for both to be
toggleable in settings, for all profiles.

## 2. What changed

| File | Change |
|---|---|
| `src/shared/gates.ts` | `maxDailyTokensSchema` extracted so the file and wire schemas share one bound; `gateCeilingsSchema` (the strict wire payload); `GatePolicyView`; `ceilingsOf` |
| `src/main/watch/gates.ts` | `gatePolicyView(path)` reader; `saveGateCeilings(path, ceilings)` writer; local `firstLine` |
| `src/shared/ipc.ts` | `watch:policy` / `watch:set-policy` channels and their bridge types |
| `src/main/ipc.ts` | Both handlers; `gatePolicyView` / `saveGateCeilings` added to `IpcDeps` |
| `src/main/index.ts` | Wires both deps to the live `gatePolicyPath`, read per call |
| `src/preload/index.ts` | `watch.policy()` and `watch.setPolicy(ceilings)` |
| `src/renderer/src/SettingsPanel.tsx` | **New.** The panel, plus `ceilingForm`, `parseTokenCeiling`, `describeAutonomy`, `describeBudget` |
| `src/renderer/src/WatchPanel.tsx` | Mounts it, beside `SecretsPanel` |
| `src/main/agents.ts` | `transcriptExists` — the `catch` now covers the adapter call it was documented to cover (§5.2) |
| `test/main/gate-ceilings.test.ts` | **New.** The writer, refusal by refusal |
| `test/renderer/settings-panel.test.tsx` | **New.** The pure decisions |
| `test/renderer/settings-panel-dom.test.tsx` | **New.** The button→IPC wire, under jsdom |
| `test/main/ipc-handlers.test.ts` | The channels, end to end over a real policy file |
| `test/main/endpoint-not-listening.test.ts` | **New.** Two Hermes bounces that no test could reach (§6) |
| `test/main/engines/tool-grants.test.ts` | Four grant refusals that no test could reach (§6) |
| `test/main/engines/claude.test.ts` | The "settings file is not an object" refusal |
| `test/main/artemis.test.ts` | A transcript reader that throws must not cost an agent its resume |
| `test/renderer/breaker-stops.test.tsx`, `test/scenarios/s-secrets.test.ts` | Harness wiring for the new deps |
| `docs/srs/SRS.md` | FR-11.7 |

## 3. Implementation approach

### 3.1 One truth, read live

The setting **is** `gate-policy.json`. No new store, no cached copy. `src/main/index.ts` already read
the policy per call (`loadGatePolicy(gatePolicyPath)` on every spawn and every gate), so a write
takes effect for the next spawn without a restart — and a snapshot held in main would have shown the
Architect a ceiling that stopped being in force the moment they set it.

### 3.2 The write is a patch, and it refuses

`saveGateCeilings` re-reads the file itself rather than accepting a policy from its caller, and
**refuses when the file is missing or does not parse**. This is the whole reason it is a function
rather than two lines at the call site.

`loadGatePolicy` never widens on failure: an unreadable file reads as `denyAllPolicy`, whose `rules`
table is **empty**. A writer that patched what the loader handed back would take the Architect's six
gate rules, drop every one, and write the result as though it had been chosen — turning a transient
read error into permanent data loss, at the exact moment somebody was adjusting a safety dial.
Refusing loudly is the only direction this may fail in.

`maxDailyTokens: null` **deletes** the key, because on disk unbudgeted is the *absence* of a ceiling
(ADR-0029). This was written first as a conditional spread and was wrong: a spread can only ever add
the key back, so `{ ...policy }` plus "add nothing" left yesterday's figure in the file and turning
the ceiling off did nothing at all. The test caught it; the code now says `delete`.

### 3.3 What the renderer may reach

`gateCeilingsSchema` is `.strict()` and carries exactly two fields. The `rules` table — which decides
which action *classes* need a human — is not reachable from the app window even by sending it: the
payload is refused, not ignored. A control that could widen `needs-human` with one click is not a
setting, it is a hole.

The wire form differs from the file form on purpose:

| | on disk | on the wire |
|---|---|---|
| `maxDailyTokens` | `positive().optional()` | `positive().nullable()`, required |

Absence on disk *means* unbudgeted. Absence in a patch is ambiguous between "leave it" and "clear
it", and a settings surface that cannot say *unbudgeted* out loud cannot turn a ceiling off. Both
now share `maxDailyTokensSchema`, so the two bounds cannot drift apart (see §5.1).

### 3.4 The panel holds no authority

`ceilingForm(saved, edit)` is a pure function: saved ceilings plus a pending edit → what is on
screen, whether it is dirty, and what the button may send. The component renders it and nothing
more. Three properties follow from having it in one place:

- **After a refused save the panel shows what is IN FORCE**, not the edit that failed. The handler
  returns the current view on refusal, and the panel adopts it either way. A control left displaying
  an unsaved value claims a ceiling that is not there — invariant §7's bad-news-as-good failure.
- **`send` is `null` unless there is a real, valid change**, so the button can neither re-post the
  values already in force nor post a half-typed figure.
- **Nothing renders as chosen before main answers.** A default shown while the policy is still being
  read is a claim about a ceiling nobody has checked.

The panel also renders `warning` whenever what it shows is the deny-all fallback rather than the
Architect's own file — a `manual` ceiling nobody chose looks exactly like one somebody did.

### 3.5 Where it lives

Inside the Watch, above the spend it caps, beside `SecretsPanel` — which is the precedent: a
panel-within-a-panel, in the subsystem that already owns the file (`main/watch/gates.ts`). "What may
the company do, and what is it doing" has one answer or none.

## 4. Numeric details

`parseTokenCeiling` is the only arithmetic. It strips `[\s,_]` (an eight-digit token count is
checkable as `40,000,000` and not otherwise), then requires `^\d+$` — deliberately **not** `Number()`
plus `isNaN`, because `Number('')` is `0` and `Number('4e9')` is a finite float. Both would pass a
bare NaN check: the first into a policy file as a ceiling that reads as breached before the first
token, the second into a schema refusal that names no field. Bounds are `1 ≤ n ≤ 1_000_000_000`,
matching `maxDailyTokensSchema` exactly because they *are* it.

Composition is unchanged (`composeBudget`, `composeAutonomy`): `effective = min(requested, ceiling)`,
with `clamped` recorded when a hire asked for more.

## 5. Design decisions

### 5.1 The re-validation before writing was removed, not kept

The writer first ended `parseGatePolicy(next)` before writing. Mutation testing showed the failure
branch was an **equivalent mutant** — no test could kill it, because nothing could reach it: both
halves are already validated (the file by the parse above, the ceilings by `gateCeilingsSchema` at
the IPC boundary), and the only way they could combine into something invalid was if the two
schemas' bounds drifted apart.

The recorded rule is that an equivalent mutant is a design smell — two things that cannot disagree —
and the duplicate here was the bound `1_000_000_000` written twice. So the bound was extracted into
`maxDailyTokensSchema` and used by both, and the now-provably-redundant parse was deleted. The
invariant "main validates all renderer input" is untouched: both untrusted inputs are still parsed.

### 5.2 `transcriptExists` had its `catch` in the wrong place

Found while chasing engines coverage. The function is documented "never throws", and the
`transcriptDir()` call — adapter code, which can throw — sat **outside** the try. `fs.existsSync`
returns `false` rather than throwing, so the catch guarded almost nothing where it was, and an
adapter that blew up looking for its own transcript directory took the whole respawn with it: the
exact opposite of the rule the contract states. The call moved inside the try. This is the recorded
"a catch guards nothing if the callee never throws" lesson, found a second time.

### 5.3 Alternatives considered

- **A new `settings.json`** — rejected. Two files describing one policy is a second truth, and the
  enforcement path already reads `gate-policy.json` live.
- **A top-level SETTINGS tab** — rejected. `SecretsPanel` set the precedent, and the ceilings belong
  next to the spend and gates they bound.
- **Editing `rules` from the UI** — rejected; see §3.3.
- **Seeding a missing policy from the panel** — rejected. It would invent a policy on the one path
  where the Architect cannot see what they are agreeing to. The panel says the file is missing and
  how to have it seeded (delete the harness home and restart).

## 6. Coverage found four unreachable guards

The seam rule failed `engines` and `hermes` when this landed. Attribution first: the win32 floors
were measured at `bf0c087` (2026-09-05), and blaming every uncovered line showed **one** of them
post-dated that commit — so this was a floor measured on a tree that no longer exists, not a new
blind spot, and none of it was in a file this change touches.

Closing it surfaced guards that had never been shown to fire, which is worth more than the
percentage:

- **Two Hermes bounces.** A message for an endpoint nobody is listening on (no Harbor, no profile
  endpoint) is supposed to bounce, never drop — an agent that files an incident into a company with
  no Harbor must be told, or it waits forever and the operator sees an agent that simply stopped.
  "It bounces" was a comment, not a fact.
- **Four tool-grant refusals** (`resolveToolGrants`): an unconfigured root, a root that does not
  resolve, a grant on a directory that does not exist yet, and the root granted as itself. Each is
  the difference between a named refusal and an agent silently spawning with a directory its bundle
  never earned.
- **The "settings file is not a JSON object" refusal** in `mergeClaudeSettings`. Without it the merge
  spreads an array into `{}` and writes back a settings file whose keys are `"0"`, `"1"`, `"2"` — the
  Architect's file destroyed by a write that succeeded.

Two branches were found to be **genuinely unreachable** and were left alone, recorded here:

- `src/main/commands.ts:154` (`if (decision.kind === 'send') this.flush(agentId)` at the end of
  `submit`). `observe` flushes synchronously on every transition to a send-phase, so held text and a
  send decision cannot coexist. Dead, but removing a line from the command queue is its own change.
- `src/main/engines/tool-grants.ts` (`if (relative.length === 0) return { ok: true }`). Mutating it
  survives: `''` starts with neither `..` nor a drive letter, so the following escape check already
  returns `ok`. Defensive clarity in a security path; noted, not touched.

## 7. Verification

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs
npm run test:coverage && node scripts/check-coverage.cjs
```

- **Suite:** 205 files, 3928 passing, 8 skipped.
- **Mutation:** 15/15 killed on the ceilings work (`mut-ceilings.json`), 3/3 on the guards moved or
  added in §5.2 and §6. Three earlier survivors were all equivalent mutants and were resolved by
  deleting the duplication that made them equivalent (§5.1), not by adding a test that could not
  fail.
- **By hand:** open the Watch. The ceilings read from `gate-policy.json`; picking a level and saving
  writes it; UNBUDGETED removes the key; a corrupt policy file makes the save refuse and the panel
  keep showing what is in force; deleting the file makes the panel say so rather than showing
  `manual` as though it were chosen.

## 8. Related docs

- `docs/srs/SRS.md` — FR-11.7, FR-11.1, FR-1.9
- `docs/adr/ADR-0012-mission-profiles.md` — stricter-wins autonomy composition
- `docs/adr/ADR-0029-unbudgeted-is-the-default.md` — why absence means unbudgeted
- `docs/THREAT-MODEL.md` — §6.2 (autonomy dial), §6.3 (spend), §7 (before you install)
- `docs/DECISIONS-LOG.md` — DD-1, 2026-09-04 (why a permissive ceiling is the safe default)
