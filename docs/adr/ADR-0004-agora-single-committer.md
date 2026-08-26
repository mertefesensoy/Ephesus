# ADR-0004 — The Agora: git as coordination layer, single committer

**Status:** accepted · **Date:** 2026-08-26

## Context
Company state — roster, blackboard, task ledger, event log, mailboxes, memory — needs
durability, history, and auditability. With up to 30 concurrent agent processes, any
shared mutable store invites corruption; concurrent `git` invocations specifically
corrupt `.git/index.lock`.

## Decision
The Agora is one local git repository under the harness home. **Only the Electron main
process ever runs git** — agents write plain files in their own directories and never
invoke git. The committer serializes commits through a queue with retry + exponential
backoff and stale-lock cleanup. `board.md` is the one genuinely co-edited file, so it
has a single scribe: Artemis (workers propose edits via Hermes; Artemis applies them).
`log.jsonl` is append-only; consumers keep their own cursors. History is never
rewritten (NFR-7).

## Options considered
- **SQLite for everything.** Transactional and fast, but opaque to agents (LLMs excel at
  reading/writing markdown and JSON files, not issuing SQL through a broker) and
  loses free git history/diff/blame. SQLite is still used for *app-local* state (window
  bounds, command history, cost ledger) where agents never look.
- **Per-agent repos.** Isolates writers but destroys the single audit trail and makes
  cross-agent queries (briefings!) a federation problem.
- **No VCS, just files + log.** Loses time-travel and tamper-evidence; the Odeon's
  "book of record" claim (NFR-13) leans on git history.

## Consequences
- Every state change the company makes is a commit by one identity, in order — the
  briefing compiler, the memo archive, and incident forensics all read one history.
- Commit throughput is a shared queue; batching (router hands the committer message
  *batches*) keeps it off the critical path of delivery latency.
- Harness crash mid-write is recoverable: uncommitted files are still on disk; the
  committer reconciles on startup (blackout test, SRS §6.6).

## Prior art
Munder Difflin HIVE.md §2.1–2.2; GitHub Desktop's commit-queue pattern; stigmergy
(coordination through a shared modified environment).
