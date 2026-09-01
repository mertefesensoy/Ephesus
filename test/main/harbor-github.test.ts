import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GH_BINARY, GitHubHarbor, type GhResult } from '../../src/main/harbor/github'

/**
 * The `gh` driver (FR-10.1, FR-10.3, SDD §1.1 `harbor/github.ts` — M7.3).
 *
 * A scripted runner, so the suites never touch the network (TEST-STRATEGY §1:
 * determinize the boundary, not the world). Three claims:
 *
 *  - **A failure is never an empty queue.** `RepoQueue.failure` is a field, so
 *    a repo whose call errored and one with genuinely nothing open cannot look
 *    alike. The second is fine; the first means the company is blind.
 *  - **`remote` tagging is total** over every inbound path (FR-10.3).
 *  - **No secret can reach ingestion** — asserted by API surface, the S-SECRETS
 *    pattern: there is no option, no env read, and no argument through which a
 *    token could arrive, and `gh` carries its own login (FR-10.1).
 */

const VERSION = 'gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/latest\n'

const ISSUE = {
  number: 12,
  title: 'Login times out',
  state: 'OPEN',
  updatedAt: '2026-08-30T09:00:00Z',
  url: 'https://github.com/octocat/myapp/issues/12',
  author: { login: 'kestrel' },
  labels: [{ name: 'bug' }]
}
const PULL = { number: 3, title: 'retry logic', state: 'OPEN', updatedAt: 'x', url: 'u' }
const RUN = {
  databaseId: 991,
  workflowName: 'ci',
  status: 'completed',
  conclusion: 'failure',
  headBranch: 'main',
  createdAt: 'x',
  url: 'u'
}

interface Script {
  /** Per subcommand (`issue`, `pr`, `run`) — the response, or a failure. */
  readonly issue?: GhResult
  readonly pr?: GhResult
  readonly run?: GhResult
  readonly version?: GhResult
}

const ok = (rows: unknown[]): GhResult => ({ ok: true, stdout: JSON.stringify(rows), error: null })
const fail = (error: string): GhResult => ({ ok: false, stdout: '', error })

function rig(script: Script = {}, repos: readonly string[] = ['octocat/myapp']) {
  const calls: string[][] = []
  const logs: Record<string, unknown>[] = []
  const degradations: string[] = []
  const harbor = new GitHubHarbor({
    repos: () => repos,
    now: () => new Date('2026-08-31T12:00:00.000Z'),
    onLogEvent: (draft) => logs.push(draft),
    onDegraded: (what) => degradations.push(what),
    run: (args) => {
      calls.push([...args])
      if (args[0] === '--version') {
        return Promise.resolve(script.version ?? { ok: true, stdout: VERSION, error: null })
      }
      if (args[0] === 'issue') return Promise.resolve(script.issue ?? ok([ISSUE]))
      if (args[0] === 'pr') return Promise.resolve(script.pr ?? ok([PULL]))
      if (args[0] === 'run') return Promise.resolve(script.run ?? ok([RUN]))
      return Promise.resolve(fail(`unscripted: ${args.join(' ')}`))
    }
  })
  return { harbor, calls, logs, degradations }
}

describe('the probe comes first (ADR-0009 subprocess discipline)', () => {
  it('records the version and becomes available', async () => {
    const r = rig()
    expect(await r.harbor.probe()).toBe('2.62.0')
    expect(r.harbor.view()).toMatchObject({ ghVersion: '2.62.0', unavailable: null })
  })

  it('is UNAVAILABLE, visibly, when gh is missing — not merely empty', async () => {
    const r = rig({ version: fail('spawn gh ENOENT') })
    expect(await r.harbor.probe()).toBeNull()
    const view = r.harbor.view()
    expect(view.ghVersion).toBeNull()
    expect(view.unavailable).toContain('gh is not available')
    expect(r.degradations.join(' · ')).toContain('gh is not available')
  })

  it('is unavailable when --version answers in an unknown shape', async () => {
    const r = rig({ version: { ok: true, stdout: 'gh, but make it art', error: null } })
    expect(await r.harbor.probe()).toBeNull()
    expect(r.harbor.view().unavailable).toContain('does not recognise')
  })

  it('ingests NOTHING before a probe, and says why', async () => {
    // An unprobed Harbor producing empty queues would read as "nothing to do".
    const r = rig()
    const view = await r.harbor.ingest()
    expect(view.unavailable).toContain('not been probed')
    expect(view.repos).toEqual([])
    expect(r.calls).toEqual([])
  })
})

describe('ingestion', () => {
  it('reads issues, PRs and CI runs for each registered repo', async () => {
    const r = rig()
    await r.harbor.probe()
    const view = await r.harbor.ingest()

    expect(r.calls.map((call) => call[0])).toEqual(['--version', 'issue', 'pr', 'run'])
    const queue = view.repos[0]
    expect(queue?.repo).toBe('octocat/myapp')
    expect(queue?.failure).toBeNull()
    expect(queue?.ingestedAt).toBe('2026-08-31T12:00:00.000Z')
    expect(queue?.items.map((item) => item.kind)).toEqual(['issue', 'pull-request', 'ci-run'])
  })

  it('scopes every call to the repo, and bounds the page', async () => {
    const r = rig()
    await r.harbor.probe()
    await r.harbor.ingest()
    for (const call of r.calls.filter((c) => c[0] !== '--version')) {
      expect(call).toContain('--repo')
      expect(call[call.indexOf('--repo') + 1]).toBe('octocat/myapp')
      expect(call).toContain('--limit')
    }
  })

  it('a `gh` failure is a NAMED failure on that repo, never a silent empty queue', async () => {
    const r = rig({ run: fail('HTTP 404: Not Found') })
    await r.harbor.probe()
    const view = await r.harbor.ingest()

    const queue = view.repos[0]
    expect(queue?.failure).toContain('HTTP 404')
    expect(r.degradations.join(' · ')).toContain('HTTP 404')
    // And the whole repo is failed, not just the one call: a board showing
    // issues but silently no CI runs would look clean to the babysitter.
    expect(queue?.items).toEqual([])
  })

  it('keeps what it last knew when a later ingestion fails', async () => {
    // Replacing a known queue with emptiness because the CLI broke would turn a
    // degradation into a false all-clear.
    const script: { run: GhResult | undefined } = { run: undefined }
    const calls: string[][] = []
    const harbor = new GitHubHarbor({
      repos: () => ['octocat/myapp'],
      run: (args) => {
        calls.push([...args])
        if (args[0] === '--version')
          return Promise.resolve({ ok: true, stdout: VERSION, error: null })
        if (args[0] === 'issue') return Promise.resolve(ok([ISSUE]))
        if (args[0] === 'pr') return Promise.resolve(ok([]))
        return Promise.resolve(script.run ?? ok([RUN]))
      }
    })
    await harbor.probe()
    await harbor.ingest()
    expect(harbor.view().repos[0]?.items).toHaveLength(2)

    script.run = fail('network is unreachable')
    const view = await harbor.ingest()
    expect(view.repos[0]?.failure).toContain('network is unreachable')
    expect(view.repos[0]?.items).toHaveLength(2)
  })

  it('drops malformed rows, counts them, and SAYS so', async () => {
    const r = rig({ issue: ok([ISSUE, { title: 'no number' }]) })
    await r.harbor.probe()
    const view = await r.harbor.ingest()
    expect(view.repos[0]?.dropped).toBe(1)
    expect(r.degradations.join(' · ')).toContain('did not match the expected shape')
  })

  it('drops a repo from the view once it is no longer registered', async () => {
    let repos = ['octocat/myapp', 'octocat/other']
    const harbor = new GitHubHarbor({
      repos: () => repos,
      run: (args) =>
        Promise.resolve(
          args[0] === '--version' ? { ok: true, stdout: VERSION, error: null } : ok([])
        )
    })
    await harbor.probe()
    expect((await harbor.ingest()).repos.map((q) => q.repo)).toEqual([
      'octocat/myapp',
      'octocat/other'
    ])
    repos = ['octocat/myapp']
    expect((await harbor.ingest()).repos.map((q) => q.repo)).toEqual(['octocat/myapp'])
  })

  it('one failing repo does not cost the others their ingestion', async () => {
    const harbor = new GitHubHarbor({
      repos: () => ['octocat/bad', 'octocat/good'],
      run: (args) => {
        if (args[0] === '--version')
          return Promise.resolve({ ok: true, stdout: VERSION, error: null })
        const repo = args[args.indexOf('--repo') + 1]
        if (repo === 'octocat/bad') return Promise.resolve(fail('HTTP 404'))
        return Promise.resolve(args[0] === 'issue' ? ok([ISSUE]) : ok([]))
      }
    })
    await harbor.probe()
    const view = await harbor.ingest()
    expect(view.repos.find((q) => q.repo === 'octocat/bad')?.failure).toContain('404')
    expect(view.repos.find((q) => q.repo === 'octocat/good')?.items).toHaveLength(1)
  })
})

describe('`remote` tagging is total (FR-10.3)', () => {
  it('logs one `remote` entry per ingested item, of every kind', async () => {
    const r = rig()
    await r.harbor.probe()
    await r.harbor.ingest()

    expect(r.logs).toHaveLength(3)
    expect(r.logs.every((entry) => entry['kind'] === 'remote')).toBe(true)
    expect(r.logs.map((entry) => entry['inbound'])).toEqual(['issue', 'pull-request', 'ci-run'])
    expect(r.logs.every((entry) => entry['source'] === 'github')).toBe(true)
  })

  it('logs nothing for a repo whose ingestion failed', async () => {
    // Tagging is for what actually came in. An entry for an item that never
    // arrived is the invention this package is built to prevent.
    const r = rig({ issue: fail('HTTP 404') })
    await r.harbor.probe()
    await r.harbor.ingest()
    expect(r.logs).toEqual([])
  })

  it('logs nothing when a LATER call fails, even though earlier ones succeeded', async () => {
    // The subtle one, and the reason the first mutation sweep needed a second
    // pass: failing the FIRST call leaves nothing in flight to leak. Here the
    // issues came back fine and the CI call died — the whole repo is failed, so
    // none of it reaches the log. Half a repo tagged `remote` would put items
    // in the book of record that the queue never showed.
    const r = rig({ run: fail('HTTP 502') })
    await r.harbor.probe()
    const view = await r.harbor.ingest()
    expect(view.repos[0]?.failure).toContain('HTTP 502')
    expect(r.logs).toEqual([])
  })

  it('logs nothing for a dropped row', async () => {
    const r = rig({ issue: ok([{ title: 'no number' }]), pr: ok([]), run: ok([]) })
    await r.harbor.probe()
    await r.harbor.ingest()
    expect(r.logs).toEqual([])
  })
})

describe('no secret can reach ingestion (FR-10.1, ADR-0010 — the S-SECRETS pattern)', () => {
  it('passes no token, header or credential on any gh invocation', async () => {
    const r = rig()
    await r.harbor.probe()
    await r.harbor.ingest()
    const flat = r.calls.flat().join(' ')
    for (const forbidden of ['--token', 'GH_TOKEN', 'GITHUB_TOKEN', 'Authorization', '--header']) {
      expect(flat).not.toContain(forbidden)
    }
  })

  it('has no option through which a caller could supply one', () => {
    // The API surface IS the assertion, exactly as the broker's is: a Harbor
    // that accepted a token would be a Harbor an imported profile (FR-10.4)
    // could hand one to. `gh` carries its own login.
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'main', 'harbor', 'github.ts'),
      'utf8'
    )
    const options = /export interface GitHubHarborOptions \{[\s\S]*?\n\}/.exec(source)?.[0] ?? ''
    expect(options).not.toBe('')
    for (const forbidden of ['token', 'Token', 'secret', 'Secret', 'auth', 'Auth', 'env']) {
      expect(options).not.toContain(forbidden)
    }
  })

  it('reads no environment variable at all', async () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'main', 'harbor', 'github.ts'),
      'utf8'
    )
    expect(source).not.toContain('process.env')
    // And the runner seam takes args and a timeout — there is no env parameter
    // for one to arrive through.
    expect(source).toContain('export type GhRunner = (args: readonly string[], timeoutMs: number)')
  })

  it('names the binary it drives, and offers rather than installs it', () => {
    expect(GH_BINARY).toBe('gh')
  })
})
