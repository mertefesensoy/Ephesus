import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Agora, REGISTRY_REL } from '../../src/main/agora'
import { PromptStore } from '../../src/main/prompts'
import {
  emptyRegistry,
  parseRegistry,
  REGISTRY_SCHEMA_VERSION,
  registrySchema
} from '../../src/shared/registry'
import { HOOK_SUPPORTS, LEGACY_HOOK_SUPPORTS } from '../../src/shared/engines'
import { removeTempDir } from '../tmpdir'

/**
 * The hook-grade rename as a SCHEMA MIGRATION (M8.11, ADR-0024 §3).
 *
 * `pty-heuristic` -> `none` is not a find-and-replace. `hookFidelity` is
 * validated on every entry of `agora/registry.json`, which is a durable
 * schema'd file this build did not necessarily write, and `Agora.registry()`
 * falls back to an EMPTY roster when it cannot parse one — then refuses to
 * overwrite the file it could not read. So a rename that dropped the old
 * spelling without accepting it on read would cost the company every seat on
 * its roster at the first boot after an upgrade, and the only signal would be
 * one warning line.
 *
 * The machine this was written on happens to carry `{"native": 7}`, so nothing
 * would have broken here. That is luck, and luck is not what a durable file
 * gets tested against — these run against the real `Agora` and a real roster
 * file on disk carrying the retired string.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function rig(): { agora: Agora; root: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-engine-honesty-'))
  temps.push(home)
  const root = path.join(home, 'agora')
  fs.mkdirSync(root, { recursive: true })
  return {
    agora: new Agora({
      root,
      prompts: new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS),
      backoffMs: 1
    }),
    root
  }
}

/** A roster of one, with whatever grade the caller wants written into it. */
function rosterWith(hookFidelity: string): string {
  return JSON.stringify(
    {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      orchestratorId: 'agent.artemis',
      agents: {
        'agent.artemis': {
          name: 'Artemis',
          role: 'orchestrator',
          engine: 'claude',
          capabilities: ['orchestrate'],
          seat: 'temple',
          envGrants: [],
          profile: null,
          target: null,
          isOrchestrator: true,
          hookFidelity
        }
      }
    },
    null,
    2
  )
}

describe('the retired hook grade still reads (ADR-0024 §3 as a migration)', () => {
  it('parses a roster carrying `pty-heuristic`, as the grade it became', () => {
    const parsed = parseRegistry(JSON.parse(rosterWith('pty-heuristic')))

    if (!parsed.ok) throw new Error(`legacy roster refused: ${parsed.reason}`)
    expect(parsed.registry.agents['agent.artemis']?.hookFidelity).toBe('none')
  })

  it('keeps the company on a roster an older build wrote', () => {
    // The whole failure, end to end, through the real reader: an upgraded
    // build boots against a roster it did not write.
    const { agora, root } = rig()
    fs.writeFileSync(path.join(root, REGISTRY_REL), rosterWith('pty-heuristic'), 'utf8')

    const registry = agora.registry()

    expect(Object.keys(registry.agents)).toEqual(['agent.artemis'])
    expect(registry.orchestratorId).toBe('agent.artemis')
    expect(registry.agents['agent.artemis']?.hookFidelity).toBe('none')
    // Not merely "it parsed": a roster that failed would be reported here AND
    // would lock the file against every later write this run.
    expect(agora.fileWarnings()).toEqual([])
  })

  it('CATCHES the failure it exists to prevent — an unmigrated grade empties the roster', () => {
    // The probe rule: a migration test that cannot fail proves nothing. This
    // spells a grade no build ever wrote, so it takes the path the legacy
    // string WOULD have taken without `LEGACY_HOOK_SUPPORTS`, and shows what
    // that costs — an empty company and one warning line.
    const { agora, root } = rig()
    fs.writeFileSync(path.join(root, REGISTRY_REL), rosterWith('tty-guesswork'), 'utf8')

    const registry = agora.registry()

    expect(registry).toEqual(emptyRegistry)
    expect(agora.fileWarnings()).toHaveLength(1)
    expect(agora.fileWarnings()[0]?.file).toBe(REGISTRY_REL)
  })

  it.each([...HOOK_SUPPORTS])('still accepts the current grade %s unchanged', (grade) => {
    const parsed = parseRegistry(JSON.parse(rosterWith(grade)))

    if (!parsed.ok) throw new Error(`grade ${grade} refused: ${parsed.reason}`)
    expect(parsed.registry.agents['agent.artemis']?.hookFidelity).toBe(grade)
  })

  it('normalizes on the next WRITE, so the old spelling does not outlive the read', () => {
    // The migration is accept-on-read, not rewrite-in-place (invariant §5's
    // spirit: nothing rewrites a file behind the Architect's back). What makes
    // it terminate is that the value the roster is next written FROM is the
    // normalized one — so one ordinary roster write retires the string.
    const parsed = parseRegistry(JSON.parse(rosterWith('pty-heuristic')))
    if (!parsed.ok) throw new Error(parsed.reason)

    const rewritten = JSON.stringify(registrySchema.parse(parsed.registry))

    expect(rewritten).toContain('"hookFidelity":"none"')
    expect(rewritten).not.toContain('pty-heuristic')
  })

  it('maps every retired spelling to a grade that still exists', () => {
    // A legacy entry pointing at a grade the enum no longer has would be a
    // migration that swaps one parse failure for another.
    for (const became of Object.values(LEGACY_HOOK_SUPPORTS)) {
      expect(HOOK_SUPPORTS).toContain(became)
    }
  })
})
