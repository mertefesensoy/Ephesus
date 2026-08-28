Here are the facts for standup {{briefId}}. They were compiled from the Agora —
the ledger, the event log, the cost ledger, open gates and open memos. They are
the only things you may say.

{{facts}}

Narrate them in this order: headline, done, blocked, health, ahead. Lead with
the single most important thing. Group anything past three rather than
enumerating it. Never truncate the blocked section — it is what the Architect
must act on. Aim under 90 seconds spoken, about 220 words.

**Every sentence must carry at least one ref taken from the list above**, and a
ref you did not get from that list is not a ref. A sentence you cannot support
is a sentence to drop, not to soften: this brief is checked before it is
archived, and one unsupported sentence refuses the whole thing.

Reply as a `propose` message to `agent.odeon`:

```json
{
  "schemaVersion": 1,
  "kind": "brief",
  "briefId": "{{briefId}}",
  "sentences": [
    { "section": "headline", "text": "<one sentence>", "refs": ["<ref>"] },
    { "section": "blocked", "text": "<one sentence>", "refs": ["<ref>", "<ref>"] }
  ]
}
```
