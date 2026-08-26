# ADR-0003 — Hermes: file-based mailboxes with speech-act messages

**Status:** accepted · **Date:** 2026-08-26

## Context
Agents must ask each other for things, hand off work, and escalate — asynchronously,
auditable, without a broker daemon, and safely with N concurrent writers. Agents are
LLM CLIs: the transport must be something they can use with plain file writes.

## Decision
A file-based mailbox system routed by the main process:

- Each agent owns `agora/agents/<id>/outbox/` and `inbox/`. **Single-writer-per-file:**
  an agent writes only inside its own directory; no file is ever written by two
  processes.
- The **router** (main process) watches outboxes and delivers each message file into the
  recipient's inbox via temp-file + atomic `rename`, appends to `log.jsonl`, and hands
  the batch to the Agora committer (ADR-0004).
- Messages are single JSON files with a **FIPA-lite speech-act schema**:
  `act ∈ {request, inform, propose, query, agree, refuse, done}` plus
  `id` (time-sortable), `conversation`, `in_reply_to`, `hops`, `requires_reply`,
  `needs_human`.
- **Anti-livelock rules are transport rules, not etiquette:** only
  `request|query|propose` obligate a reply; every reply increments `hops`; at the hop
  cap the router diverts the message to Artemis instead of delivering; a re-seen `id`
  is a no-op (per-agent cursor); processed mail moves to `inbox/.done/`.
- Special addresses: `broadcast` (fan-out by the router) and `human` (delivered to
  Artemis as the Architect's proxy). Mail to a missing inbox bounces as a `refuse` and
  is logged — never silently dropped.

## Options considered
- **A real broker (Redis/NATS/SQLite queue).** Faster and transactional, but invisible:
  the Architect can't `cat` a message, git can't audit it, and a daemon becomes a
  lifecycle liability. File semantics are the product's transparency guarantee.
- **Direct agent-to-agent PTY injection.** Chaos: no audit, no queueing, collides with
  the human typing (the message-queue rule exists precisely to serialize this).
- **Full FIPA-ACL.** The speech act is the one idea worth keeping; the rest is ceremony.

## Consequences
- At-least-once delivery with idempotent consumption (NFR-6); throughput is bounded by
  fs-watch latency — fine at ≤ 500 ms p95 (NFR-2), wrong tool for high-frequency
  streaming (which agents don't need).
- The router is a single point of mediation — which is the point: hop caps, bounces,
  escalation, and the event log all live in one place.

## Prior art
Munder Difflin HIVE.md §3–5 (mailboxes, router, anti-livelock); Hearsay-II blackboard;
actor-model mailboxes; FIPA-ACL/KQML speech acts.
