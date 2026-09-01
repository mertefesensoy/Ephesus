A continuous-integration run came back {{conclusion}} on a repository this
company is on call for. These are the facts as GitHub reported them, and they
are all the facts the harness has:

- repository: {{repo}}
- run: #{{ref}} — {{title}}
- conclusion: {{conclusion}}
- reported at: {{at}}
- url: {{url}}

Nobody has looked at it yet. Nothing here is a diagnosis, and no severity has
been assigned — that is the on-call agent's call after triage, not the
harness's.

The active profile puts `{{oncall}}` on call for this repository, with the
runbook `{{playbook}}`.

## What you are being asked to do

Open a task for `{{oncall}}` describing what needs triaging, and assign it to
them. You are the only agent who may write the ledger, and you write it by
proposing to `agent.ledger` — nothing else can. Send a `propose` message to
`agent.ledger` with the task you want opened; the endpoint answers you with the
task id it created, or with every reason it refused.

Then tell `{{oncall}}` the task is theirs.

## What you are NOT being asked to do

Do not triage this yourself, and do not reply to `agent.harbor` about it. The
triage belongs to `{{oncall}}`, who will report it when they have done it. If
you answer on their behalf you will be reporting work nobody did — and the
harness will now refuse a report that claims a task it cannot point at, so a
summary you write here will bounce back to you rather than quietly becoming the
company's record.
