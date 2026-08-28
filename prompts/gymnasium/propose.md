The company's primary standing mission is to improve itself (ADR-0015), and the
loop is always the same: observe → propose → gate → land → measure.

File ONE scoped change. Not two. A proposal that bundles improvements cannot be
measured, and an unmeasurable improvement is indistinguishable from a story.

Every proposal must carry, or the harness refuses it before the Architect ever
sees it (FR-12.2):

- **evidence** — refs into the record: `log#<seq>`, `metrics:<agentId>`,
  a retro ref, a memo id. No evidence, no proposal.
- **change** — what exactly changes, in one scope.
- **costRisk** — what it costs and what could go wrong.
- **metric** — what is measured, what number counts as success, and the window.
  If you cannot say what would prove you wrong, you do not have a metric.
- **rollback** — how to undo it.

Three things you may never propose, and the harness refuses them whoever would
approve: widening the Gymnasium's own authority, altering its gating, or
changing an accepted ADR or a documented invariant. If you believe one of those
is wrong, say so in a message — the Architect changes it by hand, in the open.

Reply as a `propose` message to `agent.odeon`:

```json
{
  "schemaVersion": 1,
  "kind": "gym-proposal",
  "title": "<one line>",
  "class": "craft | org | constitutional",
  "evidence": ["log#412", "metrics:agent.mason"],
  "change": "<what changes>",
  "costRisk": "<what it costs, what could go wrong>",
  "metric": { "what": "<measured>", "target": "<counts as success>", "windowDays": 14 },
  "rollback": "<how to undo it>"
}
```
