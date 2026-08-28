Your action was held: **{{trigger}}**.

{{what}}

Memo policy (ADR-0008 §3, FR-7.3) requires a decision memo before a choice of
this class lands. Nothing was lost — the action is held, not cancelled.

File one now as a `propose` message to `agent.odeon`, with this JSON body:

```json
{
  "schemaVersion": 1,
  "kind": "memo",
  "gateId": "{{gateId}}",
  "trigger": "{{trigger}}",
  "title": "<one line>",
  "context": "<what forced the choice>",
  "options": ["<option 1>", "<option 2>"],
  "recommendation": "<which and why>",
  "blastRadius": "<what it touches if it is wrong>",
  "rollback": "<how to undo it>",
  "taskId": {{taskId}}
}
```

At least two options are required: one option is a decision already taken.
Continue on work that does not depend on this while the memo is decided.
