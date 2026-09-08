import os from 'node:os'
import path from 'node:path'
import { configSchema, type EphConfig } from '../shared/config'
import { writeFileAtomic } from './fsx'
import { ensureHarnessHome, type HarnessHome } from './home'

/**
 * Config access for the main process. `initHome()` runs once at app-ready,
 * creating `~/.ephesus/` (SDD §2) and loading config.json; everything after
 * reads the cached result. EPH_HOME overrides the root for tests/E2E only.
 */
let home: HarnessHome | null = null

/**
 * Contract: pure. Where the harness home lives for a given environment.
 *
 * One expression, exported, because `scripts/ephctl.cjs` has to resolve the
 * same home from outside the app and cannot import TypeScript. A CLI that
 * pointed at a different directory than the app would report "no harness is
 * running" against a harness that is (M8.14), so the two are pinned to each
 * other by `test/scripts/ephctl.test.ts` rather than by a comment.
 */
export function harnessHomeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['EPH_HOME']
  return override === undefined || override === '' ? path.join(os.homedir(), '.ephesus') : override
}

export function initHome(): HarnessHome {
  home ??= ensureHarnessHome(harnessHomeRoot())
  return home
}

export function getHome(): HarnessHome {
  if (!home) throw new Error('config: initHome() not called before use')
  return home
}

/**
 * Persists a config patch and refreshes the cached home.
 *
 * Contract: validates the MERGED config before writing, so a bad patch is
 * refused rather than persisted and discovered at the next boot. The write is
 * atomic (invariant §3) because `config.json` is a file another process may be
 * reading, and the cached copy is replaced only after the write succeeds — a
 * cache that ran ahead of the file would survive exactly until the next
 * restart, which is the worst possible moment to find out.
 */
export function saveConfig(patch: Partial<EphConfig>): EphConfig {
  const current = getHome()
  const next = configSchema.parse({ ...current.config, ...patch })
  writeFileAtomic(current.configPath, `${JSON.stringify(next, null, 2)}${'\n'}`)
  home = { ...current, config: next }
  return next
}
