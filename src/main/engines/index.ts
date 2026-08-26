import type { EngineId } from '../../shared/engines'
import type { EngineAdapter } from './types'

export type {
  AgentSpawnConfig,
  BinarySpec,
  CommandLine,
  EngineAdapter,
  HookPlan,
  KeySequence,
  ResumeSupport,
  SettingsInjection,
  SpawnPlan,
  TranscriptReader,
  UsageFact
} from './types'

/**
 * The engine adapter registry (SDD §1.1 `engines/`), keyed by `EngineId`.
 * Core subsystems resolve engines through here and touch nothing else in this
 * directory, which is what makes "adding an engine requires no changes outside
 * its adapter" measurable (NFR-12, ADR-0009).
 *
 * Contract: registration is explicit and single-shot per id — a duplicate id is
 * a programming error, not a silent overwrite, because a silently replaced
 * adapter would make the hook-fidelity grade on the agent card a lie.
 */
export class EngineRegistry {
  private readonly adapters = new Map<EngineId, EngineAdapter>()

  /** Throws if `adapter.id` is already registered. */
  register(adapter: EngineAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`engines: adapter already registered for engine id "${adapter.id}"`)
    }
    this.adapters.set(adapter.id, adapter)
  }

  has(id: EngineId): boolean {
    return this.adapters.has(id)
  }

  /**
   * Throws with the requested id and the registered set (errors carry refs,
   * ENGINEERING-STANDARDS §4). Use `has()` when absence is an expected state.
   */
  get(id: EngineId): EngineAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) {
      const known = [...this.adapters.keys()].join(', ') || '(none)'
      throw new Error(`engines: no adapter registered for engine id "${id}"; registered: ${known}`)
    }
    return adapter
  }

  /** Registration order; used by settings UI listings and the conformance suite. */
  list(): readonly EngineAdapter[] {
    return [...this.adapters.values()]
  }
}

/**
 * The process-wide registry. Adapters register into it at main startup — the
 * reference `claude` adapter lands in M1.4, further engines in M4 (ADR-0009:
 * Claude Code is the reference and the only adapter that may gate a release).
 */
export const engines = new EngineRegistry()
