import { execFile } from 'node:child_process'
import path from 'node:path'
import {
  RECALL_MAX_LIMIT,
  recallTerms,
  snippetOf,
  type RecallHit,
  type RecallRung,
  type RecallSource
} from '../shared/recall'
import type { IndexableDoc, IndexSyncReport, RecallIndex } from './library'

/**
 * The MemPalace driver — Library layer 2 and the company archive (ADR-0016).
 *
 * ADR-0016 §4 is normative about *how* this integration behaves: MemPalace is a
 * local subprocess under "the same subprocess discipline as engine CLIs
 * (ADR-0009): version probe, visible install offer, no hidden daemons". So:
 *
 * - **Version probe first.** Nothing is driven until `mempalace --version`
 *   answers. An unprobed or unparseable install is unavailable, visibly, and
 *   the ladder steps down to FTS and then grep.
 * - **Install offers are shown, never run.** `installCommand()` is what the
 *   Architect is offered (FR-1.6 posture); this module never installs anything.
 * - **No hidden daemons.** `--daemon` and `--background` are never passed, and
 *   `MEMPALACE_HOOKS_DAEMON=0` is set on every invocation.
 * - **One writer path.** `MEMPALACE_HOOKS_AUTO_SAVE=0` is set on every
 *   invocation, and the engine-side `mempalace hook` is never installed into any
 *   engine's settings — ADR-0016's consequence: the archive has one writer, and
 *   it is the Library.
 *
 * The palace lives at `~/.ephesus/index/` (SDD §2): derived state, disposable,
 * outside the Agora repo, so archiving can never make a commit.
 *
 * Written against MemPalace 3.x's real CLI: `--palace` is global and precedes
 * the subcommand; `mine <dir> --wing <w> --agent <a>`; `search <q> [--wing w]
 * [--results n]`. `search` has no machine-readable mode, so the human output is
 * parsed — tolerantly, and an unrecognized shape yields **no hits and a visible
 * degradation**, never an invented one (the rule the transcript readers follow).
 */

/** MemPalace's own default entry point. */
export const MEMPALACE_BINARY = 'mempalace'
/** ADR-0016 §6: the optional external, named so the offer can be shown. */
export const MEMPALACE_INSTALL: readonly string[] = ['pip', 'install', 'mempalace']
const DEFAULT_TIMEOUT_MS = 120_000
const PROBE_TIMEOUT_MS = 20_000
/** `MemPalace 3.8.0` — the version line the CLI actually prints. */
const VERSION_LINE = /MemPalace\s+(\d+\.\d+\.\d+[\w.+-]*)/i

/**
 * ADR-0016 §2's structure mapping, as this harness applies it: one wing per
 * agent (its memory and its archive), one wing for the knowledge shelf.
 *
 * ADR-0016 also names a wing per target/project. Those are the repos agents
 * work in, not Agora content, and nothing in M4 mines them — recorded here so
 * the gap is visible rather than looking like an oversight.
 */
export interface MemPalaceWing {
  /** The wing name MemPalace files under. */
  readonly wing: string
  /** The directory mined into it. */
  readonly dir: string
  /** What a hit from this wing is, for `RecallHit.source`. */
  readonly source: RecallSource
}

export interface MemPalaceOptions {
  /** Where the palace lives — `~/.ephesus/index/` (SDD §2). */
  readonly palaceRoot: string
  /** `agora/` — wings are derived from what is under it. */
  readonly agoraRoot: string
  /** The executable. Overridable so tests can drive a scripted fake CLI. */
  readonly command?: string
  /** Arguments before MemPalace's own — how a fake CLI is pointed at a script. */
  readonly commandArgs?: readonly string[]
  readonly timeoutMs?: number
  /** Reported for every visible degradation (invariant §7). */
  onDegraded?(detail: string): void
}

/** One subprocess result. Never throws; a failure is a value. */
interface RunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly error: string | null
}

export class MemPalaceIndex implements RecallIndex {
  readonly rung: RecallRung = 'mempalace'
  private version: string | null = null
  private because = 'not probed yet'
  /** Wing name → what was mined into it, for turning a hit back into a path. */
  private readonly wings = new Map<string, MemPalaceWing>()
  /** ref → the stat facts it was last mined at (ADR-0006's mtime gate). */
  private readonly mined = new Map<string, { mtimeMs: number; size: number }>()

  constructor(private readonly options: MemPalaceOptions) {}

  /** The command the Architect is offered when MemPalace is absent (FR-1.6). */
  installCommand(): readonly string[] {
    return MEMPALACE_INSTALL
  }

  available(): boolean {
    return this.version !== null
  }

  unavailableBecause(): string {
    return this.because
  }

  /** The version this probe found, or null. Shown beside the ladder state. */
  versionFound(): string | null {
    return this.version
  }

  /**
   * The version probe (ADR-0016 §4). Idempotent and safe to re-run — the
   * Architect re-runs it after accepting the install offer.
   *
   * Contract: never throws. A missing binary, a binary that errors, and a
   * binary whose output does not name a version are the same answer —
   * unavailable, with a reason that names the install command.
   */
  async probe(): Promise<{ readonly version: string | null; readonly because: string }> {
    const result = await this.run(['--version'], PROBE_TIMEOUT_MS)
    const version = VERSION_LINE.exec(`${result.stdout}\n${result.stderr}`)?.[1] ?? null
    this.version = version
    this.because =
      version !== null
        ? 'available'
        : `MemPalace not available (${result.error ?? 'no version in its output'}) — ` +
          `install it with: ${MEMPALACE_INSTALL.join(' ')}`
    return { version, because: this.because }
  }

  /**
   * Mines the corpus into the palace, one wing per agent plus the shelf
   * (ADR-0016 §2).
   *
   * Contract: mtime-gated. MemPalace skips already-filed files itself, but a
   * `mine` still costs a process start and an embedding pass, so a wing whose
   * documents are all unchanged is not invoked at all.
   */
  async sync(docs: readonly IndexableDoc[]): Promise<IndexSyncReport> {
    if (!this.available()) return { mined: 0, skipped: 0, removed: 0 }

    const byWing = new Map<string, IndexableDoc[]>()
    this.wings.clear()
    for (const doc of docs) {
      const wing = this.wingFor(doc)
      this.wings.set(wing.wing, wing)
      const bucket = byWing.get(wing.wing)
      if (bucket) bucket.push(doc)
      else byWing.set(wing.wing, [doc])
    }

    let mined = 0
    let skipped = 0
    const live = new Set(docs.map((doc) => doc.ref))
    for (const [wingName, wingDocs] of [...byWing].sort(([a], [b]) => a.localeCompare(b))) {
      const changed = wingDocs.filter((doc) => {
        const state = this.mined.get(doc.ref)
        return !state || state.mtimeMs !== doc.mtimeMs || state.size !== doc.size
      })
      if (changed.length === 0) {
        skipped += wingDocs.length
        continue
      }
      const wing = this.wings.get(wingName)
      if (!wing) continue
      const result = await this.run([
        'mine',
        wing.dir,
        '--wing',
        wingName,
        '--agent',
        'ephesus',
        // The gitignore default is right for the Agora (nothing under
        // agents/ is ignored) and wrong to override blindly.
        '--limit',
        '0'
      ])
      if (!result.ok) {
        this.options.onDegraded?.(
          `mempalace: mining wing "${wingName}" failed — ${result.error ?? result.stderr.trim()}`
        )
        continue
      }
      mined += changed.length
      skipped += wingDocs.length - changed.length
      for (const doc of changed) this.mined.set(doc.ref, { mtimeMs: doc.mtimeMs, size: doc.size })
    }

    // A drawer whose source file is gone is MemPalace's `sync` to prune, but
    // this driver's own gate must forget it too or the file would look mined
    // forever if it came back unchanged.
    let removed = 0
    for (const ref of [...this.mined.keys()]) {
      if (!live.has(ref)) {
        this.mined.delete(ref)
        removed += 1
      }
    }
    if (removed > 0) {
      const pruned = await this.run(['sync'])
      if (!pruned.ok) {
        this.options.onDegraded?.(
          `mempalace: pruning removed drawers failed — ${pruned.error ?? pruned.stderr.trim()}`
        )
      }
    }
    return { mined, skipped, removed }
  }

  /**
   * Scoped semantic search (ADR-0016 §4), behind the same surface every rung
   * shares.
   *
   * Contract: null when this rung could not answer — which sends the Library
   * one rung down, visibly. An empty array means MemPalace answered and found
   * nothing, which is a different fact and must not be conflated.
   */
  async search(
    query: string,
    scope: string | null,
    limit: number
  ): Promise<readonly RecallHit[] | null> {
    if (!this.available()) return null
    const args = ['search', query, '--results', String(Math.min(limit, RECALL_MAX_LIMIT))]
    // A scope naming a wing is pushed down into MemPalace's own scoping; a
    // corpus-level scope (`memory`, `knowledge`) is filtered on the way out,
    // because it spans wings.
    if (scope !== null && this.wings.has(scope)) args.push('--wing', scope)
    const result = await this.run(args)
    if (!result.ok) {
      this.options.onDegraded?.(
        `mempalace: search failed — ${(result.error ?? result.stderr.trim()) || 'no output'}`
      )
      return null
    }
    const hits = this.parseSearch(result.stdout, limit, recallTerms(query))
    if (hits === null) {
      this.options.onDegraded?.('mempalace: could not read its search output (format drift?)')
      return null
    }
    return scope === null || this.wings.has(scope)
      ? hits
      : hits.filter((hit) => hit.source === scope || hit.scope === scope)
  }

  /**
   * Reads MemPalace's search output.
   *
   * Contract: null when the output does not look like a result list at all —
   * a drifted CLI must degrade the rung, not silently answer "nothing known".
   * A well-formed header with no results is an empty array.
   *
   * `terms` are the query's words, used only to window the snippet; a semantic
   * hit may legitimately contain none of them, and then the head of the drawer
   * is what an agent gets.
   */
  private parseSearch(
    stdout: string,
    limit: number,
    terms: readonly string[]
  ): readonly RecallHit[] | null {
    if (!/Results for:/i.test(stdout)) return null
    const lines = stdout.split('\n')
    const hits: RecallHit[] = []
    let current: { wing: string; room: string; source: string; score: number } | null = null
    let body: string[] = []

    const flush = (): void => {
      if (!current) return
      const text = dedent(body).trim()
      if (text.length > 0) {
        const wing = this.wings.get(current.wing)
        hits.push({
          // MemPalace reports the file's name, not its path; the wing knows the
          // directory it was mined from, so the ref is rebuilt rather than
          // handed back as a bare basename nobody can open.
          ref: wing ? path.join(wing.dir, current.source) : current.source,
          source: wing?.source ?? 'knowledge',
          scope: current.wing,
          title: current.room,
          // MemPalace files whole documents as drawers, so its match body is a
          // whole file where the keyword rungs return one passage. Bounding it
          // the same way keeps a recall answer an answer rather than a file
          // dump — and windows it around whichever query words do appear.
          snippet: snippetOf(text, terms),
          // cosine similarity is 0..1 and higher-is-better, which is already
          // recall's contract; ×100 puts it on the same order as the keyword
          // rungs' scores so a reader is not misled by the magnitude.
          score: current.score * 100
        })
      }
      current = null
      body = []
    }

    for (const line of lines) {
      const header = /^\s*\[\d+\]\s+(.+?)\s+\/\s+(.+?)\s*$/.exec(line)
      if (header) {
        flush()
        current = { wing: header[1] ?? '', room: header[2] ?? '', source: '', score: 0 }
        continue
      }
      if (!current) continue
      const source = /^\s*Source:\s*(.+?)\s*$/.exec(line)
      if (source) {
        current = { ...current, source: source[1] ?? '' }
        continue
      }
      const match = /cosine_sim=([\d.]+)/.exec(line)
      if (match) {
        current = { ...current, score: Number.parseFloat(match[1] ?? '0') }
        continue
      }
      if (/^\s*-{10,}\s*$/.test(line) || /^\s*={10,}\s*$/.test(line)) {
        flush()
        continue
      }
      if (/^\s*Match:/.test(line) || /^\s*Wing:/.test(line)) continue
      body.push(line)
    }
    flush()
    return hits.slice(0, limit)
  }

  /** ADR-0016 §2: one wing per agent, one for the shelf. */
  private wingFor(doc: IndexableDoc): MemPalaceWing {
    if (doc.source === 'knowledge') {
      return {
        wing: 'knowledge',
        dir: path.join(this.options.agoraRoot, 'knowledge'),
        source: 'knowledge'
      }
    }
    return {
      wing: doc.scope,
      dir: path.join(this.options.agoraRoot, 'agents', doc.scope),
      source: doc.source
    }
  }

  /** One MemPalace invocation. Contract: never throws; a failure is a value. */
  private run(args: readonly string[], timeoutMs?: number): Promise<RunResult> {
    const command = this.options.command ?? MEMPALACE_BINARY
    const argv = [
      ...(this.options.commandArgs ?? []),
      // `--palace` is global in MemPalace's CLI and must precede the
      // subcommand; putting it after is a usage error, not a no-op.
      '--palace',
      this.options.palaceRoot,
      ...args
    ]
    return new Promise((resolve) => {
      execFile(
        command,
        argv,
        {
          timeout: timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            // ADR-0016's consequence, on every invocation rather than once in a
            // config file the Architect might edit: one writer path, no daemon.
            MEMPALACE_HOOKS_AUTO_SAVE: '0',
            MEMPALACE_HOOKS_DAEMON: '0'
          }
        },
        (err, stdout, stderr) => {
          resolve({
            ok: err === null,
            stdout: String(stdout),
            stderr: String(stderr),
            error: err === null ? null : err.message.split('\n')[0] || err.message
          })
        }
      )
    })
  }
}

/** Removes the common leading indentation MemPalace prints its bodies with. */
function dedent(lines: readonly string[]): string {
  const meaningful = lines.filter((line) => line.trim().length > 0)
  if (meaningful.length === 0) return ''
  const indent = Math.min(...meaningful.map((line) => /^\s*/.exec(line)?.[0].length ?? 0))
  return lines.map((line) => line.slice(indent)).join('\n')
}
