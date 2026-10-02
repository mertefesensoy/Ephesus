# GYM-010 — The invariant tripwires read the whole file, so a wrapped call cannot pass

**Status:** proposed · **Proposed:** 2026-10-02 · **Decided:** — ·
**Gate:** Architect approval **and a decision memo**. This alters a CI gate that
enforces invariants §4 and §5 (BUILD-PROMPT §3, ADR-0004, ADR-0011), which ADR-0015's
authority table puts in its strictest class. No dependency is added. In the build phase
the memo's form is the Architect's call, as GYM-009 also notes.

**Filed after the change was built.** The change already exists as PR #65
(`fix/invariants-see-wrapped-calls`). Its first DECISIONS-LOG entry argued that a fix
which only tightens a gate back to its documented behaviour needs no ledger row. The
design review of #65 rejected that. Both precedents it leaned on (2026-08-27 and
2026-08-29) predate the ruling of 2026-09-02, "A changed CI gate gets a ledger entry",
and that ruling faulted a `check-invariants.cjs` rule (M6.10's clock rule) for landing
without one. The Architect chose this row over an exemption. #65 waits on its verdict.
The order the `/improve` skill asks for (proposal, then approval, then implementation)
was not followed here. This row records that and is not a precedent for skipping it.

---

## Evidence

**The single-committer rule never once saw the file its allowlist names.**
`scripts/check-invariants.cjs` enforced ADR-0004 with
`/(execFile|execFileSync|exec|execSync|spawn|spawnSync)\s*\(\s*['"`]git['"`]/` and
tested it one line at a time, so its `\s*` could never span the line break Prettier puts
after a long call's parenthesis. `src/main/git.ts` has had that shape in all eleven
versions on `main` from `e878641` (2026-08-26, which wrote the rule beside it) to
`d7d02ba` (2026-09-10): **0** matches read line by line, 1 read whole. Its allowlist
entry was never exercised.

**The same call anywhere else passed CI.** A Prettier-formatted git call appended to
`src/main/agora.ts`, a real reachable module, which `prettier --check` accepts:
`main`'s checker exited 0 with `invariants ok`. The one-line form of the same call failed.

**Two more rules shared the blind spot, and four did not.** Measured by formatting one
over-long line per construct with the repository's own Prettier (3.9.6, `.prettierrc`):

- **Shares it:** the truncating-write rule. A long `writeFileSync` loses its path to the
  next line.
- **Shares it:** the ledger-rewrite rule. SQL inside a template literal is wrapped by
  hand, and `src/main/db.ts` already wraps its own at clause boundaries.
- **Does not share it:** the clock, `webContents.send`, environment and secret-shape
  rules. Prettier never splits the spans they match.

Full measurements: `docs/implementations/2026-10-02-invariants-see-wrapped-calls.md`
§1 and §3.1.

## Proposal

What PR #65 does, recorded here for the verdict:

- **`scripts/check-invariants.cjs`.** The git, truncating-write and ledger-rewrite rules
  match the whole file text and report the line each match starts on, one failure per
  line. The other four rules are unchanged and stay per line. The scan is exposed as
  `fileFailures(searchDir, rel, text)` and `invariantFailures()` behind a
  `require.main === module` guard, the shape of the sibling `scripts/check-*.cjs`. The
  rule set comes from the directory the walk found the file in, as before. The CLI's
  output on the tree it was built on is byte-identical to `main`'s.
- **`test/scripts/check-invariants.test.ts`** (new, 20 cases). Every wrapped fixture is
  checked to be Prettier's own output. The real `git.ts` is checked to be both seen and
  allowed. Over this repository, with the allowlist emptied, the rule must name exactly
  the git calls the TypeScript syntax tree finds. The CLI is run as CI runs it, including
  a copy of `scripts/` inside a fixture tree.

No rule is added, no allowlist entry changes and nothing is loosened. Every file the
old loop failed still fails, because a per-line match is a whole-text match, and a
one-line call gets the same message.

## Cost & risk

**Effort:** built. It is PR #65, gated green (in a worktree outside OneDrive, 239 files
and 4799 tests at its last merge of `main`), with a 22-mutant round and a no-op
control. The control survived and all 22 were killed.

**Blast radius:** one CI step, `node scripts/check-invariants.cjs`, which every PR runs.

**What could regress:**

- **A false positive from reading the whole text.** A pattern can now match across a
  line break inside prose that the per-line loop never joined: a block comment without
  `*` prefixes, or a template literal quoting a call. It fails loudly, never silently,
  and is fixed by rewording the text. Measured on the tree #65 was built on, the three
  rules report nothing new outside the allowlisted `git.ts`.
- **The refactor that made the checker testable.** The CLI's exit codes and output are
  covered by the new tests, and were byte-identical to `main`'s on the tree it was built
  on.

## Success metric

Binary, both, measured at landing and on **2026-10-16**:

1. **At landing,** a Prettier-formatted git call planted in a real `src/` module makes
   `node scripts/check-invariants.cjs`, CI's own step, exit 1 and name the file and the
   line the call starts on. The same planted call makes `main`'s pre-merge checker print
   `invariants ok`, so the check can tell the two apart.
2. **Through 2026-10-16,** no run of `check-invariants` on `main` or on a PR branch fails
   on one of the three whole-file rules over text that is not a real git invocation, a
   truncating write to `log.jsonl` or the ledger, or an `UPDATE`/`DELETE` against
   `cost_ledger`. Any such run counts as a false positive.

If either fails, the row is `regressed` and the change is rolled back.

## Rollback

Revert #65's merge commit on `main` (`git revert -m 1 <merge>`). That restores per-line
matching and the old top-level script, and removes the new test file with it. Nothing
else imports the exported functions, and no state or schema is involved.

## Related

- PR #65, and `docs/implementations/2026-10-02-invariants-see-wrapped-calls.md`, which
  is the evidence for this row
- `docs/DECISIONS-LOG.md`: 2026-08-26 (M2.1, the rule), 2026-09-02 (a changed CI gate
  gets a ledger entry), and #65's own entry
- GYM-009, proposed on branch `docs/gym-009-git-tripwire-syntax-tree` (not linked
  until it lands): moves the git rule onto the syntax tree and makes a dead allowlist
  entry fail. It builds on this change and is decided separately.
- [ADR-0015](../../adr/ADR-0015-gymnasium-self-improvement.md), the loop and authority
  table this row is filed under; [ENGINEERING-STANDARDS](../../ENGINEERING-STANDARDS.md) §3
