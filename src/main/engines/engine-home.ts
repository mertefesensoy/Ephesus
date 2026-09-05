import path from 'node:path'

/**
 * Where an engine keeps its private per-agent state (SDD §2, ADR-0009).
 *
 * Until M8.7 an agent simply inherited the Architect's own engine install: the
 * same config directory, and therefore the same personal memory file, the same
 * plugins, the same skills, and — the part that matters — the same hooks. Six
 * Stop hooks fired per turn on the measured run, five of them the Architect's
 * own, any of which could continue an agent outside the harness's decision.
 * That block is uncounted by the block cap, invisible to the breaker's
 * stop-loop signal (ADR-0011) and unaffected by pacing (ADR-0023), which makes
 * ADR-0013's claim that the Stop hook is *the* autonomy hinge false in exactly
 * the way nothing would ever report.
 *
 * **One directory per agent, never shared.** The alternative — one directory
 * for the whole company — was rejected because the engine rewrites its config
 * file wholesale from an in-memory copy, and ADR-0021 already records that as a
 * known limitation of a single writer. A crew is precisely the concurrent case,
 * so sharing would move a known race to where agents actually run at the same
 * time. Per-agent also makes the transcript tree under `projects/` belong to
 * exactly one agent, which turns the usage fold (FR-11.2) from a
 * disambiguation-by-session-id into a directory listing, and makes
 * decommissioning an agent the removal of one directory.
 *
 * This module is engine-AGNOSTIC on purpose: it answers "where does engine E
 * keep agent A's private state", and nothing about what goes in there. The
 * shape of that state, the environment variables that point an engine at it and
 * the files that must be seeded into it are the adapter's, per ADR-0009 and
 * NFR-12 — adding an engine must not require an edit here.
 */

/** The harness-home subdirectory holding every engine's per-agent state. */
export const ENGINES_DIR = 'engines'

/**
 * Contract: the absolute directory engine `engineId` may use for agent
 * `agentId`, under `enginesRoot`. Pure. Throws when either id could escape the
 * root or collide with another agent's directory.
 *
 * **Refuses rather than sanitises.** Rewriting a bad id into a safe one is how
 * two agents quietly end up sharing a directory — the exact sharing this
 * function exists to prevent — and a company that silently pairs two agents on
 * one config file is worse than one that will not hire the second. The ids are
 * harness-generated today, so a throw here means a harness bug, which is what a
 * throw should mean.
 */
export function engineConfigDir(enginesRoot: string, engineId: string, agentId: string): string {
  return path.join(enginesRoot, segment(engineId, 'engine id'), segment(agentId, 'agent id'))
}

/**
 * Contract: true when `value` is safe as a single path segment. Pure.
 *
 * Deliberately an allowlist. A denylist of `..` and separators would still let
 * through a drive-relative `C:foo` on Windows, an empty string (which
 * `path.join` swallows, silently returning the PARENT directory — the shared
 * case again), and names that differ only by case on a case-insensitive volume.
 */
function segment(value: string, what: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes('..')) {
    throw new Error(`engine home: refusing ${what} ${JSON.stringify(value)} as a directory name`)
  }
  return value
}
