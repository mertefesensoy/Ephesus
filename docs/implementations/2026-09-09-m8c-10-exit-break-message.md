# The exit script must not tell the crew the break is deliberate

**Date:** 2026-09-09 · **Milestone:** M8c.10 · **Branch:**
`fix/m8c-10-exit-break-message` from `origin/main` `11cc60a`

---

## 1. Problem / motivation

Finding B of [the M8b rehearsal](../demo/m8b-rehearsal-m8b-rehearsal.md). `docs/EXIT-M8.md`
§3 dictated the commit message for the deliberate break the whole exit run is
built around:

```bash
git commit -am "test: break one assertion for the M8 exit run"
```

The on-call agent read that message and did the right thing:

> …I reproduced it locally, confirmed a one-line revert turns the suite green (3
> pass, 0 fail), and **opened no PR because the break is self-described as a
> deliberate rehearsal fixture and main is unaffected.**

Good judgement, wrong outcome. SRS §6.1 clause 2 asks whether the crew *"fixed
it or opened a fix PR"*, and **the script was instructing the crew not to.** The
clause was unmeasurable as written, and the rehearsal proved the causality
rather than inferring it: pushed again with an ordinary message
(`refactor(geo): simplify the interpolation arithmetic`, a sign typo), the same
crew triaged the same class of break as a genuine defect and opened PR #3 — the
correct one-line fix, merged, `main` green.

This was invisible on 2026-09-09 because the crew never reached triage at all.
**M8b is what let the crew act, and acting is what found it.**

It is the first package of M8c on purpose: it is cheap, and until it lands every
verification measured against `EXIT-M8.md` is measured against a script that
cannot measure the thing.

---

## 2. What changed

| File | What |
|---|---|
| `docs/EXIT-M8.md` | §3 asks for a one-line defect in the code under test, under an ordinary branch name and an ordinary commit subject; a paragraph says why the wording *and the diff* are part of the test and cites the run that proved it. §7 asks the runner to record the branch and sha of their own plant. |
| `test/docs/exit-m8-script.test.ts` | **new**, 5 cases. Parses §3 and refuses a commit message or branch name that announces the break, checks the reason is still stated and that a code defect is what is asked for, and carries a CONTROL that runs the same predicate over the 2026-09-09 string — and four subtler ones — and asserts each is rejected. |

No production change. The defect was in the script, not in the harness.

---

## 3. Implementation approach

**The break has to look like an ordinary mistake, and the record has to say it
was not.** Those two are in tension, and §3 now resolves them in different
places rather than in the same sentence:

- what the *crew* sees — a branch named `refactor-interpolation` and a commit
  subject `refactor(geo): simplify the interpolation arithmetic` — carries
  nothing that identifies the failure as planted, which is the state a real
  incident arrives in;
- what the *record* says — §7 now asks for the branch and the commit sha of the
  plant — keeps it identifiable to every later reader.

Nothing asks the runner to falsify anything. The message describes the edit in
the terms an ordinary careless commit would use; only the *deliberateness* is
withheld, and it is withheld from exactly one audience.

**The branch name is fixed for the same reason as the message.** It reaches the
on-call agent in the same CI payload the subject line does — the rehearsal's own
triage report quotes it (*"failed on branch `exit-m8-broken-test`"*) — so a
neutral message under a branch called `exit-m8-broken-test` would have left half
the announcement standing. The acceptance names the message; the branch is the
same defect on the adjacent line, and neutralising it costs nothing.

**Why the guard is a test over the document.** Because the document is where the
defect was, and prose is the one artifact in this repository with no compiler.
This is the second time a documentation fix reached one section and not the one
a reader was actually sent to — the exit run's Finding 1 is the first, where the
Node floor was corrected in *Quick start* while `EXIT-M8.md` §1 kept pointing at
*Setting it up*. A regression test named for the bug is ENGINEERING-STANDARDS
§6.2's rule, and it applies to a defect in a script exactly as it applies to one
in a function.

---

## 4. Mathematical / statistical details

None — no formula, statistical test or numeric algorithm is involved. The one
quantitative claim in the finding is the rehearsal's own count: one break with an
announcing message produced zero pull requests, one break with a neutral message
produced one correct pull request, over the same crew and the same repository
within one hour.

---

## 5. Design decisions

**A test over prose, rather than trusting the fix.** The alternative was to edit
§3 and rely on review. Rejected: the whole finding is that a sentence nobody
re-reads decided the outcome of an hour-long acceptance run, and the same class
of drift has now happened twice in this document.

**A word list, rather than pinning the exact string.** Pinning
`refactor(geo): simplify…` would pass for one message and fail every legitimate
rewording, which is a check that fails for the wrong reason. The word list asks
the real question — *does this announce itself?* — and is deliberately generous
(`break`, `deliberate`, `fixture`, `on purpose`, `exit run`, `rehearsal`, …).

**A CONTROL case, because a word list can rot into a tautology.** A matcher that
silently stopped matching anything would make the first three cases pass
everywhere and prove nothing. So the fourth case feeds the predicate the exact
string the 2026-09-09 run used and asserts it is **rejected** — and the branch
name too — then feeds it the message the rehearsal proved works and asserts it is
accepted. This is the same discipline the mutation round below uses, applied
inside the test itself: *give the checker a case it must fail.*

**§3 now asks for a defect in the code, not an edited assertion — and that came
out of the adversarial pass, against the first version of this fix.** The
rehearsal's evidence has two variables in it, not one. The break that produced
**no** pull request was *an edited assertion under an announcing message*; the
break that produced **PR #3** was *a one-line sign defect in the code under an
ordinary message*. Nobody has ever run the fourth cell — an edited assertion
under a neutral message — so a fix that changed only the subject line would have
been resting on evidence that does not isolate it.

The crew reads the diff as well as the subject line, and the rehearsal proves it
does: its triage report says *"commit `9dd8bcf` edited a test assertion to an
incorrect expected value"*. An assertion moved to an obviously wrong expected
value is its own announcement. So §3 now asks for the shape that was actually
observed to get fixed, keeps the assertion edit as the older alternative, and
says why in the same paragraph. This is the whole reason the adversarial pass is
not optional: the first version of this package passed its tests, killed six
mutants, and satisfied the acceptance as filed while leaving clause 2 measurable
only by luck.

---

## 6. Verification

Full gate, this branch:

```
npm run typecheck && npm run lint && node scripts/check-invariants.cjs &&
npm run test:coverage && node scripts/check-coverage.cjs
```

*(figures in the pull request)*

**Mutation round, with a control** — `docs/DECISIONS-LOG.md` 2026-09-09 requires
a proven-green baseline, a planted no-op whose survival certifies the round,
byte-exact restore checked by hash, a committed tree so `git checkout --` is the
restore, and the test files the round ran named. Every mutant was applied to
`docs/EXIT-M8.md`, one at a time.

*(result in the pull request)*

**Adversarial refutation pass.** What was tried against this package, and what it
found:

| Attempt | Result |
|---|---|
| Does a neutral *message* alone make clause 2 measurable? | **BROKE IT.** The rehearsal's evidence changes two variables at once; the crew reads the diff. §3 now asks for a code defect — see §5. |
| Does the branch name still announce it? | **BROKE IT** (in the first draft). `exit-m8-broken-test` reaches the agent in the same CI payload as the subject — its own triage quotes the branch. Both are neutral now, and both are asserted. |
| Can the matcher be fooled by a subtler announcement? | **BROKE IT.** `chore: seed a failing test for the acceptance run` passed the first word list. Six more terms added, each with a control case asserting it is caught. |
| Can the matcher rot into a tautology? | Held. The CONTROL case feeds it strings it MUST reject and two it must accept, so a matcher that stopped matching fails the suite. |
| Does the guard survive §3 being renumbered or retitled? | Held — `section()` fails with *"EXIT-M8.md has no `## 3.` heading"* rather than silently parsing nothing. |
| Does a typographic apostrophe slip `don't fix` past it? | Held — the pattern accepts `don't`, `don’t` and `do not`. |
| Is the control mutant far enough from the assertions to be vacuous? | No — it rewords prose *inside* the parsed §3 body, so it exercises the same text the assertions read and still survives. |

**To reproduce the defect this fixes**, without a repository: read §3 as an
on-call agent would, then read the rehearsal's triage quote in
[the record](../demo/m8b-rehearsal-m8b-rehearsal.md) §4. The agent's reasoning
is stated in its own words and it is correct reasoning about the message it was
given.

---

## 7. Related docs

- [`docs/EXIT-M8.md`](../EXIT-M8.md) §3, §7 — the script this fixes
- [`docs/demo/m8b-rehearsal-m8b-rehearsal.md`](../demo/m8b-rehearsal-m8b-rehearsal.md) — Finding B, the evidence
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8c.10 and its acceptance
- [`docs/srs/SRS.md`](../srs/SRS.md) §6.1 — clause 2, the clause this makes measurable
- [`docs/ENGINEERING-STANDARDS.md`](../ENGINEERING-STANDARDS.md) §6.2 — a fixed bug owes a regression test named for it
