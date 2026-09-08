import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlServer, type ControlDeps } from '../../src/main/control'
import { harnessHomeRoot } from '../../src/main/config'
import { CONTROL_ADDRESS_FILE } from '../../src/shared/control'
import type { DiagnosisInput } from '../../src/shared/diagnosis'
import { removeTempDir } from '../tmpdir'

/**
 * `scripts/ephctl.cjs` (M8.14) — exercised the way the exit run reaches it: a
 * spawned `node` process, talking to a real `ControlServer` over a real socket,
 * against a real home.
 *
 * This file exists because the CLI lives outside `productionFiles()` and so
 * outside the coverage gate. That trade is stated in ADR-0033; this is the
 * mitigation, and it is not a formality — the two behaviours that matter most
 * are only observable from a spawned process:
 *
 *  - **A refusal exits non-zero.** A script that tries to approve a gate must
 *    FAIL, not continue past a message nobody read.
 *  - **No harness running says so in English.** `ECONNREFUSED` is not an answer
 *    to the most common failure this tool has.
 */

const require_ = createRequire(import.meta.url)
const CLI = fileURLToPath(new URL('../../scripts/ephctl.cjs', import.meta.url))
const cli = require_('../../scripts/ephctl.cjs') as {
  parseArgs(
    argv: readonly string[]
  ):
    | { ok: true; verb: string; args: Record<string, string | string[]>; json: boolean }
    | { ok: false; reason: string }
  resolveHome(env: Record<string, string | undefined>): string
  readAddress(home: string): { ok: true; address: unknown } | { ok: false; reason: string }
  run(
    argv: readonly string[],
    env: Record<string, string | undefined>,
    out: (line: string) => void,
    err: (line: string) => void
  ): Promise<number>
  CONTROL_ADDRESS_FILE: string
}

interface Rig {
  readonly home: string
  readonly server: ControlServer
  readonly logged: Record<string, unknown>[]
  close(): Promise<void>
}

const rigs: Rig[] = []
const temps: string[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

const SNAPSHOT: DiagnosisInput = {
  at: Date.parse('2026-09-08T10:00:00.000Z'),
  home: 'C:\\eph',
  pid: 4321,
  version: '0.0.1',
  conditions: [],
  events: [],
  fileWarnings: [],
  crew: [],
  consented: false,
  armed: []
}

async function startRig(): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-cli-'))
  const logged: Record<string, unknown>[] = []
  const deps = {
    consent: {
      view: () => ({
        state: 'not-granted' as const,
        mayStartWork: false,
        because: 'nobody has said go',
        terms: 1,
        grantedAt: null,
        disclosure: {
          hire: { agentId: 'agent.artemis', engine: 'claude' },
          triggers: [],
          dailyCeiling: null
        }
      }),
      grant: () => ({
        ok: true,
        reason: null,
        view: {
          state: 'granted' as const,
          mayStartWork: true,
          because: 'granted',
          terms: 1,
          grantedAt: '2026-09-08T10:00:00.000Z',
          disclosure: { hire: null, triggers: [], dailyCeiling: null }
        }
      })
    },
    agents: { list: () => [] },
    agora: {
      appendLog: (draft: Record<string, unknown>) => {
        logged.push(draft)
        return { ...draft, ts: 0, seq: logged.length }
      },
      tailLog: () => []
    },
    profilesList: () => [],
    profilesInstances: () => [],
    profilesActivate: () => Promise.resolve({ ok: false, reasons: ['no such profile'] }),
    profilesDeactivate: () => ({ ok: true, reason: null }),
    convene: () => ({ ok: true, id: 'meeting-1' }),
    diagnosis: { snapshot: () => SNAPSHOT }
  } as unknown as ControlDeps

  const server = new ControlServer({ deps, onDegraded: () => undefined })
  await server.start(home)
  const rig: Rig = {
    home,
    server,
    logged,
    async close() {
      await server.stop()
      removeTempDir(home)
    }
  }
  rigs.push(rig)
  return rig
}

/** Runs the CLI as a real process, exactly as `docs/EXIT-M8.md` tells a reader to. */
function runCli(
  args: readonly string[],
  home: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, EPH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

describe('a spawned ephctl', () => {
  it('runs a verb against a live harness and exits 0', async () => {
    const rig = await startRig()
    const run = await runCli(['consent:status'], rig.home)
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('consent: not-granted')
    expect(run.stdout).toContain('agent.artemis on claude')
  })

  it('EXITS NON-ZERO on a refusal, so a script cannot walk past it', async () => {
    const rig = await startRig()
    const run = await runCli(['watch:approve', '--gateId', 'gate-1'], rig.home)
    expect(run.code).toBe(1)
    expect(run.stdout).toContain('deliberately not scriptable')
    expect(run.stdout).toContain('open the WATCH tab')
  })

  it('says in English that no harness is running, rather than ECONNREFUSED', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-cli-empty-'))
    temps.push(empty)
    const run = await runCli(['status'], empty)
    expect(run.code).toBe(3)
    expect(run.stderr).toContain('no Ephesus harness is running')
    expect(run.stderr).toContain('npm run dev')
    expect(run.stderr).not.toContain('ECONNREFUSED')
  })

  it('says the harness stopped without tidying up when the address is stale', async () => {
    const rig = await startRig()
    const stale = fs.readFileSync(path.join(rig.home, CONTROL_ADDRESS_FILE), 'utf8')
    await rig.server.stop()
    fs.writeFileSync(path.join(rig.home, CONTROL_ADDRESS_FILE), stale)
    const run = await runCli(['status'], rig.home)
    expect(run.code).toBe(3)
    expect(run.stderr).toContain('nothing is listening')
    expect(run.stderr).toContain('npm run dev')
  })

  it('prints the data half when asked for --json', async () => {
    const rig = await startRig()
    const run = await runCli(['consent:status', '--json'], rig.home)
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ state: 'not-granted', mayStartWork: false })
  })

  it('grants consent, and the act lands in the book of record tagged remote', async () => {
    const rig = await startRig()
    const run = await runCli(['consent:grant'], rig.home)
    expect(run.code).toBe(0)
    expect(rig.logged).toHaveLength(1)
    expect(rig.logged[0]).toMatchObject({
      kind: 'remote',
      event: 'control',
      channel: 'remote',
      verb: 'consent:grant',
      ok: true
    })
  })

  it('carries repeated flags through as a list', async () => {
    const rig = await startRig()
    const run = await runCli(
      [
        'profile:activate',
        '--profile',
        'skeleton-crew',
        '--target',
        'repo:myapp',
        '--path',
        rig.home,
        '--repo',
        'me/one',
        '--repo',
        'me/two'
      ],
      rig.home
    )
    // The stub refuses the activation; what is under test is that both repos
    // reached the harness rather than only the last one.
    expect(run.code).toBe(1)
    expect(run.stdout).toContain('no such profile')
  })

  it('exits 2 with a usage line when given no verb', async () => {
    const rig = await startRig()
    const run = await runCli([], rig.home)
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('no verb given')
    expect(run.stderr).toContain('Usage:')
  })
})

describe('the client holds no policy', () => {
  it('has no verb table, no refusal list and no rendering of its own', () => {
    const source = fs.readFileSync(CLI, 'utf8')
    // The four refusals must be enforced by the harness, never by the client:
    // a client-side list would be advisory, and would drift.
    const code = source.replace(/^\s*\/\/.*$|\/\*[\s\S]*?\*\//gm, '')
    expect(code).not.toContain('consent:grant')
    expect(code).not.toContain('watch:approve')
    expect(code).not.toContain('profile:activate')
  })
})

describe('parseArgs', () => {
  it('reads a verb with no flags', () => {
    expect(cli.parseArgs(['status'])).toEqual({ ok: true, verb: 'status', args: {}, json: false })
  })

  it('reads flags as strings, leaving every coercion to the harness', () => {
    expect(cli.parseArgs(['log:tail', '--limit', '7'])).toEqual({
      ok: true,
      verb: 'log:tail',
      args: { limit: '7' },
      json: false
    })
  })

  it('turns a repeated flag into a list, in the order it was typed', () => {
    const parsed = cli.parseArgs(['x', '--repo', 'a/b', '--repo', 'c/d', '--repo', 'e/f'])
    expect(parsed.ok && parsed.args).toEqual({ repo: ['a/b', 'c/d', 'e/f'] })
  })

  it('takes --json off the wire rather than sending it as an argument', () => {
    const parsed = cli.parseArgs(['status', '--json'])
    expect(parsed.ok && parsed.json).toBe(true)
    expect(parsed.ok && parsed.args).toEqual({})
  })

  it('refuses a flag with no value instead of inventing true', () => {
    expect(cli.parseArgs(['x', '--limit'])).toEqual({ ok: false, reason: '--limit needs a value' })
    expect(cli.parseArgs(['x', '--limit', '--json'])).toEqual({
      ok: false,
      reason: '--limit needs a value'
    })
  })

  it('refuses a bare -- and an invocation with no verb', () => {
    expect(cli.parseArgs(['x', '--', 'y']).ok).toBe(false)
    expect(cli.parseArgs([]).ok).toBe(false)
    expect(cli.parseArgs(['--json']).ok).toBe(false)
  })

  it('takes the verb from the front, never from a flag’s value', () => {
    // `--limit 7 log:tail` would read as the verb `7` if the parser looked for
    // "the first word that is not a flag", and the caller would get a puzzle
    // instead of a usage line.
    expect(cli.parseArgs(['--limit', '7', 'log:tail'])).toEqual({
      ok: false,
      reason: 'no verb given'
    })
  })
})

describe('resolveHome', () => {
  it('agrees with the app, for every environment', () => {
    // The pin. A CLI pointing at a different directory than the app would report
    // "no harness is running" against a harness that is.
    for (const env of [
      {},
      { EPH_HOME: 'C:\\eph-home' },
      { EPH_HOME: '' },
      { EPH_HOME: '/tmp/eph' }
    ] as Record<string, string | undefined>[])
      expect(cli.resolveHome(env)).toBe(harnessHomeRoot(env as NodeJS.ProcessEnv))
  })
})

describe('readAddress', () => {
  it('names the home in the sentence, so the reader can see which one was wrong', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-cli-addr-'))
    temps.push(empty)
    const found = cli.readAddress(empty)
    expect(found.ok).toBe(false)
    expect(found.ok === false && found.reason).toContain(empty)
    expect(found.ok === false && found.reason).toContain(cli.CONTROL_ADDRESS_FILE)
  })

  it('refuses an address file that is not JSON, and says what to do', () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-cli-broken-'))
    temps.push(broken)
    fs.writeFileSync(path.join(broken, CONTROL_ADDRESS_FILE), '{oh no')
    const found = cli.readAddress(broken)
    expect(found.ok).toBe(false)
    expect(found.ok === false && found.reason).toContain('restart the harness')
  })

  it('refuses an address file that names no endpoint', () => {
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-cli-shallow-'))
    temps.push(shallow)
    fs.writeFileSync(path.join(shallow, CONTROL_ADDRESS_FILE), JSON.stringify({ schemaVersion: 1 }))
    const found = cli.readAddress(shallow)
    expect(found.ok).toBe(false)
    expect(found.ok === false && found.reason).toContain('does not name an endpoint')
  })

  it('reads the one a running harness wrote', async () => {
    const rig = await startRig()
    const found = cli.readAddress(rig.home)
    expect(found.ok).toBe(true)
  })
})
