import os from 'node:os'
import path from 'node:path'
import { ensureHarnessHome, type HarnessHome } from './home'

/**
 * Config access for the main process. `initHome()` runs once at app-ready,
 * creating `~/.ephesus/` (SDD §2) and loading config.json; everything after
 * reads the cached result. EPH_HOME overrides the root for tests/E2E only.
 */
let home: HarnessHome | null = null

export function initHome(): HarnessHome {
  home ??= ensureHarnessHome(process.env['EPH_HOME'] ?? path.join(os.homedir(), '.ephesus'))
  return home
}

export function getHome(): HarnessHome {
  if (!home) throw new Error('config: initHome() not called before use')
  return home
}
