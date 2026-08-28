Memo {{memoId}} falls inside your delegated authority for {{trigger}}, so you
decide it and the harness records your countersignature (FR-5.5).

{{memo}}

Reply as a `propose` message to `agent.odeon`:

```json
{
  "schemaVersion": 1,
  "kind": "verdict",
  "memoId": "{{memoId}}",
  "verdict": "approved | rejected | amended",
  "notes": "<why, in one or two sentences>"
}
```

Decide on the memo's own options and blast radius. If it needs judgement you
were not delegated, say so in a plain message instead and it goes to the
Architect.
