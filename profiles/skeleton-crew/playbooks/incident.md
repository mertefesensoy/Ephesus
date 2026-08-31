# Incident response

You are on call. Something failed and a task was opened for you. Work these
steps in order. Do not skip ahead to a fix you already suspect — the triage step
is what tells the Architect how urgently to care, and you are the only one who
assigns that.

## 1. Triage — what actually broke?

Read the incident's facts first: repository, run number, conclusion, URL. They
came from GitHub verbatim and are the only things anyone knows yet.

Then find out what failed, specifically:

- Fetch the failing run's logs. Name the failing job and the failing step.
- Read the actual error, not the summary line.
- Check whether the same job passed on the previous commit. A test that has been
  red for a week is a different incident from one that went red an hour ago.

Write down what you found before moving on. If you cannot get the logs, say so —
"could not retrieve the run log" is a real triage result and a useful one.

## 2. Assign a severity

This is a judgment call and it is yours. Two rungs:

**Severity 1** — the Architect needs to know now, not at the next standup:

- production is down, degraded, or serving errors to real users
- data is being lost, corrupted, or exposed
- the default branch is broken for everyone
- a security control has failed, or a credential may have leaked
- a release currently going out is shipping the fault

**Severity 2** — everything else, including most red builds:

- one test is flaky or newly failing on a branch
- a lint or type error
- a dependency's own CI broke, not ours
- a timeout that passes on retry

When you are genuinely torn between the two, choose 1. The cost of waking the
Architect for a severity-2 is an interruption; the cost of sleeping through a
severity-1 is the incident.

Never pick a severity to manage how the report will look. A quiet incident that
was actually serious is the worst outcome available to you.

## 3. Reproduce

Reproduce the failure locally before changing anything. If it will not
reproduce, that is important information — say so, and say what you tried.

Do not fix what you have not reproduced. A change that makes CI green without a
reproduction has, as far as anyone can prove, only made the symptom quieter.

## 4. Attempt the playbook fix

Only these, and only when triage points clearly at one:

- **Re-run** a job that failed on an infrastructure fault (runner died, network
  timeout, registry 5xx). Once. If it fails again, it is not infrastructure.
- **Revert** the commit that introduced the failure, when it is unambiguous and
  recent and the revert is clean.
- **Patch** the fault directly, when it is small, understood, and covered by a
  test you can point at.

Anything larger is not a playbook fix. Stop and escalate instead — that is not a
failure on your part, it is the runbook working.

## 5. Gates

These require approval before you do them, every time:

- opening a pull request
- pushing to any shared branch
- force-pushing anything
- deleting a branch
- anything touching production
- adding a dependency

Propose the action and wait. Do not look for another route to the same effect;
the gate is the Architect's decision point, not an obstacle in front of one.

## 6. Report

Reply to `agent.harbor` with the subject `INCIDENT-TRIAGE` and the JSON body the
request showed you:

- `severity` — what you assigned in step 2
- `resolved` — `true` only if the fix in step 4 actually worked, and you
  verified it. Not "should work". Not "the re-run is queued".
- `summary` — one line, your own words: what broke, and what you did.

Then, if it is resolved, `inform` Artemis so it lands in the next standup. If it
is not, escalate with everything you learned in steps 1 and 3 — an escalation
carrying a real diagnosis is worth ten that say "CI is red".

Report what happened, not what you hoped would happen. Everything downstream of
this message — the standup, the ledger, the Architect's sense of whether the
company is trustworthy — is built on your summary being true.
