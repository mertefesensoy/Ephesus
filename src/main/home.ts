import fs from 'node:fs'
import path from 'node:path'
import { defaultConfig, parseConfig, type EphConfig } from '../shared/config'
import { shippedGatePolicy } from '../shared/gates'
import { shippedAuthority } from '../shared/authority'
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
  /**
   * Files this run created because they were absent (M8.4).
   *
   * Surfaced rather than done quietly: a config file that appears without
   * being mentioned is one the Architect never learns they can edit, and the
   * whole setup cliff is made of files the harness requires, creates itself
   * and never names.
   */
  readonly seeded: readonly string[]
}

/**
 * Files the harness cannot run correctly without, written on first boot from
 * values the schemas validate at module load — never from a JSON literal that
 * could drift from the schema it illustrates.
 *
 * Seeded only when ABSENT. `~/.ephesus/` is the Architect's copy: an existing
 * file is theirs, whatever it says, and overwriting one would be the harness
 * silently reverting a decision they made.
 */
const SEEDED_FILES = [
  { file: 'gate-policy.json', contents: (): unknown => shippedGatePolicy },
  { file: 'authority.json', contents: (): unknown => shippedAuthority }
] as const

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

  const seeded: string[] = []
  for (const { file, contents } of SEEDED_FILES) {
    const target = path.join(root, file)
    if (fs.existsSync(target)) continue
    writeFileAtomic(target, `${JSON.stringify(contents(), null, 2)}\n`)
    seeded.push(file)
  }

  return {
    root,
    configPath,
    dbPath: path.join(root, 'db.sqlite'),
    config,
    configWarning,
    seeded
  }
}
