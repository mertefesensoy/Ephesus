`{{claimedBy}}` triaged a CI failure on `{{repo}}` and named a root cause. You
are being asked to check it. You did not triage this incident and you are not
being asked to fix anything.

## The claim

> {{claim}}

The source it says it rests on:

{{cites}}

Incident `{{incident}}`, run #{{ref}} — {{url}}

## What you are being asked to do

**Try to refute it.** Open the files above at the lines given and read what is
actually there. Your job is not to decide whether the claim sounds reasonable —
it will sound reasonable, it was written by a colleague who read the same
repository. Your job is to find out whether the source says what the claim says
it says.

Read the cited lines first, then enough around them to know whether the quoted
text still means what the claim needs it to mean. If a function is said to lack
a parameter, read its signature. If a value is said to be hardcoded, find where
it is assigned. Follow one call site outward when the claim depends on one; do
not audit the repository.

Quote what you find. Every line you quote must be one you actually opened — a
quote you reconstructed from memory or inferred from a name is the exact failure
this whole exchange exists to catch, and it is worse coming from you than from
the agent you are checking, because your answer is the one that gets believed.

## How to answer

Reply to `agent.harbor` with the subject `{{verdictSubject}}` and this JSON body:

    {
      "schemaVersion": 1,
      "kind": "root-cause-verdict",
      "incident": "{{incident}}",
      "verdict": "refute",
      "because": "what you found, and why it does or does not support the claim",
      "read": [
        { "file": "path/as/you/opened/it.py", "line": 122, "quote": "the text on that line" }
      ]
    }

`verdict` is one of three:

- `agree` — you opened the cited source and it supports the claim.
- `refute` — you opened it and it does not. Say what it says instead.
- `cannot-tell` — you could not get far enough to know. The file was gone, the
  branch was gone, the claim is about runtime behaviour rather than source, you
  ran out of context. Say which.

**You are reading the checkout as it is now, not as it was when the run failed.**
Nothing here pins a commit. If the file does not match the claim because the fix
already landed, or because you are on a different branch than the run was, that
is `cannot-tell` and you should say so — `refute` means the claim was wrong
about the source, not that the source has since moved. Check `git log` on the
file if you need to tell those apart.

`read` must carry at least one line you actually opened for `agree` and for
`refute`, and at least one of those lines must be in a file the claim cited —
a verdict on files nobody claimed is an answer to a different question. For
`cannot-tell` it may be empty; `because` may not.

`cannot-tell` is a real answer and costs you nothing. An `agree` you are not
sure of costs the company the thing it asked you for.

## What happens to your answer

It is recorded beside the claim, not instead of it. Neither of you is overruled
by the other: the Architect reads both, with the lines each of you quoted, and
decides. That is also why a refutation with no quoted source is refused back to
you — an unevidenced "wrong" is worth no more than the unevidenced claim it
disputes.

Nothing you say here changes the incident's severity or reopens it. You are not
being asked whether the on-call agent handled it well.
