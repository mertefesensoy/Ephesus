---
title: 'A green suite over 1,406 lines nothing could reach'
date: 2026-08-31
tag: 'defect'
reading: '5 min read'
summary: 'A milestone shipped a subsystem that was fully implemented, fully tested, and never once called by the application. Every test passed. The feature did not exist.'
---

A milestone closed with the suite green. The subsystem it delivered was written, reviewed and tested — around 1,406 lines of production code with tests covering it well.

Nothing in the application ever called it.

The tests imported the modules directly, which is what unit tests do. The application did not import them at all. So the tests exercised real code, made real assertions, and passed honestly. They simply had no relationship to the running program.

## Why nothing caught it

Consider what each safeguard actually looks at.

The **type checker** sees a module that compiles. It has no opinion on whether anyone imports it.

The **linter** sees valid code. Unused-export rules are usually off in a codebase with a public surface, and for good reason.

The **test suite** sees passing tests. It cannot distinguish a test that reaches production code by the same route the application does from one that reaches it by a route only tests use.

**Coverage** was the cruellest. Coverage was *high*, because coverage measures lines executed during the test run — and those lines were executed, by the tests. A coverage tool cannot tell you that the only caller is a test file.

**Review** saw a coherent diff: implementation, tests, documentation, all consistent. Nothing in the diff was wrong. What was missing was a line somewhere else — the call that would have connected it — and diffs are bad at showing you absent code in files they do not touch.

Every gate answered the question it was designed to answer. None of them was asked "is this reachable?", because nobody had thought to ask it.

## The check that was missing

The fix is a script that walks the import graph from the application's real entry points — the three electron-vite entries, following value imports only — and lists every module under `src/` it cannot reach.

Today that reports 170 of 178 modules reached. The remaining eight are allowlisted, and the allowlist is the interesting part: each entry carries **the decision that made it deliberate**. Seven are the Herald, the voice subsystem, built and tested and intentionally unwired pending a milestone that was deferred; that deferral is a recorded decision, not a mystery. The eighth is a contrast utility with its reason in its own header.

The distinction matters more than it might seem. An allowlist of paths is a place for problems to hide — you add an entry to make the build pass and the reason evaporates within a week. An allowlist where every entry must name a decision cannot absorb an accident, because you cannot write down a decision you never made.

## The type-only trap

The first version of the reachability check was wrong in an instructive way: it followed all imports, including type-only ones. That made almost everything look reachable, because types are imported everywhere.

A `import type { Foo } from './foo'` is erased at compile time. It creates no runtime edge. Counting it as reachability means a module can be "reached" by a program that will never load it.

So the walker follows value edges only, and reports the six type-only modules separately rather than counting them as reached. That distinction is the difference between a check that measures reachability and one that measures whether a filename was mentioned.

## What generalises

Coverage answers "did the test run this line?" It does not answer "can the application run this line?" Those questions differ by exactly the bug described here, and the gap is invisible to every conventional tool because they all sit on the test side of it.

If your test suite is the only thing importing a module, your test suite is testing itself.

---

*The reachability walker is `scripts/reachability.cjs`, invoked from `scripts/check-invariants.cjs`. The allowlist and its recorded decisions live in the same file.*
