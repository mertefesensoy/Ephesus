# A literal NUL in `tmpdir.test.ts` is written as the escape it meant

**Date:** 2026-10-03 · **Branch:** `fix/tmpdir-test-nul-escape` from `origin/main`
`6f6164d`

---

One case in `test/main/tmpdir.test.ts` hands `removeTempDir` a path with a NUL in it,
and the NUL was in the file as the byte itself (0x00) rather than as an escape. That
one byte hid the file from two of the search tools this repository is worked with,
and took it out of the line-ending normalization `.gitattributes` exists to
guarantee. This change writes the NUL as the six characters `\u0000`. The string the
test builds at run time is unchanged, code unit for code unit; only the file's bytes
are different.

## 1. Problem / motivation

Line 192, on `main` at `6f6164d`, reads as below, except that where this shows
`\u0000` the file held a single 0x00 byte, at offset 8958 of 13884:

```ts
expect(() => removeTempDir('a-path-with-a\u0000-nul')).toThrow()
```

A byte-level scan of every tracked file (909 text files; images and fonts skipped by
extension) found no other control character anywhere in the tree.

What the byte did, measured on win32 with git 2.53.0.windows.2, GNU grep and
ripgrep 15.2.0, not assumed:

| Reader | What it made of the file |
|---|---|
| GNU `grep` | `Binary file test/main/tmpdir.test.ts matches`, and no lines, not even the matches above the NUL |
| ripgrep, searching a directory | skipped the file without a word: a search of `test/` for `removeTempDir\(` listed 96 files and not this one, which has five matching lines; `rmSync\(` missed all four of its `rmSync(` lines, among them the raw recursive removal in its `afterEach` |
| ripgrep, given the file by name | `binary file matches (found "\0" byte around offset 8958)`, and no lines |
| git's line-ending layer | `git ls-files --eol` read `i/-text w/-text`: under `* text=auto eol=lf` a file with a NUL is binary, so the LF normalization did not apply to it |
| `git diff`, `git grep`, GitHub's PR view | text. git looks for a NUL only in a blob's first 8000 bytes (§4). #62's change to this file has numstat `103 2`, and GitHub served it as a 5467-character text patch |

The silent reader is the dangerous one. A search that skips a file looks exactly like
a search that found nothing in it, which is the shape the 2026-09-07 METHOD entry
named for its backspace: "a checker that finds nothing looks exactly like a checker
that passes." This file is where `removeTempDir`'s own behaviour is tested, so an
audit of the test tree's removals done with ripgrep would have passed it over unread.
The temp-hygiene guard was never blind to it: it reads each file and parses it, and
judges this one by name (`test/temp-hygiene.test.ts`, `UNMADE_TEMP_PATHS`).

**Where it came from.** The byte arrived with `84a68e9` (2026-09-01, "test(pin): guard
the Windows-only pin cases on a probe that cannot no-op"), the commit that added the
case, and has been on `main`'s first-parent line since that day's merge `3d5fbfa`. It
sat at offset 8848 then. #62 (`2366dc2`, 2026-10-02) added text above it and moved it
to 8958, but did not write it. So the byte is older than the 2026-09-07 METHOD entry
that describes this hazard, and it outlived that day's repair (`eb99ffd`), which
repaired `docs/DECISIONS-LOG.md` alone.

## 2. What changed

| File | Change |
|---|---|
| `test/main/tmpdir.test.ts` | Line 192: the 0x00 byte inside `'a-path-with-a…-nul'` becomes the six ASCII characters `\u0000`; no other byte changes (13884 → 13889 bytes). |
| `docs/DECISIONS-LOG.md` | One REPAIR entry appended: the repair, and the corrected account of what the byte did and where it came from. |
| `docs/implementations/2026-10-03-tmpdir-test-nul-escape.md` | This document. |

## 3. Implementation approach

The edit was made by a Node script, kept outside the repository, that cannot write a
control character because it holds no escape sequence for anything to decode on the
way:

1. Read the file as bytes. Refuse unless there is exactly one 0x00, preceded by the
   bytes of `removeTempDir('a-path-with-a` and followed by those of `-nul')).toThrow()`.
2. Build the replacement from byte values, `Buffer.from([0x5c, 0x75, 0x30, 0x30, 0x30,
   0x30])`: a backslash, `u` and four `0`s. No shell, heredoc or string parser sits
   between those numbers and the file, so nothing can turn them back into a NUL. That
   is the 2026-09-07 METHOD entry's rule ("build the character in the target language
   … or write the byte pair explicitly"), applied to the generator.
3. Before writing, assert that the file grew by exactly 5 bytes, that every byte
   before and after the replaced one equals the original, and that no control byte
   remains.
4. Write through a temp file and `rename`, then read the line back with `grep`, which
   now prints it.

## 4. Mathematical / statistical details

**The escape builds the same string.** In a TypeScript (and JavaScript) string
literal the scanner decodes `\u0000` to the code unit U+0000, and takes a raw U+0000
between the quotes as itself. Both spellings therefore produce the same 18 code
units:

```text
a  -  p   a  t   h   -  w   i   t   h   -  a  NUL -  n   u   l
97 45 112 97 116 104 45 119 105 116 104 45 97 0   45 110 117 108
```

This was checked, not argued. Both versions were parsed with the repository's
`typescript` (6.0.3) and walked node by node: both have 1235 nodes and no parse
diagnostics, every node kind, identifier and decoded literal value is identical, and
the only string holding a NUL is line 192's, with the value above, in both.

**Why that string makes the case pass.** `fs.rmSync` validates its path before
touching the disk. A string containing U+0000 throws `TypeError
[ERR_INVALID_ARG_VALUE]` ("… without null bytes") synchronously (node v20.16.0).
That code is not in `removeTempDir`'s transient set (`EBUSY`, `EPERM`, `ENOTEMPTY`,
`EACCES`, `EMFILE`, `ENFILE`), so it is rethrown on the first attempt: the "fault that
is not a lock" the case is named for. Without the NUL, `force: true` makes the missing
path a success and nothing throws.

**Why git's diff never called the file binary, and how near it came.** git's diff and
grep treat a blob as binary when one of its first 8000 bytes is a NUL. Offsets count
from 0, so offsets 0 to 7999 are inspected; a probe put a NUL at each offset from 7998
to 8001 and diffed a one-byte edit below it: `- -` (binary) at 7998 and 7999, `1 1`
(text) at 8000 and 8001. The file's NUL sat at offset 8848 when written and at 8958 on
`main`, outside the window both times. The margin on `main` was 8958 − 7999 = 959
bytes: an edit removing 959 or more bytes above line 192 would have turned every later
diff of the file into `Binary files … differ`. The same file with 1000 bytes of its
header comment removed (NUL at 7958) did exactly that. git's line-ending layer is
different: `git ls-files --eol` read the file as `-text` with the NUL at 8958, so it
looks past the first 8000 bytes, which is why `text=auto` treated the file as binary
while `git diff` did not.

**Size.** One byte out, six in: 13884 − 1 + 6 = 13889 bytes.

## 5. Design decisions

- **`\u0000`, not `\0`.** Both are legal here and give the same string, but `\0` is
  legal only because the character after it is not a digit: `\0` followed by a digit
  is a legacy octal escape, a syntax error in strict-mode code and in template
  literals. An edit next to `\u0000` cannot change what it means, and it is the
  spelling the 2026-09-07 RECORD REPAIR restored ("the escapes that were meant").
- **Not `String.fromCharCode(0)` in the test.** It would change the program, an
  expression where a literal was, so the change could no longer be shown to be the
  same program by comparing syntax trees, and it reads worse in a case whose subject
  is a literal path. The METHOD entry's advice to build the character in the target
  language is advice for generators, and the generator here followed it (§3).
- **No new check.** A check that refuses control bytes in tracked text files would
  stop the next one, but it changes what a gate refuses. ENGINEERING-STANDARDS §3
  calls a CI-gate change without a Gymnasium ledger entry a defect, and the GYM-011
  decision of 2026-10-03 gave a guard inside the suite a row rather than ruling it
  exempt. So this change adds no check; the case for one goes to the Architect as a
  recommendation, to be filed through `/improve` if wanted.
- **No regression test.** ENGINEERING-STANDARDS §6 asks for one per fixed bug, and
  the only test that would catch this defect again is the check above. What this
  change does prove is that the existing case still tests what it did: the same
  program (§4), the same result, and a mutant without the NUL fails it (§6).
- **The 2026-09-07 entries stay as written.** The log is a record. The corrected
  account (which readers the byte blinds, and where it came from) is a new entry.
- **The gate ran outside OneDrive**, in a detached worktree at `%TEMP%\eph-nulfix`
  holding the same tree as each commit (§6). The `coverage/.tmp` EPERM recorded on
  2026-09-07 (M8.11, ENVIRONMENT) is a handle race seen in the OneDrive-synced
  checkout, with its holder never isolated, and recorded gate runs outside that
  checkout, such as run 6 in the temp-hygiene change's document, exited 0. The path
  is short on purpose: Windows long paths are not enabled on this machine
  (`LongPathsEnabled` is 0), and a worktree under a 174-character temp path plus this
  repository's longest tracked path (87 characters) would pass the 260-character
  limit.

## 6. Verification

Run from the repository root.

1. No NUL is left (expect `0`; `6f6164d` gives `1`):
   ```bash
   node -e "const t=require('fs').readFileSync('test/main/tmpdir.test.ts');let n=0;for(const b of t)if(b===0)n++;console.log(n)"
   ```
2. git sees a one-line text change, and its line-ending layer reads the file as text
   (`6f6164d` reads `i/-text w/-text`):
   ```bash
   git diff --numstat 6f6164d -- test/main/tmpdir.test.ts
   git ls-files --eol test/main/tmpdir.test.ts
   ```
   Expected: `1`, `1` and the path (tab-separated), then `i/lf    w/lf    attr/text=auto eol=lf`.
3. Both greps read the file. GNU grep prints line 192, and ripgrep lists the file with
   its five matches (on `6f6164d` grep printed only "Binary file … matches" and
   ripgrep left the file out):
   ```bash
   grep -n "a-path-with" test/main/tmpdir.test.ts
   rg -c "removeTempDir\(" test/main
   ```
4. The case still tests what it did. `npx vitest run test/main/tmpdir.test.ts`, on
   win32: `6f6164d` 9 passed and 1 skipped, this branch 9 passed and 1 skipped, and
   "reports a fault that is not a lock at once, rather than waiting it out" passes in
   both. The skipped case is the pin probe's "could not determine" branch. On a
   platform without the Windows directory pin, the pin cases skip as well.
5. The case depends on the NUL. With the escape deleted (`'a-path-with-a-nul'`)
   exactly that case fails, `AssertionError: expected [Function] to throw an error`
   (1 failed, 8 passed, 1 skipped); with the file restored (blob `69ea464`) it passes
   again.
6. The Definition-of-Done gate, 2026-10-03, win32, in the worktree outside OneDrive,
   with `node_modules` linked to the main checkout's (lockfile matched: 353 entries,
   no mismatch; the 75 absent are optional binaries for other platforms). The tree
   was hashed with `git write-tree` before the run, and it is the `fix(test)` commit's
   tree:

   | Run | Tree | Free at start | typecheck | lint | invariants | suite | check-coverage |
   |---|---|---|---|---|---|---|---|
   | A | `0edec2f`: `6f6164d` plus the edit to line 192 | 2.57 GB | exit 0 (24 s) | exit 0 (28 s) | ok; reachability 189/199 | 239 files; 4919 passed, 8 skipped; exit 0 (140 s) | floors ok (17 subsystems on win32; 19 untested modules, all recorded) |

   `boot` measured 27.94% of lines against a floor of 28.05%, inside the recorded
   tolerance of 0.25 points. That row measures production code, which this change
   does not touch.

   The docs commit adds this document and the log entry, and none of the gate's steps
   reads them: Prettier's ignore list excludes `docs/` and `*.md`, and no test or check
   script opens either file. The gate was run once more on the docs commit's tree,
   with CI's relative-link check and `check-readme-current`, before committing; that
   run's results are in the docs commit's message.

## 7. Related docs

- [DECISIONS-LOG](../DECISIONS-LOG.md): 2026-09-07 (METHOD) "Scripted edits keep
  writing control characters where escapes belong", 2026-09-07 (RECORD REPAIR),
  2026-09-07 (M8.11, ENVIRONMENT) on the `coverage/.tmp` EPERM, and this change's
  2026-10-03 entry
- [ENGINEERING-STANDARDS](../ENGINEERING-STANDARDS.md): §3 (process changes go
  through the Gymnasium) and §6 (Definition of Done)
- [Gymnasium ledger](../gymnasium/LEDGER.md): GYM-011, a guard inside the suite given
  a row
- [The flaky temp-dir teardown](2026-09-01-flaky-temp-dir-teardown.md): why
  `removeTempDir` exists and what it retries
- [The pacing-wakes teardown](2026-10-02-pacing-wakes-teardown.md): #62, the last
  change to this file before this one
- [`.gitattributes`](../../.gitattributes): the LF normalization the byte took the
  file out of
