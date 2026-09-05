import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JsonStateStore } from '../../src/main/state-store'
import { removeTempDir } from '../tmpdir'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir)
})

const schema = z
  .object({
    schemaVersion: z.literal(1),
    rows: z.array(z.object({ id: z.string().min(1), n: z.number().int() }).strict())
  })
  .strict()
type Record_ = z.infer<typeof schema>
const empty: Record_ = { schemaVersion: 1, rows: [] }

function file(name = 'state.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-state-store-'))
  dirs.push(dir)
  return path.join(dir, name)
}
function store(at: string) {
  return new JsonStateStore({ file: at, schema, empty })
}

describe('durable app-local state', () => {
  it('an absent file is empty and says it was not seeded', () => {
    const load = store(file()).load()
    expect(load).toEqual({ ok: true, value: empty, seeded: false })
  })

  it('a written record comes back identically, and says it WAS seeded', () => {
    const at = file()
    const value: Record_ = { schemaVersion: 1, rows: [{ id: 'a', n: 1 }] }
    expect(store(at).save(value)).toEqual({ ok: true })
    // A second store over the same path: this is the restart, not a cache hit.
    expect(store(at).load()).toEqual({ ok: true, value, seeded: true })
  })

  /**
   * The pair that must never collapse. "Absent" is an ordinary first run;
   * "damaged" means state exists that can no longer be read, and every M8.8
   * caller responds differently to the two.
   */
  it('damaged is NOT absent — it refuses rather than returning empty', () => {
    const at = file()
    fs.writeFileSync(at, '{ this is not json')
    const load = store(at).load()
    expect(load.ok).toBe(false)
    expect(load.ok === false && load.because).toContain('not JSON')
  })

  it('a record that parses as JSON but fails the schema refuses, naming the field', () => {
    const at = file()
    fs.writeFileSync(at, JSON.stringify({ schemaVersion: 1, rows: [{ id: 'a', n: 'two' }] }))
    const load = store(at).load()
    expect(load.ok).toBe(false)
    expect(load.ok === false && load.because).toContain('rows.0.n')
  })

  /**
   * The version literal lives in the schema, so an unsupported version fails as
   * a parse. Without this a future writer's record reads as this version's
   * shape and restores wrong state silently.
   */
  it('an unsupported schemaVersion refuses rather than being read as this one', () => {
    const at = file()
    fs.writeFileSync(at, JSON.stringify({ schemaVersion: 2, rows: [] }))
    expect(store(at).load().ok).toBe(false)
  })

  it('an unreadable file refuses instead of reading as absent', () => {
    const at = file()
    // A directory where the file should be: readFileSync fails with EISDIR, not
    // ENOENT, and the ENOENT branch is the one that means "empty".
    fs.mkdirSync(at)
    const load = store(at).load()
    expect(load.ok).toBe(false)
    expect(load.ok === false && load.because).not.toContain('ENOENT')
  })

  /**
   * A store that can write what it cannot load is a restart failure with a
   * one-boot delay: the damage is invisible until the next start.
   */
  it('refuses to write a record the next boot would refuse to read', () => {
    const at = file()
    const bad = { schemaVersion: 1, rows: [{ id: '', n: 1 }] } as Record_
    const saved = store(at).save(bad)
    expect(saved.ok).toBe(false)
    expect(fs.existsSync(at)).toBe(false)
  })

  it('save creates the directory it was pointed at', () => {
    const at = path.join(file(), 'nested', 'deeper', 'state.json')
    expect(store(at).save(empty)).toEqual({ ok: true })
    expect(store(at).load()).toEqual({ ok: true, value: empty, seeded: true })
  })

  it('a failed write reports rather than throwing', () => {
    // The file path is a directory, so the rename cannot land.
    const at = file()
    fs.mkdirSync(at)
    const saved = store(at).save(empty)
    expect(saved.ok).toBe(false)
  })

  it('leaves no temp file behind after a successful write', () => {
    const at = file()
    expect(store(at).save(empty).ok).toBe(true)
    expect(fs.readdirSync(path.dirname(at))).toEqual(['state.json'])
  })
})
