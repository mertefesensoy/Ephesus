import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Agora } from '../../src/main/agora'
import { PromptStore } from '../../src/main/prompts'
import { REGISTRY_SCHEMA_VERSION, type RegistryEntry } from '../../src/shared/registry'
import { TASKS_SCHEMA_VERSION } from '../../src/shared/tasks'

/**
 * The `agora:` read surface (SDD §5) that the Activity tab and the roster read
 * through. What matters here is that the renderer can only ever be a projection
 * of these files: paging is a cursor over the log, and a corrupt file degrades
 * visibly instead of throwing a boot away.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const homes: string[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

async function rig(): Promise<Agora> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-agora-ipc-'))
  homes.push(home)
  const agora = new Agora({
    root: path.join(home, 'agora'),
    prompts: new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS),
    backoffMs: 1
  })
  await agora.ensureRepo()
  agoras.push(agora)
  return agora
}

const entry: RegistryEntry = {
  name: 'Mason',
  role: 'ci-babysitter',
  engine: 'claude',
  capabilities: ['ci'],
  seat: 'terrace',
  envGrants: [],
  profile: null,
  target: 'repo:myapp',
  status: 'idle',
  hookFidelity: 'native'
}

describe('agora reads (SDD §5)', () => {
  it('seeds an empty roster and ledger a boot can read', async () => {
    const agora = await rig()
    expect(agora.registry()).toEqual({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      orchestratorId: null,
      agents: {}
    })
    expect(agora.tasks()).toEqual({ schemaVersion: TASKS_SCHEMA_VERSION, tasks: [] })
  })

  it('round-trips a roster entry through the file', async () => {
    const agora = await rig()
    agora.writeRegistry({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      orchestratorId: null,
      agents: { 'agent.mason': entry }
    })
    expect(agora.registry().agents['agent.mason']).toEqual(entry)
  })

  it('degrades visibly on a corrupt roster, and never rewrites the file', async () => {
    const agora = await rig()
    const file = agora.pathOf('registry.json')
    fs.writeFileSync(file, '{ not json', 'utf8')

    expect(agora.registry().agents).toEqual({})
    expect(agora.fileWarnings().some((w) => w.file === 'registry.json')).toBe(true)
    // The Architect's file is exactly as they left it.
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json')
  })

  it('refuses to overwrite a corrupt roster — the evidence survives the next write', async () => {
    // Found by the M2 close-out audit: the first roster write after corruption
    // atomically replaced the corrupt file with the empty default, destroying
    // the on-disk evidence the degradation promised to keep.
    const agora = await rig()
    const file = agora.pathOf('registry.json')
    fs.writeFileSync(file, '{ not json', 'utf8')
    expect(agora.registry().agents).toEqual({})

    expect(() =>
      agora.writeRegistry({
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        orchestratorId: null,
        agents: { 'agent.mason': entry }
      })
    ).toThrow(/refusing to overwrite registry\.json/)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json')

    // A repaired file lifts the refusal on the next read.
    fs.writeFileSync(
      file,
      `${JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, orchestratorId: null, agents: {} })}\n`,
      'utf8'
    )
    expect(agora.registry().agents).toEqual({})
    agora.writeRegistry({
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      orchestratorId: null,
      agents: { 'agent.mason': entry }
    })
    expect(agora.registry().agents['agent.mason']).toEqual(entry)
  })

  it('degrades visibly on a ledger that fails validation', async () => {
    const agora = await rig()
    fs.writeFileSync(
      agora.pathOf('tasks.json'),
      JSON.stringify({ schemaVersion: 1, tasks: [{ id: 'nope' }] }),
      'utf8'
    )

    expect(agora.tasks().tasks).toEqual([])
    expect(agora.fileWarnings().some((w) => w.file === 'tasks.json')).toBe(true)
  })

  it('pages the log by cursor, which is all the Activity feed needs', async () => {
    const agora = await rig()
    for (let i = 0; i < 12; i += 1) agora.appendLog({ kind: 'hook', agentId: 'agent.a', i })

    const first = agora.readLog(0, 5)
    expect(first.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])

    const second = agora.readLog(first.at(-1)?.seq ?? 0, 5)
    expect(second.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10])

    const tail = agora.readLog(second.at(-1)?.seq ?? 0, 5)
    expect(tail.map((e) => e.seq)).toEqual([11, 12])
    expect(agora.readLog(12, 5)).toEqual([])
  })

  it('keeps every ref on the row, so the feed can point back at the log', async () => {
    const agora = await rig()
    agora.appendLog({
      kind: 'delivery',
      msgId: 'm-1',
      from: 'agent.a',
      to: 'agent.b',
      act: 'request'
    })
    expect(agora.readLog()[0]).toMatchObject({ msgId: 'm-1', from: 'agent.a', to: 'agent.b' })
  })
})
