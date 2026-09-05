---
title: 'The recurring defect of this codebase is a check that cannot fail'
date: 2026-09-02
tag: 'method'
reading: '7 min read'
summary: 'Five instances found in a single day, in five different subsystems, by five different routes. The pattern was not carelessness — every one of them was written by someone trying to be careful.'
---

On 2 September, while planning a hardening milestone, we found five separate instances of the same defect in one day. They were in different subsystems, written weeks apart, found by different routes. Once we had a name for the shape, they stopped looking like five bugs and started looking like one.

The shape is this: **a check that reports success in a way that could never have reported failure.**

Not a check that is wrong. A check that is *inert*. It runs, it passes, it produces a green mark, and the green mark carries no information because there is no reachable state of the world in which it would have come out otherwise.

## The five

**A coverage figure that rose while the wiring stayed untested.** Coverage over a whole repository is an average, and averages hide their worst members. Adding tests to already-well-covered pure functions raised the number. The untested seams — the places where two subsystems actually meet — stayed untested, and the metric went up anyway.

**A matcher for output the CLI never emits.** An engine adapter needs to know whether you are logged in, so it ran `claude auth status` and looked for `logged in as` or `account:`. The CLI answers JSON by default — `{"loggedIn": true, …}` — and `Login method: …` in its opt-in text mode. It matched neither. The `needs-login` state that adapter exists to raise could not fire on any machine on earth.

It had forty-five green tests. Every one of them fed it strings we had written ourselves.

**A suite reporting green over 1,406 unreachable lines.** A milestone shipped a subsystem that was fully implemented and fully tested, and that nothing in the application ever called. The tests imported the modules directly. The application did not import them at all. Every test passed and the feature did not exist.

**A scorer whose reproduce path matched its prod path.** A check meant to prove that a reproduction genuinely reproduced the production failure compared the two by a route that was identical on both sides. It could only ever agree with itself.

**A spoken refusal that confirmed a gate.** A voice interface was supposed to refuse an action when a gate was open. The refusal text was generated from the same state that the gate check read, so the refusal was emitted whether or not the gate had actually held. The check confirmed the thing it was supposed to be testing.

## What they have in common

None of these were written by someone being lazy. Every one was written by someone adding a check *because they were being careful*. That is what makes the pattern dangerous: the defect is invisible precisely to the diligence that produces it. You have written a test. The test is green. The instinct that would make you look harder has been satisfied by the very artefact that should have triggered it.

They also share a structural property. In each case **the check and the thing being checked share a source**. The tests and the matcher shared the author's assumption about the output format. The suite and the modules shared an import path the application did not use. The scorer's two sides shared a code path. The refusal and the gate shared their state.

A check is only worth something when it can disagree with the thing it checks. Sharing a source removes the possibility of disagreement.

## The response

The obvious response — be more careful — is itself a check that cannot fail. You cannot observe your own future carelessness, so a resolution to avoid it produces no signal. It had to be mechanical.

**A wiring seam with no test is a defect, not a gap.** This is the load-bearing one. The old framing treated missing coverage as debt: regrettable, tolerable, deferred. The new framing makes it a defect, which means it blocks. Concretely, a work package's evidence must name the production call path — file and line — where the new code is actually reached, or state explicitly that there is none and why that is acceptable.

**Every production module must be reachable from an application entry point.** A script walks the import graph from the three real entry points and lists what it cannot reach. Today that is 170 of 178 modules; the other eight are allowlisted, each **with the decision that made it deliberate** recorded beside it. An unreachable module is not an oversight to be discovered later — it fails the build now.

**An engine adapter may not match on output this repository has never seen.** Every probe an adapter declares must be backed by a capture from a real installation, stored with its command, engine version, platform and date — or waived in writing, with the reason. The tests run the shipped matcher over those bytes. You can no longer test a matcher against your own imagination.

**Coverage floors are per subsystem, and they only rise on corroborating runs.** Seventeen subsystems, each with its own floor, each measured with the condition it was measured in — commit, platform, node version, a hash of the production tree. A floor rises only after several runs agree, and a fall is a hand edit that has to justify itself in the diff.

## What it cost to learn twice

That last rule exists because the first version of the coverage gate was itself a check that could not fail. A single repository-wide number would have risen steadily while the seams stayed bare — exactly the defect it was introduced to prevent.

We caught that one before it landed, but only because we had just spent a day naming the pattern. Ten minutes of deliberately trying to defeat the new gate found three ways past it.

That is now part of the process too: when you build a gate, spend the ten minutes trying to walk through it. A gate that has not been attacked is a check that has not yet been shown capable of failing.

---

*The rules described here are in [`docs/ENGINEERING-STANDARDS.md`](https://github.com/mertefesensoy/Ephesus/blob/main/docs/ENGINEERING-STANDARDS.md) §6 and are enforced by `scripts/check-invariants.cjs` and `scripts/check-coverage.cjs`.*
