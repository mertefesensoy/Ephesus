---
title: 'The MVP ships one engine, and says so'
date: 2026-09-02
tag: 'decision'
reading: '4 min read'
summary: 'Ephesus is designed around an engine-agnostic adapter seam. It ships with exactly one engine wired — and the decision record exists mostly to stop that being misread in both directions.'
---

Ephesus wraps terminal agent CLIs. The design has always been engine-agnostic: an adapter seam, several adapters, no assumption that any particular vendor is present.

The MVP ships one. `claude` is wired, tested and supported. The others are not.

That is a small decision with a disproportionate amount of writing behind it, and the writing is the point.

## Two ways to misread it

The first misreading is that the seam is decorative — that "engine-agnostic" is aspiration and the real design is single-vendor. It is not. The adapter interface exists, the conformance suite exists, and adapters are tested against captured output from real installations rather than against strings we invented.

The second misreading is the opposite: that because the seam exists, the other engines basically work and merely lack polish. They do not. An adapter that has never been run against a real installation is not a nearly-finished adapter. It is a hypothesis.

The decision record exists to hold both of those at once, because in practice a project drifts toward whichever misreading is more convenient at the time.

## The rule that came out of it

The interesting consequence is a rule about evidence:

> An engine adapter may not match on output this repository has never seen.

Every probe an adapter declares — how it detects a version, how it detects a login — must be backed by a capture from a real installation, stored with its command, engine version, platform and date. Or waived in writing, with the reason. The tests run the *shipped* matcher over those captured bytes.

That rule has a specific origin. An adapter shipped a matcher for `claude auth status` that looked for `logged in as` and `account:`. The CLI answers JSON by default and `Login method:` in its text mode. It matched neither, always answered "cannot tell", and the state it existed to raise could not fire on any machine — behind forty-five green tests, every one feeding it strings we had written ourselves.

You cannot write an adapter for output you have not seen. You can only write an adapter for output you *imagine*, and imagination is not a source of truth about somebody else's CLI.

## Why this is on the website

Because the temptation on a marketing page is exactly the drift the decision record was written to prevent. The first draft of this site listed three engines in its opening sentence. All three are in the design. One is in the product.

Listing them would not have been a lie in any way I could have been caught out on — the README says the same, the architecture supports it, and "planned" is doing honest work. It would simply have claimed more than is wired, on the page where a stranger forms their first impression, in a project whose entire method is that a claim without evidence is not done.

So the page says one engine, and says why.

---

*This is ADR-0024, accepted 2 September 2026. The captures live in `test/fixtures/engine-output/` with their provenance recorded alongside.*
