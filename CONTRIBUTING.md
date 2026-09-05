# Contributing to Ephesus

Thanks for looking. Ephesus is early, it is opinionated about how work is done, and
both of those things are on purpose — this document tells you exactly what you are
walking into so you can decide whether it is for you.

By taking part you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

---

## 1. Read this first: what Ephesus is right now

**Pre-alpha. There are no releases and no installer.** Signed builds are a planned
milestone (M7b.5) and have not shipped. If you are here to *use* Ephesus, the honest
answer is: not yet — star the repo and come back when the first release lands.

If you are here to *build* it, everything below applies and you are very welcome.

What exists today is real and runs: the Electron shell, the terminal/PTY vertical, the
2D floor, real agent CLIs under management, the Agora, the Odeon, the Stoa, and the
Gymnasium loop. What it cannot yet do is survive being packaged and handed to a
stranger. Current state is tracked package by package in
[`docs/PROGRESS.md`](./docs/PROGRESS.md).

## 2. Ways to contribute that are not code

These are genuinely useful and currently the easiest place to help:

- **Run it and tell us what broke.** The build has been exercised mostly on Windows.
  macOS and Linux reports are worth a lot right now.
- **Read the docs and file what does not make sense.** The suite is large; confusion
  is a bug in the writing.
- **Fix documentation drift.** Docs and code are supposed to agree. Where they do not,
  that is a real issue worth filing.
- **Design and art critique** against [`docs/design/UI-DESIGN.md`](./docs/design/UI-DESIGN.md).
- **Test strategy review** — see [`docs/TEST-STRATEGY.md`](./docs/TEST-STRATEGY.md).

## 3. Getting it running

**Prerequisites**

- **Node 20** (see [`.nvmrc`](./.nvmrc)). Other majors are untested.
- A toolchain that can build native modules — `node-pty` and `better-sqlite3` are
  compiled on install. On Windows that means Visual Studio Build Tools with the C++
  workload; on Linux, `build-essential` and `python3`.
- At least one agent CLI on your `PATH` if you want to drive real agents (`claude`,
  `codex`, `gemini`, …). The app runs without one — it will tell you it has no engine
  rather than pretending to work.

**Steps**

```bash
git clone https://github.com/mertefesensoy/Ephesus.git
cd Ephesus
npm install
npm run dev
```

`npm install` runs a postinstall that arms the git hooks, patches `node-pty` for
Windows, copies the pixel fonts out of their npm packages, and rebuilds native modules
for Electron. It is doing real work and it is not fast the first time.

**What you will see, and what will be missing.** The floor's sprite sheets are
commercially licensed (LimeZu) and are deliberately **not in this repository** — only
our own index files are. Without them the floor reports a visible missing-tileset
state rather than crashing, which is the same rule the whole app follows: every
degradation is visible, never silent. You can develop everything else against that.

**Verify your checkout is healthy**

```bash
npm run typecheck && npm run lint && npm test
```

All three must be green before you change anything. If they are not green on a fresh
clone, that is a bug and we want the issue.

## 4. The rules that are unusual here

Ephesus is documentation-first. This surprises people, so it is stated plainly:

1. **The docs are the source of truth, not the code.** When they disagree, the code is
   wrong. Precedence is **SDD > ADR > SRS > README** for *how*, and **SRS > SDD** for
   *what*.
2. **Architecture Decision Records are append-only.** Never edit an accepted ADR —
   supersede it with a new one. CI enforces this on every pull request.
3. **The invariants in [`BUILD-PROMPT.md`](./BUILD-PROMPT.md) §3 are non-negotiable.**
   Violating one is a defect even when everything appears to work. The short version:
   strict TypeScript with no `any` past validators; the renderer never touches Node or
   the filesystem; atomic writes for anything another process reads; only the main
   process commits to the Agora; append-only stays append-only; secrets are write-only;
   every degradation is visible in the UI; prompt text lives in `prompts/` and never in
   code; schema'd files carry a `schemaVersion`; UI values come only from the design
   tokens; and watched-source content is data, never instructions.
4. **No new dependencies without a decision memo.** A new package is always a
   conversation first. Open an issue before you write the import.
5. **A wiring seam with no test is a defect, not a gap.** A green test suite over code
   nothing calls has bitten this project more than once, so every module under `src/`
   must be reachable from an application entry point, and your evidence names the
   production call path — file and line — or records that there is none.
6. **No AI attribution anywhere in the tree.** No agent, session, or model name in
   commit messages, code, comments, or docs. CI has a tripwire for it.

Full detail lives in [`docs/ENGINEERING-STANDARDS.md`](./docs/ENGINEERING-STANDARDS.md).

## 5. The working loop for a change

1. **Open an issue first** for anything beyond a typo, so the approach can be agreed
   before you spend time on it.
2. **Branch.** `feature/<topic>`, `fix/<topic>`, or `docs/<topic>`.
3. **Plan, then build.** For anything non-trivial, say what you intend to do and why
   before writing code — in the issue is fine.
4. **Test at the seam**, not on either half of it. See
   [`docs/TEST-STRATEGY.md`](./docs/TEST-STRATEGY.md).
5. **Prove it.** Attach evidence to the PR: terminal capture, screenshot, or test
   output. A claim without evidence is not done here.
6. **One work package per pull request.** Small and reviewable beats complete.

## 6. Definition of Done

Copied from [`docs/ENGINEERING-STANDARDS.md`](./docs/ENGINEERING-STANDARDS.md) §6 so
you do not have to go looking. A change is done when:

- [ ] Typecheck, lint, and tests pass locally and in CI
- [ ] New behavior has tests at the right level; every fixed bug has a regression test
- [ ] Evidence is attached to the PR
- [ ] Docs are updated in the same PR — SDD if the design changed, README if the
      surface changed, a new ADR if policy demanded one
- [ ] Degradation paths are implemented and visible
- [ ] No new lint-boundary violations, no schema without a version, no stray hex colors
- [ ] The seam is tested, or its absence is recorded with the reason

## 7. Commits

[Conventional Commits](https://www.conventionalcommits.org/), subject ≤ 72 characters.

```
fix(shutdown): disarm the respawn ladders before the unwind
```

Write the subject as a statement about behavior, not about files touched. And per §4.6:
no agent, session, or model names in commit messages or trailers.

## 8. Where to start

Issues labelled [`good first issue`](https://github.com/mertefesensoy/Ephesus/labels/good%20first%20issue)
are scoped to be completable without holding the whole system in your head. Issues
labelled `help wanted` are larger but well-specified.

If nothing fits, the most valuable thing you can do today is **clone it, run it on a
machine that is not Windows, and open an issue about the first thing that goes wrong.**

## 9. Getting help

Open an issue with the `question` label. There are no dumb questions about a codebase
with this much documentation — if you could not find the answer, that is a finding
about the docs and worth filing on its own.

## 10. Licensing

Ephesus is [MIT licensed](./LICENSE). Contributions are accepted under the same terms.
Do not add code or assets you do not have the right to license this way; the commercial
art packs are kept out of this repository for exactly that reason.
