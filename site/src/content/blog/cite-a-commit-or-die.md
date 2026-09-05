---
title: 'A research department that must cite a commit or die'
date: 2026-08-29
tag: 'design'
reading: '6 min read'
summary: 'The Stoa reads other people’s repositories and reports what it finds. The rule that makes it trustworthy also caught it citing a commit that existed in no repository at all.'
---

Ephesus has a research department. You register a repository by URL, tag it, record its licence, and pin it to a commit. A researcher agent studies it and files a brief. Approved findings become improvement proposals, which pass through the same gates as any other change.

That is a straightforwardly dangerous thing to build. An agent reading arbitrary external repositories and producing recommendations is one confident hallucination away from putting fiction into your codebase, and one embedded instruction away from doing something worse.

Two rules do most of the work.

## Every finding cites a path at the pinned commit

Not "the repository does X." A path, at the pin: `src/hooks/stop.js`, at `b91a49f`. A brief whose findings cannot all be resolved that way is **refused as a whole** before a human reads it. Not flagged, not annotated — refused.

Refusing the whole brief rather than dropping the bad finding matters. If unsupported findings are silently removed, a reader has no way to know how much was removed, and the surviving text still carries the confidence of the removed reasoning. If the brief fails entirely, the failure is visible and the researcher runs again.

The pin is what makes citation meaningful. Without it, "see `src/hooks/stop.js`" is a claim about a moving target — true when written, false a week later, and unfalsifiable in between. With it, any reader can check, and so can a script.

## Watched content is data, never instructions

Anything read from a registered source is untrusted input. The researcher plan is read-only and secret-free by construction — no write access, no credential grants, no network beyond the pinned checkout. Text in a source that looks like an instruction is **reported as a finding**, not followed. Nothing from a source reaches code, prompts or configuration except through a proposal that a human approved.

This is the same posture a security-conscious system takes toward user input, applied to a place people do not always think to apply it. A README is data. A code comment is data. A file called `AGENTS.md` in someone else's repository is data.

## The rule caught its own department

At the close of the milestone that shipped this, an audit re-ran the research cycle against a real, remotely verifiable pin.

The original demonstration had cited a commit that **existed in no repository**. The hash was plausible. It was the right length, the right alphabet, in the right position. It was not real.

Everything downstream had looked correct: the brief was well-formed, the finding was sensible, the proposal that descended from it cited the brief properly, and the ledger entry cited the proposal. The whole chain was structurally sound and rooted in nothing.

The citation rule is what surfaced it, because a citation rule is only worth having if something actually resolves the citations. The record was amended and the chain re-proven end to end against a pin anyone can check.

## Why this is the interesting failure

It would have been easy for that demonstration to stand. It was internally consistent, and every reviewer looking at it was checking whether the *shape* was right — brief cites path, proposal cites brief, ledger cites proposal. The shape was perfect.

Which is the same defect this project keeps finding under a different name: a check that verifies structure while the thing it structures is absent. A citation that is well-formed but unresolvable passes every check except the one that tries to follow it.

So the rule is not "briefs must cite." It is "**citations must resolve, and the resolving must actually happen**." The second half is where the value is, and it is the half that gets dropped when people are busy.

---

*The Stoa's rules are recorded in ADR-0017 and enforced in `src/main/stoa.ts`. The first brief and the amended record are in [`docs/stoa/`](https://github.com/mertefesensoy/Ephesus/tree/main/docs/stoa).*
