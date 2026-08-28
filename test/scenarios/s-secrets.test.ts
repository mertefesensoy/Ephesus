import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpcChannels } from '../../src/shared/ipc'
import { SECRET_MASK } from '../../src/shared/redaction'
import { attachRedactedStream, type PtyDataSource, type PtySink } from '../../src/main/pty-stream'
import { SecretBroker } from '../../src/main/watch/secrets'
import type { SecretCipher } from '../../src/main/watch/cipher'
import { cleanupHomes, startCompany, type Company } from './company'

/**
 * **S-SECRETS** (TEST-STRATEGY §3): "broker write-only (no read IPC exists —
 * asserted by API surface test); env grants least-privilege per hire; redaction
 * filter masks a planted token in PTY stream."
 *
 * Three separate promises, asserted separately, because they fail separately:
 * a broker with a read channel leaks on request, a broker that scopes grants
 * loosely leaks at spawn, and a broker whose filter has holes leaks into a
 * terminal the Architect is screen-sharing.
 *
 * The planted values are **scanner-neutral** (M1-audit ruling): nothing in this
 * file is shaped like a real credential, so a secret scanner over this
 * repository finds nothing to report.
 */

const PLANTED = 'not-a-real-credential-0123456789'
const OTHERS = 'a-different-fake-value-987654321'

const companies: Company[] = []
const homes: string[] = []

afterEach(async () => {
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

/** The cipher seam ADR-0010 puts `safeStorage` behind, so vitest never loads it. */
function fakeCipher(): SecretCipher {
  return {
    available: () => true,
    backend: () => 'fake',
    encrypt: (plaintext) => Buffer.from(plaintext, 'utf8').toString('base64'),
    decrypt: (payload) => Buffer.from(payload, 'base64').toString('utf8')
  }
}

function brokerIn(home: string): SecretBroker {
  return new SecretBroker({ storePath: path.join(home, 'secrets.enc'), cipher: fakeCipher() })
}

async function boot(): Promise<Company> {
  const company = await startCompany()
  companies.push(company)
  return company
}

describe('S-SECRETS — the broker is write-only (FR-11.4, ADR-0010)', () => {
  it('registers exactly four `secrets:` channels, and none of them reads', async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
    vi.doMock('electron', () => ({
      ipcMain: {
        handle: (channel: string, handler: (e: unknown, p: unknown) => unknown) => {
          handlers.set(channel, handler)
        }
      }
    }))
    const { registerIpc } = await import('../../src/main/ipc')
    const home = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'eph-s-secrets-'))
    homes.push(home)
    const secrets = brokerIn(home)
    secrets.set('GH_TOKEN', PLANTED)

    registerIpc({
      ptyManager: {} as never,
      agents: {} as never,
      avatars: { list: () => new Map() } as never,
      commands: { list: () => [] } as never,
      agora: {} as never,
      secrets,
      gates: {} as never,
      budgets: () => [],
      humanQueue: () => [],
      dismissFromHumanQueue: () => true,
      breakerState: () => [],
      hooksState: () => ({ endpoint: null, driftWarnings: [], failure: null }),
      agoraHealth: () => ({ fileWarnings: [], commitFailures: [], runtime: [] }),
      memoryView: (agentId: string) => ({
        agentId,
        path: '',
        text: '',
        sections: 0,
        archive: [],
        reflection: { due: false, because: 'no library in this rig', chars: 0 }
      }),
      recall: (query: string) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          query,
          rung: 'grep' as const,
          hits: [],
          degraded: 'no library in this rig'
        }),
      knowledge: () => [],
      registerKnowledge: () => [],
      briefs: () => [],
      orgChart: () => [],
      orgMetrics: () => ({ metrics: [], findings: [] }),
      retros: () => [],
      generateRetro: () => ({ ok: false, reason: 'no org layer' }),
      convene: () => ({ ok: false, reason: 'no odeon' }),
      meeting: () => null,
      meetingSay: () => ({ kind: 'refused', reason: 'no odeon' }),
      meetingClose: () => ({ ok: false, reason: 'no odeon' }),
      decks: () => [],
      deck: () => null,
      commentOnDeck: () => ({ queued: false, because: 'no orchestrator' }),
      memos: () => [],
      decideMemo: () => ({ ok: false, reason: 'no odeon' })
    })

    const secretChannels = [...handlers.keys()].filter((c) => c.startsWith('secrets:')).sort()
    expect(secretChannels).toEqual([
      IpcChannels.secretsDelete,
      IpcChannels.secretsSet,
      IpcChannels.secretsStatus,
      IpcChannels.secretsTest
    ])

    // The property, stated as the audit would state it: call every channel the
    // renderer can reach, with a value planted in the store, and prove no
    // response anywhere contains it.
    const responses = [
      await handlers.get(IpcChannels.secretsStatus)?.({}, { name: 'GH_TOKEN' }),
      await handlers.get(IpcChannels.secretsTest)?.({}, { name: 'GH_TOKEN' }),
      await handlers.get(IpcChannels.secretsSet)?.({}, { name: 'GH_TOKEN', value: OTHERS }),
      await handlers.get(IpcChannels.secretsDelete)?.({}, { name: 'GH_TOKEN' })
    ]
    for (const response of responses) {
      expect(JSON.stringify(response ?? null)).not.toContain(PLANTED)
      expect(JSON.stringify(response ?? null)).not.toContain(OTHERS)
    }
    vi.doUnmock('electron')
  })

  it('reports presence without reporting content', async () => {
    const home = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'eph-s-secrets-'))
    homes.push(home)
    const secrets = brokerIn(home)
    secrets.set('GH_TOKEN', PLANTED)
    const status = secrets.status('GH_TOKEN')
    expect(status.present).toBe(true)
    expect(JSON.stringify(status)).not.toContain(PLANTED)
  })

  it('keeps only ciphertext on disk', async () => {
    const home = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'eph-s-secrets-'))
    homes.push(home)
    brokerIn(home).set('GH_TOKEN', PLANTED)
    const onDisk = fs.readFileSync(path.join(home, 'secrets.enc'), 'utf8')
    expect(onDisk).not.toContain(PLANTED)
    expect(onDisk.length).toBeGreaterThan(0)
  })
})

describe('S-SECRETS — env grants are least-privilege per hire (ADR-0010)', () => {
  it('gives each hire only what its own role declared', async () => {
    const home = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'eph-s-secrets-'))
    homes.push(home)
    const secrets = brokerIn(home)
    secrets.set('GH_TOKEN', PLANTED)
    secrets.set('VOICE_KEY', OTHERS)

    const mason = secrets.grantsFor(['GH_TOKEN'])
    const herald = secrets.grantsFor(['VOICE_KEY'])
    expect(Object.keys(mason.env)).toEqual(['GH_TOKEN'])
    expect(Object.keys(herald.env)).toEqual(['VOICE_KEY'])
    // The credential the other role holds must have no path into this spawn,
    // even though the broker holds both.
    expect(JSON.stringify(mason.env)).not.toContain(OTHERS)
    expect(JSON.stringify(herald.env)).not.toContain(PLANTED)
  })

  it('gives an undeclared grant to nobody, however the caller asks', async () => {
    const home = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'eph-s-secrets-'))
    homes.push(home)
    const secrets = brokerIn(home)
    secrets.set('GH_TOKEN', PLANTED)
    expect(secrets.grantsFor([]).env).toEqual({})
  })

  it('names a declared grant it does not hold rather than spawning short of it', async () => {
    const home = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'eph-s-secrets-'))
    homes.push(home)
    const secrets = brokerIn(home)
    const scoped = secrets.grantsFor(['GH_TOKEN'])
    // An agent that spawns without the credential its role declares fails
    // later, somewhere less obvious (invariant §7).
    expect(scoped.missing).toEqual(['GH_TOKEN'])
  })

  it('a REAL agent process sees its own grant and not the other role’s', async () => {
    const company = await boot()
    company.hire('agent.mason')
    const home = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'eph-s-secrets-'))
    homes.push(home)
    const secrets = brokerIn(home)
    secrets.set('GH_TOKEN', PLANTED)
    secrets.set('VOICE_KEY', OTHERS)

    // The agent reports what the harness actually put in its environment —
    // the conformance suite's `echo-env`, used here as an audit.
    const scoped = secrets.grantsFor(['GH_TOKEN'])
    const cwd = path.join(company.home, 'repo-mason')
    fs.mkdirSync(cwd, { recursive: true })
    // The grant reaches the child through its SPAWN environment, the way
    // `AgentManager` injects it — never through the harness's own process env.
    const out = await company.runTurnIn(
      'agent.mason',
      cwd,
      [
        { kind: 'echo-env', name: 'GH_TOKEN' },
        { kind: 'echo-env', name: 'VOICE_KEY' }
      ],
      scoped.env
    )
    expect(out).toContain(`env GH_TOKEN=${PLANTED}`)
    // The credential the OTHER role holds is not in this process at all, even
    // though the broker holds it.
    expect(out).toContain('env-missing VOICE_KEY')
    expect(out).not.toContain(OTHERS)
  })
})

describe('S-SECRETS — the filter masks a planted token in the PTY stream', () => {
  /** A source that replays scripted chunks, the way node-pty emits them. */
  function source(
    chunks: readonly string[]
  ): PtyDataSource & { finish(): void; push(data: string): void } {
    let onData: (data: string) => void = () => {}
    let onExit: (e: { exitCode: number }) => void = () => {}
    return {
      onData: (cb) => {
        onData = cb
        for (const chunk of chunks) cb(chunk)
      },
      onExit: (cb) => {
        onExit = cb
      },
      push: (data) => onData(data),
      finish: () => onExit({ exitCode: 0 })
    }
  }

  function sinkInto(out: string[]): PtySink {
    return {
      send: (_channel: string, payload: unknown) => {
        if (typeof payload === 'string') out.push(payload)
      }
    }
  }

  function run(chunks: readonly string[], secrets: SecretBroker): string {
    const out: string[] = []
    const src = source(chunks)
    attachRedactedStream({
      id: 'agent.mason',
      source: src,
      filter: secrets.redactor(),
      sink: () => sinkInto(out),
      onExit: () => {}
    })
    src.finish()
    return out.join('')
  }

  function withPlanted(): SecretBroker {
    const home = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'eph-s-secrets-'))
    homes.push(home)
    const secrets = brokerIn(home)
    secrets.set('GH_TOKEN', PLANTED)
    return secrets
  }

  it('masks a planted token an agent echoed', () => {
    const out = run([`$ echo $GH_TOKEN\r\n${PLANTED}\r\n`], withPlanted())
    expect(out).not.toContain(PLANTED)
    expect(out).toContain(SECRET_MASK)
  })

  it('masks it when the engine splits it across two chunks', () => {
    // A pty emits whatever the kernel gave it; a filter that only matched
    // within a chunk would leak on a 4 KB boundary.
    const half = Math.floor(PLANTED.length / 2)
    const out = run([PLANTED.slice(0, half), `${PLANTED.slice(half)}\r\n`], withPlanted())
    expect(out).not.toContain(PLANTED)
    expect(out).toContain(SECRET_MASK)
  })

  it('masks every occurrence, not just the first', () => {
    const out = run([`${PLANTED} and again ${PLANTED}\r\n`], withPlanted())
    expect(out).not.toContain(PLANTED)
    expect(out.match(new RegExp(SECRET_MASK, 'g'))).toHaveLength(2)
  })

  it('masks a token planted while the stream was ALREADY open', () => {
    const secrets = withPlanted()
    const out: string[] = []
    const src = source([])
    // One filter, one attached stream — the credential is stored midway
    // through the session, as a rotation actually happens.
    attachRedactedStream({
      id: 'agent.mason',
      source: src,
      filter: secrets.redactor(),
      sink: () => sinkInto(out),
      onExit: () => {}
    })
    src.push(`${OTHERS}\r\n`)
    expect(out.join('')).toContain(OTHERS)

    secrets.set('VOICE_KEY', OTHERS)
    out.length = 0
    src.push(`${OTHERS}\r\n`)
    // The filter reads the store on every push, so a credential stored mid-run
    // is masked from that moment rather than from the next spawn.
    expect(out.join('')).not.toContain(OTHERS)
    expect(out.join('')).toContain(SECRET_MASK)
  })

  it('leaves ordinary output alone', () => {
    const out = run(['$ npm test\r\n42 passed\r\n'], withPlanted())
    expect(out).toBe('$ npm test\r\n42 passed\r\n')
  })

  it('flushes anything it was holding back when the process exits', () => {
    // The filter holds a trailing region only while it could still be the start
    // of a secret; on exit that text has to reach the terminal, not vanish.
    const out = run([PLANTED.slice(0, 6)], withPlanted())
    expect(out).toBe(PLANTED.slice(0, 6))
  })
})
