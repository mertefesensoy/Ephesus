# ADR-0006 — The Library: markdown-first memory, optional semantic index

**Status:** accepted · **Date:** 2026-08-26

## Context
Agents must remember across sessions (their role, past decisions, project facts) and
recall relevant knowledge fast. Heavyweight memory platforms (Letta/Mem0/Zep) want to
own the agent runtime — but our runtime is the engine CLI (ADR-0009), and at 5–30
agents a vector database is architecturally premature.

## Decision
Three layers, each degrading gracefully to the one below (FR-6):

1. **Markdown ground truth.** Per-agent `identity.md` (who am I — written at hire,
   updated on role change) and `memory.md` (append-only learnings, dated sections).
   Agents read both at task start per the Agora protocol file. This layer alone is a
   fully working memory system.
2. **Recall index.** A local embedding index (CPU-friendly model by default) over all
   memory files plus the shared knowledge shelf (Architect-registered runbooks,
   policies, style guides). Exposed to agents as a CLI (`eph recall <query>`) and to the
   Architect as the Memory panel. Mtime-gated incremental mining; detect-and-degrade to
   SQLite FTS keyword search, then to plain grep, if the index or its model is absent.
3. **Reflection.** A scheduled condensation job summarizes each `memory.md` past a size
   threshold into a compact core + dated archive of what was condensed — memory is
   bounded, and nothing is destroyed (NFR-7).

Embeddings are pinned to CPU on macOS (upstream shipped a CoreML NaN-embedding bug on
Apple Silicon; we inherit the lesson, not the bug).

## Options considered
- **Vector DB service (Chroma/Qdrant) or memory platform (Letta/Mem0).** Another
  daemon, another schema, and a runtime-ownership fight; benchmarks in this product
  category are routinely overstated. Rejected for v1; the recall index is a seam a
  future ADR could re-point.
- **Engine-native memory only (e.g. CLAUDE.md).** Not portable across engines, not
  queryable across agents, and not owned by the Agora's audit trail.
- **SQL/structured memory.** LLMs write prose; forcing schema at write time loses
  information and adds failure modes. Structure is extracted at *read* time (topics,
  briefing facts), not imposed at write time.

## Consequences
- "What does the company know?" is answerable by grep — the transparency floor.
- Recall quality depends on the local embedding model; the conformance suite includes a
  retrieval smoke test with known-answer queries.
- Reflection prompts are part of the versioned config (they shape what the company
  forgets — that's policy, so it's text, per ADR-0005's principle).

## Prior art
Munder Difflin HIVE.md §2.4 & Phase 3 (markdown-first, MemPalace CLI, detect-and-degrade);
MemGPT/Letta self-managed memory; Stanford Generative Agents (memory stream + reflection).
