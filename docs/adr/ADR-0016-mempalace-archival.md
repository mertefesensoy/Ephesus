# ADR-0016 — MemPalace as the Library's recall index and the company archive

**Status:** accepted · **Date:** 2026-08-26 (Architect directive at M0 close)
**Supersedes:** the layer-2 *implementation choice* of [ADR-0006](./ADR-0006-library-memory.md)
(bespoke local embedding index). ADR-0006's layered model, markdown ground truth,
reflection job, and degradation ladder remain in force unchanged.

## Context

ADR-0006 deliberately left layer 2 (semantic recall) as "a seam a future ADR could
re-point" and rejected memory *platforms* that want to own the agent runtime. The
Architect has directed adoption of [MemPalace](https://github.com/mempalace/mempalace)
as the company's archival system. MemPalace is not a runtime-owning platform: it is a
local-first, MIT-licensed memory store (Python 3.9+) that keeps original content
**verbatim** in a wings → rooms → drawers hierarchy, retrieves via scoped semantic
search with zero API calls (96.6% R@5 raw on LongMemEval per its README), maintains a
SQLite-backed temporal entity-relationship graph, and integrates as a CLI, a Python
library, and an MCP server — including auto-save hooks for Claude Code, our reference
engine. It is also the direct descendant of the "MemPalace CLI" already cited in
ADR-0006's prior art (Munder Difflin HIVE.md Phase 3).

## Decision

1. **MemPalace becomes Library layer 2 and the company archive.** `library.ts` drives
   a local MemPalace instance instead of a bespoke embedding index. The `~/.ephesus/
   index/` directory becomes the MemPalace store root (still derived state, still
   excluded from the Agora repo, still disposable/rebuildable from markdown).
2. **Structure mapping (normative).** One **wing** per agent (its memory + diary) and
   one wing per target/project; **rooms** organize topics within a wing; **drawers**
   hold verbatim records. The knowledge shelf, Odeon artifacts, retro reports, and
   Gymnasium ledger entries are *archived into* MemPalace by reference and content —
   the Agora files remain the source of truth; MemPalace is the queryable archive,
   never a second authority.
3. **Layer 1 is untouched.** Per-agent `identity.md`/`memory.md` markdown remains the
   ground truth agents read and write (ADR-0006 layer 1). MemPalace mines these files
   (mtime-gated, as before); reflection (layer 3) still condenses markdown, and
   MemPalace archives what reflection condenses.
4. **Integration seam.** Main-process `library.ts` talks to MemPalace via its CLI
   and/or MCP server as a spawned local subprocess — the same subprocess discipline as
   engine CLIs (ADR-0009): version probe, visible install offer, no hidden daemons.
   Agents reach recall through the same `eph recall <query>` surface as before, now
   backed by MemPalace scoped search.
5. **Degradation ladder is preserved and visible.** Python or MemPalace absent /
   broken index → SQLite FTS keyword search → plain grep, each state surfaced in the
   Memory panel (FR-6, BUILD-PROMPT §3.7). The transparency floor stands: "what does
   the company know?" stays answerable by grep.
6. **Runtime dependency declared.** This ADR is the decision memo for the new
   external dependency class: a local Python 3.9+ runtime with the `mempalace`
   package (MIT). It is an *optional* dependency — Ephesus at every milestone must run
   (degraded) without it.

## Options considered

- **Keep the bespoke embedding index (ADR-0006 as written).** Full control, no Python
  dependency — but re-implements retrieval, scoping, temporal knowledge-graphing, and
  engine auto-save hooks that MemPalace already provides with published benchmarks.
- **Vector DB service (Chroma/Qdrant directly).** Rejected for the same reasons as in
  ADR-0006 — a daemon and a schema without the palace semantics; MemPalace already
  fronts pluggable backends (ChromaDB default, SQLite among the alternatives) behind
  one interface.
- **MemPalace as MCP-only for engines, bypassing the harness.** Rejected: recall and
  archive must serve the *harness* (briefing compiler, Memory panel, metrics), not
  only whichever engine speaks MCP; and the Library owns the degradation ladder.

## Consequences

- M4 (the Library milestone) implements the MemPalace driver in place of the bespoke
  index; the recall smoke test with known-answer queries (TEST-STRATEGY) now exercises
  MemPalace, and the conformance/degradation tests must cover the no-Python path.
- The install story grows a step: MemPalace setup runs visibly (same FR-1.6 posture as
  missing engine binaries), and its ~300 MB embedding-model footprint lives outside
  the Agora repo.
- Agent-facing recall gains scoped search (wing/room) and the temporal knowledge
  graph — the briefing compiler and Memory panel may consume both, but every claim
  they surface still needs Agora-side source refs (ADR-0008 discipline).
- MemPalace's own auto-save hooks for Claude Code overlap our hook plane; only the
  Library integration is authoritative — engine-side MemPalace hooks stay OFF unless
  a future ADR enables them, so the archive has one writer path.

## Prior art

Munder Difflin HIVE.md §2.4 & Phase 3 (markdown-first + MemPalace CLI +
detect-and-degrade — the lineage ADR-0006 already cited); MemPalace README
(wings/rooms/drawers, LongMemEval results, MCP surface).
