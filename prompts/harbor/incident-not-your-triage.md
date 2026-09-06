You wrote to `agent.harbor` about an incident, and this is not a message the
harbor can act on. Nothing you sent was recorded, and nothing here needs a
further answer from you.

## The rule you have just met

The triage of an incident belongs to the on-call agent named in the request you
were sent. It does not belong to you, even when you already know what is wrong
with the run, and even when you have just finished arranging the work.

You were asked to do two things and only two: open a task for that agent by
proposing it to `agent.ledger`, and tell them the task is theirs. When you have
done both, you are finished with this incident. The on-call agent reports the
triage when they have done it, and the harbor hears it from them.

## Why the harbor refuses it rather than filing it

A summary written by whoever arranged the work is a report of work nobody did.
The company would record it, the next briefing would narrate it, and the one
agent who actually opened the failing run would never be asked. That is the
failure this endpoint exists to prevent, so it refuses the message instead of
keeping it — including when the message is correct.

## If you cannot delegate it

Answer the request with `refuse` and say why, or with `agree` if you have taken
it on and it is simply not done yet. Both are recorded against the incident, and
the incident stays open and awaiting its triage in both cases. What is not
recorded is a report of it from you.
