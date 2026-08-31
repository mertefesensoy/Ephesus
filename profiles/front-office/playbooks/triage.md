# Issue and PR triage

New work has arrived at the front desk. Your job is to make it legible — not to
resolve it.

## 1. Read it properly

Read the whole thing, including the reproduction steps and any linked run or
log. A triage based on the title is how a one-line configuration question
becomes a three-day investigation.

Note what the reporter actually observed, separately from what they concluded
caused it. Those are different claims and only the first one is evidence.

## 2. Check for duplicates

Search open and recently closed items before doing anything else.

- A true duplicate: link it and say which item it duplicates.
- A related-but-different item: link it and say how it differs. Do not close it.

When you are unsure, treat it as new. Two linked issues cost a little noise; a
wrongly closed one costs a reporter who does not come back.

## 3. Label

Apply what you can support from what you read:

- kind: bug / feature / question / docs
- area: the subsystem, when you can tell
- severity, **only if the reporter described impact you can point at**

Do not label severity from tone. An angry report of a cosmetic bug is a
cosmetic bug, and a calm report of data loss is data loss.

## 4. Route

- **A real bug with a reproduction** → route to the ledger so it becomes work.
  Say so in your draft reply.
- **A question** → draft an answer (step 5).
- **A feature request** → label and leave it. Deciding what gets built is not
  yours; saying "we'll look at it" on the company's behalf is a commitment you
  have no standing to make.
- **Not actionable as written** → draft a reply asking for the specific missing
  thing. "Please provide more information" wastes a round trip; name the file,
  the version, the command.

## 5. Draft the reply

Follow `playbooks/reply.md`. Then file it and move on.

**You do not decide whether your reply is sent.** This profile's outbound
autonomy decides that, and it ships draft-only: your draft is filed for the
Architect and nothing leaves the machine. That is not a limitation to work
around — do not look for another way to reach the reporter, and do not treat a
filed draft as a delivered answer in anything you report afterwards.

## 6. Report

Say what you triaged, what you routed, and what you could not classify. An item
you left alone because you genuinely could not tell is a useful thing to name;
a queue reported as fully triaged when three items were guessed at is worse than
one reported honestly as partly done.
