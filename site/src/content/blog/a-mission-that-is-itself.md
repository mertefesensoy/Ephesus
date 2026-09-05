---
title: 'A project whose primary mission is its own improvement'
date: 2026-08-28
tag: 'design'
reading: '6 min read'
summary: 'The Gymnasium lets the company propose changes to itself. Everything interesting about it is in the constraints — a falsifiable metric before any human reads it, and a ledger that keeps the rejections.'
---

The company's standing mission is to improve itself. Not as a slogan — as a subsystem, with a loop: observe, propose, gate, land, measure.

Left alone, that idea produces sludge. Any system asked to suggest improvements to itself will generate an endless stream of plausible, unfalsifiable suggestions — *improve error handling*, *consider refactoring the router*, *add more tests* — each of which is agreeable, none of which can be shown to have worked or not worked. You would drown in reasonable text.

Three constraints stop it.

## A proposal must carry a falsifiable metric before a human sees it

Every proposal declares, up front, what would count as it having failed. Not a goal — a measurement, with a number, that could come out the wrong way.

"Improve startup time" is rejected before it reaches the architect. "Reduce cold-start to first-frame below 1.8s, measured by the existing boot timer over ten runs" is a proposal. It might land and not work, and the ledger will say so.

This is a gate against the system's own fluency. A language model can produce indefinite quantities of sensible-sounding improvement. Requiring a falsifiable metric costs almost nothing when the proposal is real and is nearly impossible to satisfy when it is not, which makes it an unusually good filter.

## Proposals descend from evidence, not from vibes

A Gymnasium proposal must cite what it came from: a research brief, an incident, an entry in the event log, a retro finding. It must point at something in the company's own operating record.

This closes a specific loop. The Stoa studies external repositories and files briefs whose findings cite paths at pinned commits. Those briefs are what improvement proposals descend from. So a change to Ephesus that originated in someone else's codebase can be traced backwards: proposal, to brief, to finding, to a path at a commit you can check.

The first two landed improvements came through exactly that chain.

## The ledger keeps the rejections

Every proposal stays, whatever happens to it — proposed, approved, rejected, landed, measured, rolled back. The rejections and the rollbacks are the valuable part, because they are the only record of what was *tried* and did not work.

A ledger of successes is marketing. A ledger that keeps its failures is evidence, and it is also the thing that stops the same bad idea being proposed every month.

## What the machinery refuses

Verdicts are the architect's alone. There is no delegated class in which the company approves its own improvements, and that is deliberate: a system that can approve changes to itself can approve changes to what it is allowed to approve.

**Authority-widening proposals are refused before any approver could say yes.** A proposal whose effect is to increase what the company may do without asking does not get queued for a human decision — it is rejected by the machinery. That removes the possibility of a tired architect clicking approve on the one proposal that should never have been offered.

The autonomy mode that lets improvement work run unattended cannot be switched on until a proof gate reads its evidence off the ledger. You cannot assert that the loop is trustworthy; the ledger has to demonstrate it. And a hard breaker stop on improvement work reverts the mode.

## Is any of this novel?

The loop is not. Observe, propose, gate, land, measure is just the scientific method with a work queue attached.

What is unusual is applying it during construction rather than after. The Gymnasium was not built to run once Ephesus ships — it runs now, on the project's own build, and the shape does not change when the system starts running for real. The first proposals were about the harness's own hook boundary and its shutdown path.

A self-improvement loop that only turns on at version 1.0 has never been tested against anything. This one has been carrying its own weight since well before there was a product to improve.

---

*The Gymnasium's governance is ADR-0015; the ledger is [`docs/gymnasium/LEDGER.md`](https://github.com/mertefesensoy/Ephesus/blob/main/docs/gymnasium/LEDGER.md).*
