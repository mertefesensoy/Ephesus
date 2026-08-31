import { execFile } from 'node:child_process'
import {
  parseIssues,
  parsePulls,
  parseRuns,
  remoteLogEntries,
  HARBOR_SCHEMA_VERSION,
  type HarborView,
  type InboundItem,
  type RepoQueue
} from '../../shared/harbor'

/**
 * GitHub ingestion (FR-10.1, FR-10.3, SDD §1.1 `harbor/github.ts` — M7.3).
 *
 * FR-10.1 is specific about the mechanism: "ingest issues, PRs, and CI runs for
 * registered repos; **act via the `gh` CLI under the agent's own auth**". Three
 * consequences shape this module, and none of them is incidental:
 *
 * - **No token, anywhere.** There is no option to supply one, no env var read,
 *   and nothing from the secret broker reaches here. `gh` carries its own
 *   login. The absence is the design: a Harbor that accepted a token would be
 *   a Harbor that could be handed one by an imported profile (FR-10.4), and
 *   ADR-0010's write-only broker exists precisely so no code path holds a
 *   credential it did not need.
 * - **Subprocess discipline, as ADR-0009 sets it for engine CLIs and ADR-0016
 *   reuses for MemPalace:** version probe first, and an unprobed `gh` is
 *   *unavailable* — visibly — rather than an empty queue.
 * - **A failure is never an empty queue.** `RepoQueue.failure` is a field, so a
 *   repository whose call errored and one with genuinely nothing open cannot
 *   look alike. The second is fine; the first means the company is blind and
 *   the Architect has to be told (invariant §7).
 *
 * Every `gh` invocation goes through `GhRunner`, which the suites replace with a
 * script. That is TEST-STRATEGY §1's stance — determinize the boundary, not the
 * world — and it is why S-PROFILE never touches the network.
 */

export const GH_BINARY = 'gh'
/** Shown, never run — the FR-1.6 posture the engine adapters already take. */
export const GH_INSTALL: readonly string[] = ['https://cli.github.com']
const DEFAULT_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 10_000
/** `gh version 2.62.0 (2024-11-14)` — the line the CLI actually prints. */
const VERSION_LINE = /gh version\s+(\d+\.\d+\.\d+[\w.+-]*)/i
/** Bounded so one busy repository cannot flood the queue or the log. */
const PAGE_LIMIT = 50
/**
 * How often the company re-reads its registered repositories.
 *
 * Ten minutes, not one: `gh` is a network round trip per repo per kind, the
 * Skeleton Crew's own incident triggers are what make a failure urgent, and a
 * cadence tight enough to feel live is also tight enough to look like abuse
 * from GitHub's side. The one-hour company test (SRS §6.1) has room for six
 * passes.
 */
export const HARBOR_INGEST_EVERY_MS = 10 * 60_000

export interface GhResult {
  readonly ok: boolean
  readonly stdout: string
  /** First line of stderr, or the spawn error. Never the whole stream. */
  readonly error: string | null
}

/**
 * The one seam every `gh` call crosses.
 *
 * Args only — no shell string, no cwd the caller can point anywhere, and no
 * environment. A runner that took an env would be a place for a token to
 * arrive, which is the thing this module is built not to have.
 */
export type GhRunner = (args: readonly string[], timeoutMs: number) => Promise<GhResult>

export const execGh: GhRunner = (args, timeoutMs) =>
  new Promise<GhResult>((resolve) => {
    execFile(
      GH_BINARY,
      [...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const first = String(stderr)
            .split('\n')
            .find((line) => line.trim().length > 0)
          resolve({
            ok: false,
            stdout: String(stdout),
            error: first ?? err.message.split('\n')[0] ?? 'gh failed'
          })
          return
        }
        resolve({ ok: true, stdout: String(stdout), error: null })
      }
    )
  })

export interface GitHubHarborOptions {
  /** Which repositories to ingest — the active profiles' `harbor.json` repos. */
  repos(): readonly string[]
  run?: GhRunner
  now?(): Date
  /** `log.jsonl` kind `remote` (SDD §4.3, FR-10.3). */
  onLogEvent?(draft: { kind: 'remote' } & Record<string, unknown>): void
  /** Raised so the degradation reaches the UI, never only a console. */
  onDegraded?(what: string): void
}

/**
 * The port's inbound half.
 *
 * Holds the last ingestion so the panel and the briefing read the same numbers
 * the log recorded, rather than each triggering its own `gh` call and quietly
 * disagreeing.
 */
export class GitHubHarbor {
  private ghVersion: string | null = null
  private unavailable: string | null = 'gh has not been probed yet'
  private readonly queues = new Map<string, RepoQueue>()
  private readonly run: GhRunner

  constructor(private readonly options: GitHubHarborOptions) {
    this.run = options.run ?? execGh
  }

  /**
   * Contract: probes `gh` and records the result. Never throws.
   *
   * An unparseable or missing binary leaves `unavailable` set with a reason the
   * Architect can act on, and every later `ingest` short-circuits to that same
   * reason rather than producing empty queues that read as "nothing to do".
   */
  async probe(): Promise<string | null> {
    const result = await this.run(['--version'], PROBE_TIMEOUT_MS)
    if (!result.ok) {
      this.ghVersion = null
      this.unavailable = `gh is not available: ${result.error ?? 'no response'}`
      this.options.onDegraded?.(this.unavailable)
      return null
    }
    const version = VERSION_LINE.exec(result.stdout)?.[1] ?? null
    if (version === null) {
      this.ghVersion = null
      this.unavailable = 'gh answered --version in a shape this build does not recognise'
      this.options.onDegraded?.(this.unavailable)
      return null
    }
    this.ghVersion = version
    this.unavailable = null
    return version
  }

  /**
   * Contract: ingests every registered repository, and returns what the Harbor
   * now holds. Never throws.
   *
   * Repositories are read one at a time and independently: one that 404s must
   * not cost the others their ingestion, and its failure is recorded on its own
   * queue rather than raised.
   */
  async ingest(): Promise<HarborView> {
    if (this.unavailable !== null) {
      // Deliberately does NOT clear the queues. What the Harbor last knew is
      // still the last thing it knew; replacing it with emptiness because the
      // CLI went missing would turn a degradation into a false all-clear.
      return this.view()
    }
    const at = (this.options.now?.() ?? new Date()).toISOString()
    for (const repo of this.options.repos()) {
      this.queues.set(repo, await this.ingestRepo(repo, at))
    }
    // Repositories that are no longer registered stop being reported. Their
    // items already reached `log.jsonl`, which is the durable record; the queue
    // is a view of what is watched NOW.
    const registered = new Set(this.options.repos())
    for (const repo of [...this.queues.keys()]) {
      if (!registered.has(repo)) this.queues.delete(repo)
    }
    return this.view()
  }

  /** Contract: what the Harbor holds, without touching the network. */
  view(): HarborView {
    return {
      schemaVersion: HARBOR_SCHEMA_VERSION,
      ghVersion: this.ghVersion,
      unavailable: this.unavailable,
      repos: [...this.queues.values()].sort((a, b) => a.repo.localeCompare(b.repo))
    }
  }

  private async ingestRepo(repo: string, at: string): Promise<RepoQueue> {
    const calls = [
      {
        args: [
          'issue',
          'list',
          '--repo',
          repo,
          '--limit',
          String(PAGE_LIMIT),
          '--json',
          'number,title,state,updatedAt,url,author,labels'
        ],
        parse: (body: string) => parseIssues(repo, body)
      },
      {
        args: [
          'pr',
          'list',
          '--repo',
          repo,
          '--limit',
          String(PAGE_LIMIT),
          '--json',
          'number,title,state,updatedAt,url,author,labels,isDraft'
        ],
        parse: (body: string) => parsePulls(repo, body)
      },
      {
        args: [
          'run',
          'list',
          '--repo',
          repo,
          '--limit',
          String(PAGE_LIMIT),
          '--json',
          'databaseId,workflowName,status,conclusion,headBranch,createdAt,url'
        ],
        parse: (body: string) => parseRuns(repo, body)
      }
    ] as const

    const items: InboundItem[] = []
    const reasons: string[] = []
    let dropped = 0
    for (const call of calls) {
      const result = await this.run(call.args, DEFAULT_TIMEOUT_MS)
      if (!result.ok) {
        const failure = `${repo}: ${result.error ?? 'gh failed'}`
        this.options.onDegraded?.(failure)
        // The whole repo is marked failed, not the one call. A partial queue
        // showing issues but silently no CI runs is worse than a named failure:
        // the CI babysitter would see a clean board.
        return {
          repo,
          items: this.queues.get(repo)?.items ?? [],
          dropped: 0,
          reasons: [],
          failure,
          ingestedAt: this.queues.get(repo)?.ingestedAt ?? null
        }
      }
      const parsed = call.parse(result.stdout)
      items.push(...parsed.items)
      dropped += parsed.dropped
      reasons.push(...parsed.reasons)
    }

    if (dropped > 0) {
      this.options.onDegraded?.(
        `${repo}: ${String(dropped)} row(s) from gh did not match the expected shape and were dropped`
      )
    }
    // FR-10.3, applied as a projection of the items rather than by hand: an
    // item that reached the queue without reaching the log would have to be one
    // this call never saw.
    for (const entry of remoteLogEntries(items)) this.options.onLogEvent?.(entry)

    return { repo, items, dropped, reasons, failure: null, ingestedAt: at }
  }
}
