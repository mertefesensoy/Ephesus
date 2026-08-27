import fs from 'node:fs'
import path from 'node:path'
import { defaultConfig, parseConfig, type EphConfig } from '../shared/config'
import { writeFileAtomic } from './fsx'

/**
 * The harness home (SDD §2): `~/.ephesus/`. M0.5 creates the top-level
 * directories plus `config.json`; deeper structure (agora repo contents,
 * odeon/, agents/) arrives with the milestones that own it.
 */
export const HOME_DIRS = ['prompts', 'profiles', 'agora', 'index', 'worktrees'] as const

export interface HarnessHome {
  readonly root: string
  readonly configPath: string
  readonly dbPath: string
  readonly config: EphConfig
  /**
   * Non-null when config.json existed but failed validation. The file is left
   * untouched (never silently overwritten) and the app runs on the default
   * config with this warning surfaced in the UI (BUILD-PROMPT §3.7).
   */
  readonly configWarning: string | null
}

/** Creates the harness home if missing (idempotent) and loads the config. */
export function ensureHarnessHome(root: string): HarnessHome {
  fs.mkdirSync(root, { recursive: true })
  for (const dir of HOME_DIRS) fs.mkdirSync(path.join(root, dir), { recursive: true })

  const configPath = path.join(root, 'config.json')
  let config = defaultConfig
  let configWarning: string | null = null

  if (fs.existsSync(configPath)) {
    try {
      config = parseConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')))
    } catch (err) {
      configWarning = `config.json invalid, running on defaults (file left untouched): ${
        err instanceof Error ? err.message.split('\n')[0] : String(err)
      }`
    }
  } else {
    writeFileAtomic(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`)
  }

  return { root, configPath, dbPath: path.join(root, 'db.sqlite'), config, configWarning }
}
