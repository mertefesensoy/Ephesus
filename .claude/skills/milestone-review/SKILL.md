---
name: milestone-review
description: Verify an Ephesus milestone's exit criteria before declaring it done — run the named scenario suites, check every package's evidence, update PROGRESS.md, and produce an architect-facing review. Use when a milestone looks complete or the user asks "are we done with M<x>?".
---

# Milestone exit review

1. Identify the milestone under review from `docs/PROGRESS.md`.
2. Read its section in `docs/IMPLEMENTATION.md` and list its **exit criteria** and
   **named scenario suites** (S-*) verbatim.
3. For each exit criterion: verify it *by running it*, not by reading code. Record the
   command and observed result. A criterion nobody ran is unmet.
4. Run the milestone's S-suites (specs in `docs/TEST-STRATEGY.md` §3). All must pass.
   A suite that doesn't exist yet means the milestone is NOT done — implementing it is
   part of the milestone.
5. Sweep for debt that blocks closing: unchecked packages, TODO/stub markers in
   milestone code (`grep -rn "TODO\|FIXME" src/`), must-ask questions still open in
   past session reports, docs that now lie about the code (run `/doc-sync`).
6. Write the verdict into `docs/PROGRESS.md` under the milestone: DONE (with evidence
   links) or NOT DONE (with the precise gap list as new unchecked items).
7. Report to the Architect: verdict first, then the evidence table, then gaps.

Never soften a criterion to close a milestone. If a criterion seems wrong, that is a
must-ask for the Architect, not a judgment call.
