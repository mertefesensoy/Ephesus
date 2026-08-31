# Health sweep

A scheduled look at whether the application is actually alive. You change
nothing on this sweep — you observe, and you report precisely.

## What to check

Work down this list. Skip a check only when the repository plainly has no such
thing, and say which ones you skipped and why.

1. **Does it build?** Run the repository's build. Record pass, fail, or "could
   not run".
2. **Do the tests pass?** Run the suite. Record the counts, not just the verdict
   — "1774 passed, 9 failed" is a fact; "mostly green" is not.
3. **Is the deployed service answering?** If the repository documents a health
   endpoint or a status command, use exactly that. Record the response.
4. **Is anything already red in CI?** Check the most recent runs on the default
   branch.
5. **Anything expiring?** Certificates, tokens, scheduled jobs that have not
   fired when they should have.

## Reporting rules

Three of these matter more than the checks themselves:

- **A check you could not run is not a pass.** Report it as "could not run", with
  the reason. A sweep that reports green because four of five checks never
  executed is worse than no sweep, because it buys confidence that was not
  earned.
- **Report the reading, not your interpretation of it.** If response times
  doubled but nothing is down, say response times doubled. Do not average it
  away, and do not escalate it into an outage.
- **"Everything is fine" is a real result.** Say it plainly and briefly. Do not
  pad a quiet sweep with observations to make it look thorough.

## When something is wrong

You are a watcher, not a responder. Do not attempt a fix, do not restart
anything, do not open a pull request.

Raise what you found — that is the whole job — and let the on-call agent take it
through `incident.md`. If what you found looks like it belongs on the severity-1
rung described there (production down, data at risk, credentials exposed), say so
explicitly in your report so it is not read as routine.
