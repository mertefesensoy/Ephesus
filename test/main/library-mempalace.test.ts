import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Library } from '../../src/main/library'
import { FtsIndex, MemoryFtsStore } from '../../src/main/library-fts'
import { MEMPALACE_INSTALL, MemPalaceIndex } from '../../src/main/library-mempalace'
import { PromptStore } from '../../src/main/prompts'

/**
 * The MemPalace driver (ADR-0016) against a **scripted fake `mempalace` CLI** —
 * a real spawned process speaking MemPalace 3.x's real command surface and
 * printing its real output shapes.
 *
 * ADR-0016 makes MemPalace an *optional* external, so CI must never grow a
 * Python: the fake is how the driver's behaviour is tested against a real
 * subprocess without one. The real binary's own behaviour is proven by live run
 * and recorded in `docs/PROGRESS.md`.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const FAKE_CLI = fileURLToPath(
  new URL('../fakes/fake-mempalace/fake-mempalace.mjs', import.meta.url)
)
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  delete process.env['EPH_FAKE_MP_MODE']
  delete process.env['EPH_FAKE_MP_LOG']
})

interface Rig {
  readonly library: Library
  readonly palace: MemPalaceIndex
  readonly agoraRoot: string
  readonly palaceRoot: string
  readonly home: string
  readonly invocations: () => readonly {
    argv: string[]
    autoSave: string | null
    daemon: string | null
  }[]
}

function rig(options: { mode?: string; withFts?: boolean } = {}): Rig {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-mempalace-'))
  temps.push(home)
  const agoraRoot = path.join(home, 'agora')
  const palaceRoot = path.join(home, 'index')
  const log = path.join(home, 'invocations.jsonl')
  if (options.mode) process.env['EPH_FAKE_MP_MODE'] = options.mode
  process.env['EPH_FAKE_MP_LOG'] = log

  const palace = new MemPalaceIndex({
    palaceRoot,
    agoraRoot,
    command: process.execPath,
    commandArgs: [FAKE_CLI]
  })
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))
  const library = new Library({
    agoraRoot,
    prompts,
    indexes: options.withFts ? [palace, new FtsIndex({ store: new MemoryFtsStore() })] : [palace]
  })
  library.note(
    'agent.mason',
    'agent.mason',
    'The checkout suite is flaky because the fixture seeds two carts.'
  )
  library.note('agent.iris', 'agent.iris', 'The deploy pipeline needs a staging smoke test.')
  fs.mkdirSync(path.join(agoraRoot, 'knowledge'), { recursive: true })
  fs.writeFileSync(
    path.join(agoraRoot, 'knowledge', 'release-runbook.md'),
    '# Release runbook\n\nTag, wait for CI, then promote staging to production.\n',
    'utf8'
  )

  return {
    library,
    palace,
    agoraRoot,
    palaceRoot,
    home,
    invocations: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map(
              (line) =>
                JSON.parse(line) as {
                  argv: string[]
                  autoSave: string | null
                  daemon: string | null
                }
            )
        : []
  }
}

describe('the version probe (ADR-0016 §4: engine-CLI discipline)', () => {
  it('is unavailable until it has been probed, and says so', () => {
    const { palace } = rig()
    expect(palace.available()).toBe(false)
    expect(palace.unavailableBecause()).toBe('not probed yet')
  })

  it('finds the version the CLI actually prints', async () => {
    const { palace } = rig()
    const probe = await palace.probe()
    expect(probe.version).toBe('3.8.0')
    expect(palace.available()).toBe(true)
    expect(palace.unavailableBecause()).toBe('available')
  })

  it('names the install command when the binary is not there (FR-1.6)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-mempalace-'))
    temps.push(home)
    const palace = new MemPalaceIndex({
      palaceRoot: path.join(home, 'index'),
      agoraRoot: path.join(home, 'agora'),
      command: path.join(home, 'no-such-mempalace')
    })
    const probe = await palace.probe()
    expect(probe.version).toBeNull()
    expect(probe.because).toContain(MEMPALACE_INSTALL.join(' '))
    expect(palace.available()).toBe(false)
  })

  it('treats an unrecognizable version line as unavailable, not as a guess', async () => {
    const { palace } = rig({ mode: 'no-version' })
    expect((await palace.probe()).version).toBeNull()
    expect(palace.unavailableBecause()).toContain('no version in its output')
  })
})

describe('mining (ADR-0016 §2 wings, ADR-0006 mtime gate)', () => {
  it('files one wing per agent and one for the shelf', async () => {
    const r = rig()
    await r.palace.probe()
    const report = (await r.library.reindex()).get('mempalace')
    expect(report).toEqual({ mined: 3, skipped: 0, removed: 0 })

    const wings = r
      .invocations()
      .filter((call) => call.argv.includes('mine'))
      .map((call) => call.argv[call.argv.indexOf('--wing') + 1])
    expect(wings).toEqual(['agent.iris', 'agent.mason', 'knowledge'])
  })

  it('does not spawn a miner for a wing whose files are unchanged', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()
    const after = r.invocations().length

    expect((await r.library.reindex()).get('mempalace')).toEqual({
      mined: 0,
      skipped: 3,
      removed: 0
    })
    expect(r.invocations().length).toBe(after)
  })

  it('re-mines only the wing that changed', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()
    r.library.note('agent.iris', 'agent.iris', 'The smoke test now seeds its own database.')

    expect((await r.library.reindex()).get('mempalace')).toEqual({
      mined: 1,
      skipped: 2,
      removed: 0
    })
    const mines = r.invocations().filter((call) => call.argv.includes('mine'))
    expect(mines.at(-1)?.argv[mines.at(-1)!.argv.indexOf('--wing') + 1]).toBe('agent.iris')
  })

  it('prunes when a source file leaves the corpus', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()
    fs.rmSync(path.join(r.agoraRoot, 'knowledge', 'release-runbook.md'))

    expect((await r.library.reindex()).get('mempalace')).toEqual({
      mined: 0,
      skipped: 2,
      removed: 1
    })
    expect(r.invocations().some((call) => call.argv.includes('sync'))).toBe(true)
  })

  it('reports a failed mine and keeps the company running', async () => {
    const r = rig({ mode: 'crash' })
    // A crashing CLI still answers the probe from the same mode, so drive the
    // available() path directly: probe against a working fake, then break it.
    const degraded: string[] = []
    const palace = new MemPalaceIndex({
      palaceRoot: r.palaceRoot,
      agoraRoot: r.agoraRoot,
      command: process.execPath,
      commandArgs: [FAKE_CLI],
      onDegraded: (detail) => degraded.push(detail)
    })
    delete process.env['EPH_FAKE_MP_MODE']
    await palace.probe()
    process.env['EPH_FAKE_MP_MODE'] = 'crash'

    const report = await palace.sync(r.library.corpus())
    expect(report.mined).toBe(0)
    expect(degraded.join(' ')).toContain('mining wing')
  })
})

describe('no hidden daemons, one writer path (ADR-0016 §4 and its consequence)', () => {
  it('never passes a daemon flag', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()
    await r.library.recall('flaky checkout')

    const flags = r.invocations().flatMap((call) => call.argv)
    expect(flags).not.toContain('--daemon')
    expect(flags).not.toContain('--background')
    expect(flags).not.toContain('daemon')
  })

  it('turns the engine-side auto-save hooks off on every invocation', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()
    await r.library.recall('flaky')

    const calls = r.invocations()
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((call) => call.autoSave === '0')).toBe(true)
    expect(calls.every((call) => call.daemon === '0')).toBe(true)
  })

  it('never installs the engine-side hook', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()
    expect(r.invocations().some((call) => call.argv.includes('hook'))).toBe(false)
  })

  it('keeps the palace out of the Agora — nothing to commit', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()

    expect(path.relative(r.agoraRoot, r.palaceRoot).startsWith('..')).toBe(true)
    expect(fs.existsSync(path.join(r.palaceRoot, 'drawers.json'))).toBe(true)
    // Nothing under the Agora names the palace.
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    expect(walk(r.agoraRoot).some((file) => file.includes('drawers.json'))).toBe(false)
  })
})

describe('scoped recall on the top rung', () => {
  it('answers, and the ladder reports no degradation', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()

    const answer = await r.library.recall('flaky checkout fixture')
    expect(answer.rung).toBe('mempalace')
    expect(answer.degraded).toBeNull()
    expect(answer.hits[0]?.scope).toBe('agent.mason')
    expect(answer.hits[0]?.snippet).toContain('two carts')
    // The ref is a path the Architect can open, not the bare basename
    // MemPalace prints.
    expect(answer.hits[0]?.ref).toContain(path.join('agents', 'agent.mason'))
  })

  it('pushes a wing scope down into MemPalace itself', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()

    const answer = await r.library.recall('staging', 'agent.iris')
    expect(answer.rung).toBe('mempalace')
    expect(answer.hits.every((hit) => hit.scope === 'agent.iris')).toBe(true)
    const search = r
      .invocations()
      .filter((call) => call.argv.includes('search'))
      .at(-1)
    expect(search?.argv).toContain('--wing')
    expect(search?.argv[search.argv.indexOf('--wing') + 1]).toBe('agent.iris')
  })

  it('filters a corpus-level scope on the way out, since it spans wings', async () => {
    const r = rig()
    await r.palace.probe()
    await r.library.reindex()

    const answer = await r.library.recall('staging promote', 'knowledge')
    expect(answer.hits.length).toBeGreaterThan(0)
    expect(answer.hits.every((hit) => hit.source === 'knowledge')).toBe(true)
  })
})

describe('degradation is visible at every failure (invariant §7, ADR-0016 §5)', () => {
  it('steps down to grep when MemPalace is not installed', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-mempalace-'))
    temps.push(home)
    const agoraRoot = path.join(home, 'agora')
    const palace = new MemPalaceIndex({
      palaceRoot: path.join(home, 'index'),
      agoraRoot,
      command: path.join(home, 'no-such-mempalace')
    })
    await palace.probe()
    const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))
    const library = new Library({ agoraRoot, prompts, indexes: [palace] })
    library.note('agent.mason', 'agent.mason', 'The checkout suite is flaky.')

    const answer = await library.recall('flaky checkout')
    expect(answer.rung).toBe('grep')
    expect(answer.degraded).toContain('mempalace:')
    expect(answer.degraded).toContain(MEMPALACE_INSTALL.join(' '))
    // Still answers — the transparency floor holds without MemPalace.
    expect(answer.hits[0]?.snippet).toContain('flaky')
  })

  it('steps down to FTS when MemPalace is installed but its search fails', async () => {
    const r = rig({ withFts: true })
    await r.palace.probe()
    await r.library.reindex()
    process.env['EPH_FAKE_MP_MODE'] = 'crash'

    const answer = await r.library.recall('flaky checkout')
    expect(answer.rung).toBe('fts')
    expect(answer.degraded).toBe('mempalace: search failed')
    expect(answer.hits.length).toBeGreaterThan(0)
  })

  it('refuses to read a drifted output shape rather than answering "nothing known"', async () => {
    const r = rig({ withFts: true })
    await r.palace.probe()
    await r.library.reindex()
    process.env['EPH_FAKE_MP_MODE'] = 'garbage'

    const answer = await r.library.recall('flaky checkout')
    expect(answer.rung).toBe('fts')
    expect(answer.degraded).toBe('mempalace: search failed')
    expect(answer.hits.length).toBeGreaterThan(0)
  })

  it('tells "MemPalace found nothing" apart from "MemPalace could not answer"', async () => {
    const r = rig({ withFts: true })
    await r.palace.probe()
    await r.library.reindex()

    const answer = await r.library.recall('kubernetes helm chart')
    // It answered; it just knows nothing about this. The rung stays at the top.
    expect(answer.rung).toBe('mempalace')
    expect(answer.hits).toEqual([])
    expect(answer.degraded).toBeNull()
  })
})
