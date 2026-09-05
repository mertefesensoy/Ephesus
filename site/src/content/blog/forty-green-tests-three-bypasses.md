---
title: 'Forty green tests, nine killed mutants, three bypasses'
date: 2026-09-03
tag: 'method'
reading: '5 min read'
summary: 'A new coverage gate passed its own tests, survived mutation testing, and was defeated three times in ten minutes by someone actively trying to walk through it.'
---

We built a gate. Its job was to stop coverage regressing at the seams between subsystems — the specific failure that had bitten us repeatedly.

By the time it was ready it had forty passing tests. We then ran mutation testing against it: change an operator, flip a boundary, invert a condition, and see whether any test notices. Nine mutations, nine caught. That is a good result. A surviving mutant means some line of your code can be wrong without any test objecting.

Then someone spent ten minutes deliberately trying to get a regression past the gate, and found three ways.

## What the tests were doing

The forty tests all asked the same kind of question: *given this input, does the gate produce the right verdict?* They were thorough about inputs. Empty reports, missing subsystems, malformed numbers, floors at boundaries, floors just below.

Mutation testing improved that further — it proved the tests were sensitive to the gate's logic rather than merely executing it.

But both techniques share an assumption: **that the gate is being asked.** Every test called the gate directly. Every mutation changed code inside the gate. Neither could see a path where the gate is never invoked in the first place.

## The three bypasses

They were all of that shape.

The first was about **which report gets read**. The gate compared figures against a coverage summary on disk. Nothing checked that the summary was produced by *this* run. A stale file from an earlier, better run would satisfy it — with all forty tests still green, because they always handed it a fresh report.

The second was about **the subsystem map**. Floors are per subsystem, and subsystems are defined by a map from file paths to names. A file matching no entry belonged to no subsystem, so it was covered by no floor. Adding a new module to an unmapped directory made it invisible to the gate rather than failing it.

The third was about **the ratchet**. Floors rise as coverage improves. The raise path and the check path read the same file. A raise recorded from a run that was not corroborated could lift a floor above reality, and the next honest run would then fail — so the pressure was to lower it by hand, which was allowed and unrecorded.

None of these is a bug *in* the gate. Each is a bug in the space around it: what it reads, what it can see, and what can quietly edit its inputs.

## What we changed

Every coverage figure now travels with **the condition it was measured in** — commit, ref, a hash of the production tree, platform, node version, and the command that produced it. The gate refuses a report whose identity does not match the run asking about it.

The subsystem map became **total**. Every production file must map to exactly one subsystem, and the check fails if any file maps to none. A new module cannot be invisible; it can only be somewhere.

A floor now rises **only after several corroborating runs on the same production tree**, and only to the minimum across them. A fall is a hand edit that must justify itself in the diff.

## The lesson, stated carefully

Mutation testing tells you whether your tests are sensitive to your code. It does not tell you whether your code is reachable, whether its inputs are authentic, or whether its coverage is total. Those are different questions and they need different attacks.

Tests and mutants both operate inside the boundary of the thing you built. An adversarial pass operates on the boundary itself — and the boundary is where gates fail.

So it is now budgeted. Any work package that ships a gate spends ten minutes afterwards trying to defeat it. Ten minutes found three bypasses that forty tests and nine killed mutants did not, which makes it the cheapest verification in the process by a wide margin.

---

*The corroboration rules and the condition record live in `scripts/coverage-floors.json`, which documents its own schema.*
