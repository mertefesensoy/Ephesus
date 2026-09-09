# The ledger's first refusal teaches, and the prompt shows the shape

**Date:** 2026-09-09 · **Milestone:** M8b.5 · **Branch:**
`fix/m8b-5-ledger-refusal-teaches` from `origin/main` `268152b`

---

## 1. Problem / motivation

Finding 6 of [the M8 exit run](../demo/m8-onehour-aftershock.md), **as corrected in
§4a of that record**. Every incident's first task-open was refused:

```json
{"kind":"task","event":"refused","by":"agent.artemis",
 "reasons":["ops: Invalid input: expected array, received undefined"],"seq":90}
```

…and the orchestrator then retried successfully. **Eight refusals, eight recoveries.**
The path is lossy and noisy, not broken — and what matters is the message: a raw
validator error naming a field and nothing else, *"whose failure to teach is proved by
its recurring eight identical times instead of being corrected after the first."*

**The cause, which the finding does not name.** Nothing states the proposal's shape.
`prompts/agora/PROTOCOL.md` does not carry it. `prompts/harbor/incident-body.md` said
only:

> Send a `propose` message to `agent.ledger` with the task you want opened; the
> endpoint answers you with the task id it created, or with every reason it refused.

So Artemis had to **guess the envelope**, guessed wrong, and the refusal was her only
teacher — a refusal that named a field and stopped. Compare `memo-required.md`, which
has shown its full JSON body all along.

**And the refusal was worse than it needed to be even on its own terms.**
`parseProposal` returned `issues[0]` and stopped, while `applyProposal` — twenty lines
below it in the same file — collects every reason on principle, and says why in its own
contract: *"these three things are wrong" beats "the first one was wrong, and the rest
may or may not have happened."* The parse half did not obey its own module's rule.

---

## 2. What changed

| File | What |
|---|---|
| `src/shared/ledger.ts` | `ProposalParse` carries `reasons` (plural). New `proposalPath` and `proposalReasons` — every issue, deduplicated, capped, with a sentence for the two shapes agents actually get wrong. |
| `src/main/ledger.ts` | Passes them straight to `refuse`, which already took an array. |
| `prompts/harbor/incident-body.md` | Shows the exact JSON body, as `memo-required.md` does. |
| `prompts/hermes/ledger-refuse.md` | Says the list is complete and the work is still the agent's to re-send. |
| `test/shared/ledger-endpoint.test.ts` | 11 new cases, incl. running the **real parser** over the shape the **shipped prompt** shows. |

---

## 3. Implementation approach

Both halves, per the Architect's decision of 2026-09-09 — they are not alternatives
once the cause is visible.

### The payload: the prompt shows the shape

`incident-body.md` now carries the JSON, `{{oncall}}` filled by the harness. The first
attempt is well-formed, so the refusal does not fire at all.

A prompt that shows a shape is worth nothing if the shape is wrong, and a fixture copy
of it would drift from the file agents are actually given. So the test **reads the
shipped prompt**, pulls its `json` block out, fills the one placeholder, and runs the
**real `parseProposal`** over it. If the documented shape ever stops parsing, that test
fails rather than an agent discovering it at runtime.

### The message: it teaches, for everyone who comes after

`proposalReasons` reports **every** issue, not the first. Paths render as
`ops[0].task.spec` rather than the validator's `ops.0.task.spec` — the first is a place
in the document the agent wrote. That index is also as close as this layer gets to
naming the **offending task**, which the acceptance asks for: the task has no id yet,
because the ledger mints it, so its position in the batch is the only handle both sides
share.

Two issue shapes carry a bespoke sentence, and both were observed: the missing envelope
(`ops`) and the version literal. Everything else keeps the validator's own words —
inventing prose for an issue nobody has met is how a message becomes confidently wrong
about a case it was never tested on. The machine reason is kept **alongside** the
sentence rather than replaced by it, so nothing is hidden from a reader of `log.jsonl`.

Reasons are **data**, serialised into `prompts/hermes/ledger-refuse.md` (invariant §8);
this package supplies facts, and the sentence around them is a prompt.

---

## 4. Mathematical / statistical details

No formula or numeric algorithm. One bound is worth stating because it is a deliberate
trade rather than an implementation detail.

`MAX_REASONS = 12`, plus one line saying more may exist. A proposal may carry up to 64
ops (`ledgerProposalSchema`), and a malformed one can raise several issues per op —
so an uncapped list can reach the hundreds. A refusal nobody reads to the end teaches
as little as one that says nothing, and an agent's context is finite.

The cap therefore reports **the first 12 in document order** and says so explicitly.
Truncating silently would be the worse failure: it would look like a complete list and
lead an agent to fix twelve things and be refused a thirteenth time, which is the
recurrence this package exists to end.

---

## 5. Design decisions

**Both halves, not either.** The filed acceptance offers a choice — "either the first
attempt carries `ops` … or the refusal names the expected shape". Fixing only the
payload leaves the guard unlearnable for the next caller (a different profile, a
hand-written proposal, a future prompt). Fixing only the message leaves the eight round
trips in place on the next run. *(Architect decision, 2026-09-09.)*

**Keep the validator's words.** The bespoke sentence adds to the machine reason rather
than replacing it. An agent that had learned to match the old text is not stranded, and
a reader of the book of record can still see what the schema actually said.

**Prose stays in `prompts/`.** The refusal *reasons* are validator output — the same
class as `applyProposal`'s `task ${id} already exists`, which have been string literals
since M4. The sentence wrapped around them is a prompt file, which is where invariant
§8 puts it.

**The honest limit.** `PromptStore` seeds a home's copy once and never re-seeds, so an
Ephesus that has already run keeps the old `incident-body.md` and the old wrapper. The
payload half reaches a **fresh** home — which is what an exit run uses. The message half
is code and reaches **every** home. That split is deliberate, and it is why doing only
the payload would have been the weaker choice.

---

## 6. Verification

### Definition of Done

```bash
npm run typecheck && npm run lint && node scripts/check-invariants.cjs && npm run test:coverage && node scripts/check-coverage.cjs
```

### Mutation — 8 of 8 real mutants killed, baseline green, control survived

| Mutant | What it breaks | |
|---|---|---|
| R1 | back to reporting only the FIRST issue — the 2026-09-09 behaviour | killed |
| R2 | the `ops` refusal goes back to a bare validator message | killed |
| R3 | the validator's own words are dropped from the refusal | killed |
| R4 | paths revert to the validator's internal `ops.0` shape | killed |
| R5 | a broken proposal answers with an uncapped wall of reasons | killed |
| R6 | the version refusal stops naming the literal it wants | killed |
| R7 | the **shipped prompt** shows a shape the ledger refuses | killed |
| R8 | the shipped prompt shows the wrong envelope field | killed |
| **R9** | **CONTROL — changes nothing** | **SURVIVED, as it must** |

R7 and R8 are the ones worth pointing at: they break a **prompt**, not code, and they
die because the test runs the real parser over the real file.

### Adversarial refutation

- **Do the better reasons actually reach the agent?** Yes. `LedgerEndpoint.refuse`
  passes them to Hermes, which renders them into `prompts/hermes/ledger-refuse.md` as a
  bulleted list and delivers it to the sender's mailbox. Verified by reading the path,
  not assumed.
- **Does the wrapper dilute them?** It used to end at *"The proposal was not applied.
  Nothing changed."* — true, and it leaves an agent to infer whether the request is dead
  or still owed. The Odeon's refusals have said the opposite for a while (*"The question
  is still open and it is still yours"*). The ledger wrapper now says the same, and
  three tests hold it there.
- **Is the shown shape actually valid?** The test parses it with the production parser.
  It was not obvious: `task` requires `title`, `spec` **and** `assignee`, and a shape
  missing `assignee` would parse-fail — or worse, open a task nobody owns, which is a
  quieter version of the same failure. There is a test for that too.

### What this does NOT prove

That the run's eight refusals stop. That is a live claim about a fresh home with a real
crew, and it belongs to the rehearsal. What is proved: the shape the prompt shows
parses, the refusal names what `ops` is for and shows the body to send, every reason
arrives at once, and none of it is silently truncated.

---

## 7. Related docs

- [The M8 exit run](../demo/m8-onehour-aftershock.md) — Finding 6 and its §4a correction.
- [`docs/IMPLEMENTATION.md`](../IMPLEMENTATION.md) — M8b.5's acceptance criteria.
- [ADR-0004](../adr/ADR-0004-agora-single-committer.md) — one scribe for the ledger, which is why a proposal exists at all.
- [`docs/ENGINEERING-STANDARDS.md`](../ENGINEERING-STANDARDS.md) §8 — prompt text is config.
