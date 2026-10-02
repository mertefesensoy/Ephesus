# GYM-011 — The temp-hygiene guard follows every directory, and sees the ones mkdtemp never made

**Status:** landed · **Proposed:** 2026-10-03 · **Decided:** 2026-10-03 (Architect,
asked during review of PR #68: the row, approved, over an exemption) ·
**Gate:** Architect approval. This changes what a test inside the required
`Typecheck · lint · test` check refuses, and it adds conventions that every test author
meets: ENGINEERING-STANDARDS §3 names both "new conventions" and "altered CI gates". It
touches no BUILD-PROMPT §3 invariant, no ADR, no secret and no dependency
(`typescript`, whose compiler API the guard uses, is already a dev dependency). If
ADR-0015's authority table counts a guard inside the suite as a gate, its class also
asks for a decision memo. In the build phase the memo's form is the Architect's call, as
GYM-009 and GYM-010 note, and this row was put to the Architect as it stands.

**Filed after the change was built.** The change is PR #68
(`fix/temp-hygiene-blind-spots`). Neither its DECISIONS-LOG entries nor its
implementation document asked whether it owed a ledger row; review of #68 did.

`#64`'s implementation document had argued that this guard owed none, by the precedent
of the changes made to it on 2026-09-01 and 2026-09-07. The second of those came after
the 2026-09-02 ruling, "A changed CI gate gets a ledger entry". And #65's ruling, the same
day as #64, chose a row over an exemption (GYM-010).

Asked, the Architect chose the row and approved it. The order the `/improve` skill asks
for (proposal, then approval, then implementation) was not followed here. This row
records that and is not a precedent for skipping it.

---

## Evidence

**A live leak the guard could not see.** `test/main/gates.test.ts` gave a `PromptStore`
the home `os.tmpdir()/eph-prompts-<pid>`. `read()` creates that home and seeds it, and
nothing removed it. On 2026-10-02 there were nine of them in `%TEMP%`, one per vitest
worker that had run the file. With `TEMP` pointed at an empty directory, each run of the
unfixed file left exactly one. The guard asked only about directories `mkdtemp` made.
`test/main/engines/claude-capacity.test.ts` had the same shape, one assertion away from
leaking.

**Four blind spots, each a leak the suite could carry with the guard green:**

- **(a) A temp directory made without `mkdtemp`.** This is the live leak above.
- **(b) A helper's directories, left to its callers.** With `cleanupHomes()` deleted
  from `s-livelock.test.ts`, its three tests passed and three `eph-scenario-*` homes were
  left behind per run.
- **(c) A future `makeTempDir()`** handing directories to callers that no rule judges.
- **(d) A per-file check.** One removal excused every other directory in the file.

**Found by an adversarial pass on the first version.** Four rig files
(`control-server`, `s-crash`, `ephctl`, `eph-recall`) removed each home only in the rig
object's `close()`, which ran only if `rigs.push(rig)` had registered the rig. Eight
mutations deleted the push or the drain, and all eight left every home behind with the
guard green.

**Found by review of #68.** Seven shapes passed because a named function counted as run
wherever a call of it was written, even a call inside an object's method or a closure
pushed onto a list. One of them was the four rigs' defect after a one-line refactor.

All of it is measured in `docs/implementations/2026-10-02-temp-hygiene-blind-spots.md`
§1, §3.7 and §3.8.

## Proposal

What PR #68 does, recorded here for the verdict:

- **The two leaks are fixed.** `gates.test.ts` and `claude-capacity.test.ts` make their
  homes with `mkdtemp` and remove them.
- **The helper and the rigs remove their own directories.** `test/scenarios/company.ts`
  registers `afterAll(cleanupHomes)`. The four rigs keep their homes in lists that their
  `afterEach` empties after closing the rigs.
- **`test/temp-hygiene.test.ts` judges each directory.** It follows each one by scope,
  through a single-file type checker, to a remover the file runs. Every fault names a
  shape that passes. The guard carries regression fixtures for every defect above, and a
  tripwire on the vitest hook order that `company.ts` relies on.

The conventions it adds, which every test author meets. The guard's `RULE` text and its
fault messages state them, and TEST-STRATEGY does not. Amending TEST-STRATEGY is not
part of this row.

1. **Each directory a test makes with `mkdtemp` reaches a remover the file runs.** That
   is `removeTempDir`, or a raw `rmSync`/`rm`/`rmdir` with `recursive: true`. A file that
   reaches git must use `removeTempDir`.
2. **A path built on the temp root outside an `mkdtemp` call is refused** unless
   `UNMADE_TEMP_PATHS` lists it, with an exact site count and a reason. There are 11
   sites in 9 files today.
3. **A helper removes what it makes from its own module-level hook.** A function that
   hands a directory back is judged at its calls only when calls are all the file does
   with it. Otherwise it is refused.
4. **A removal counts only if it runs whenever the directory is made**: in the make's
   own function body, or in code the file runs. A removal that only a kept function
   performs counts for nothing. A kept function is an object's method, a closure stored
   or returned, or a function only pushed onto a list.

## Cost & risk

**Effort:** built. It is PR #68. It is gated green; the gate runs are listed in the
implementation document, §6. Three mutation rounds ran, two before review and one
after: 59, 98 and 113 mutants. Each round had no-op controls, a green baseline first,
and nothing that ran other than as predicted. The real-tree plants were also run
against three guards (§4).

**Blast radius:** the suite's test job. The guard runs in every PR's
`Typecheck · lint · test` check. It takes about 1.2 s longer than `main`'s: 4.2 s
against 3.0 s, measured outside OneDrive.

**What could regress:**

- **A false positive on correct new test code.** By decision, the rule refuses some
  correct shapes (§7 of the implementation document):
  - a directory removed through an object's property;
  - a list drained through a copy;
  - a local remover helper;
  - a cleanup closure the test does call.

  None occurs in the tree. Each such failure is loud: it names the file, the line and a
  shape that passes.
- **A leak the rule cannot see.** §7 records the residuals as residuals, not as closed:
  - cadence;
  - hook scope;
  - path-insensitivity;
  - red-path removals;
  - closures handed to calls.
- **The hook order `company.ts` relies on.** Its `afterAll(cleanupHomes)` depends on
  vitest running after-hooks last-registered first, and on per-file isolation. The order
  is tripwired; isolation is not.

## Success metric

Binary, both:

1. **At landing,** each defect the change names is planted back into a real test file,
   and each makes `test/temp-hygiene.test.ts` fail, naming its file and line. `main`'s
   pre-merge guard passes every one of them, so the check can tell the two apart. The
   plants:
   - the gates prompt home and the capacity test's shim path, both on the temp root;
   - `company.ts` without its hook;
   - a directory taken off its list in `gates`, `agent-worktree`, `pacing-wakes`,
     `incident-surface-wiring`, `control-server`, `ephctl` and `eph-recall`;
   - the drain deleted in `control-server` and `s-crash`;
   - review's three shapes, written into `company.ts` in place of its hook.

   **Measured before the merge, 2026-10-03, on the tree being merged:** this guard
   fails all 15, and each output names the planted file with a fault that gives a line.
   `main`'s guard (`f048eb3`) fails none. The guard as it stood before review fails 12;
   review's three shapes passed it. The measurement is in §4 of the implementation
   document.
2. **Through 2026-10-16,** no temp-hygiene failure on `main` or a PR branch over code
   that leaves nothing behind, other than the shapes §7 of the implementation document
   refuses by decision. Any other such failure counts as a false positive.

If either fails, the row is `regressed` and the change is rolled back.

## Rollback

Revert the guard: `git revert -m 1 <merge>` of #68 on `main`, or a revert of
`test/temp-hygiene.test.ts` alone. A whole-merge revert also undoes the two leak fixes
(`gates.test.ts`, `claude-capacity.test.ts`) and the helper and rig changes. None of
those depends on the guard, so re-apply `bf0a3b4` and `3887174`, or revert the guard file
alone, to keep the leaks fixed. No production code, state or schema is involved.

## Related

- PR #68, and `docs/implementations/2026-10-02-temp-hygiene-blind-spots.md`, which is
  the evidence for this row
- `docs/implementations/2026-10-02-temp-hygiene-requires-remover.md`: #64's guard, which
  this extends, and the no-row argument this row answers
- `docs/DECISIONS-LOG.md`: 2026-09-02 (a changed CI gate gets a ledger entry), and #68's
  entries
- [GYM-010](./GYM-010-the-invariant-tripwires-read-the-whole-file.md), filed after
  review for #65 the same way
- [ADR-0015](../../adr/ADR-0015-gymnasium-self-improvement.md), the loop and authority
  table this row is filed under; [ENGINEERING-STANDARDS](../../ENGINEERING-STANDARDS.md)
  §3
