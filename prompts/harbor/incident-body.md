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
runbook `{{playbook}}`. Please open a task for them describing what needs
triaging, and assign it.

When `{{oncall}}` has triaged, they reply to `agent.harbor` with the subject
`{{triageSubject}}` and a JSON body:

    {
      "schemaVersion": 1,
      "kind": "triage",
      "incident": "{{repo}}#ci-run:{{ref}}",
      "severity": 1,
      "resolved": false,
      "summary": "one line: what broke, and what was done about it"
    }

`severity` is 1 when this needs the Architect's attention immediately, and 2
when it can ride the next standup. `resolved` is true only if the runbook fix
actually worked.
