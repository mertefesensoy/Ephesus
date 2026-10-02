import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HookServer } from '../../src/main/hooks'
import { GH_TOKEN_SCHEMA_VERSION, type GhTokenResponse } from '../../src/shared/gh-token'
import { removeTempDir } from '../tmpdir'
import { importWithoutModulePath, runImporter } from './importer'

/**
 * `eph-gh-token` is what an agent actually runs (ADR-0022), so it is exercised
 * the way an agent runs it: `src/main/index.ts` hands every spawn
 * `"<node>" "<this shim>"`, and this file spawns exactly that against a real
 * `HookServer` on a real socket. The endpoint's own refusals are held in
 * `test/main/gh-token.test.ts`, through the shim's exported helper.
 *
 * The answer IS a credential, which is why the paths that print nothing on
 * stdout matter as much as the one that prints the token.
 */

const SHIM_URL = new URL('../../shims/eph-gh-token.mjs', import.meta.url)
const SHIM = fileURLToPath(SHIM_URL)
const AGENT = 'agent.mason'
const TOKEN = 'spawn-token-1'
const FRESH = 'a-fresh-installation-token'

interface Rig {
  readonly endpoint: string
  /** How many token requests reached the company identity. */
  readonly asked: number
}

const temps: string[] = []
const servers: HookServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

const granted = (): GhTokenResponse => ({
  schemaVersion: GH_TOKEN_SCHEMA_VERSION,
  ok: true,
  token: FRESH,
  expiresAt: null
})

async function startRig(answer: () => GhTokenResponse = granted): Promise<Rig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ghtok-shim-'))
  temps.push(root)
  let asked = 0
  const server = new HookServer({
    onEvent: () => undefined,
    onRejected: () => undefined,
    onGhToken: () => {
      asked += 1
      return answer()
    }
  })
  servers.push(server)
  const endpoint = await server.start(root)
  server.registerSpawn(AGENT, TOKEN)
  return {
    endpoint,
    get asked() {
      return asked
    }
  }
}

const wired = (rig: Rig): Record<string, string> => ({
  EPH_AGENT_ID: AGENT,
  EPH_HOOK_TOKEN: TOKEN,
  EPH_HOOK_ENDPOINT: rig.endpoint
})

function runShim(
  args: readonly string[],
  env: Readonly<Record<string, string>>
): Promise<{ code: number; stdout: string; stderr: string }> {
  // The caller's environment, minus NODE_OPTIONS: a loader or flag there makes
  // Node itself write to stderr, and a test here holds stderr to be empty.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
  delete childEnv['NODE_OPTIONS']
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM, ...args], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

describe('eph-gh-token — as an agent runs it', () => {
  it('prints the fresh token on stdout, and nothing else', async () => {
    const rig = await startRig()
    const result = await runShim([], wired(rig))
    expect(result.code).toBe(0)
    // `$(node eph-gh-token.mjs)` must be a credential, not a credential with a
    // sentence attached to it.
    expect(result.stdout).toBe(`${FRESH}\n`)
    expect(result.stderr).toBe('')
    expect(rig.asked).toBe(1)
  })

  it('speaks JSON when asked', async () => {
    const rig = await startRig()
    const result = await runShim(['--json'], wired(rig))
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, token: FRESH })
  })

  it("prints the harness's own refusal, never an empty token", async () => {
    const rig = await startRig(() => ({
      schemaVersion: GH_TOKEN_SCHEMA_VERSION,
      ok: false,
      because: 'your role does not declare GH_TOKEN'
    }))
    const result = await runShim([], wired(rig))
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('gh-token refused: your role does not declare GH_TOKEN')
  })

  it('refuses to run outside a harness spawn', async () => {
    const result = await runShim([], {
      EPH_AGENT_ID: '',
      EPH_HOOK_TOKEN: '',
      EPH_HOOK_ENDPOINT: ''
    })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('not started by the harness')
  })
})

describe('eph-gh-token — importing it', () => {
  // The guard at the bottom of the shim is what lets `test/main/gh-token.test.ts`
  // import its helper. A process imports it from a file that is not the shim and
  // is handed what `main()` acts on — the environment of a live spawn whose
  // harness hands out a token — so a guard that let `main()` run would really
  // ask for a credential and print it. It is handed stdin too, which the shim
  // never reads. `x-eph-gh-token.mjs` merely ends in the shim's name.
  it.each(['importer.mjs', 'x-eph-gh-token.mjs'])(
    'runs nothing when %s imports it',
    async (name) => {
      const rig = await startRig()
      const input = 'not for the shim\n'

      const run = await runImporter({ shim: SHIM_URL, name, args: [], env: wired(rig), input })

      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
      expect(run.stderr).toBe('')
      // `null` until something attaches a reader or resumes the stream.
      expect(run.flowing).toBe('null')
      // And nothing took any of it: the importer still reads all of it.
      expect(run.unread).toBe(input)
      // Nor started a read that took nothing: with stdin never ended, a pending
      // read would keep the importer alive, and it exits by itself instead.
      expect(run.heldOpen).toBe(0)
      expect(rig.asked).toBe(0)

      // The same inputs are live: run as the program, they fetch a credential.
      const direct = await runShim([], wired(rig))
      expect(direct.stdout).toBe(`${FRESH}\n`)
      expect(rig.asked).toBe(1)
    }
  )

  it('runs nothing when imported with no module path in argv[1]', async () => {
    // `node -e` with no arguments leaves `process.argv[1]` undefined, as a REPL
    // does, and `path.basename(undefined)` throws: the guard checks it first.
    expect(await importWithoutModulePath(SHIM_URL)).toEqual({ status: 0, stdout: '', stderr: '' })
  })
})
