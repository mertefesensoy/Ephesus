import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsx'
import {
  DECK_SECTIONS,
  deckFileName,
  escapeHtml,
  parseDeckFiling,
  taskOfDeckFile,
  type DeckRecord
} from '../shared/odeon'
import type { Message } from '../shared/message'
import type { Task } from '../shared/tasks'
import type { PromptStore } from './prompts'

/**
 * The Odeon's archive (ADR-0008, FR-7.2, SDD §2).
 *
 * Two rules define this module, and both are structural rather than polite:
 *
 * 1. **Agents never write `odeon/`.** They file from their own outbox; this is
 *    the only writer. So an artifact cannot be back-dated or edited after the
 *    Architect has read it.
 * 2. **The archive is append-only** (invariant §5). A revised deck is a new
 *    file at a new timestamped name. Nothing here ever opens an existing
 *    artifact for writing, and `fileDeck` refuses a name that already exists
 *    rather than replacing it.
 *
 * What it does NOT do is decide anything. Whether a deck is any good is the
 * Architect's call in the viewer; whether a task may close is the ledger's
 * guard. This module validates, renders the standard template, writes, and
 * says what it wrote.
 */

const DECK_TEMPLATE = path.join('odeon', 'deck.html')

export interface OdeonOptions {
  /** The Agora repo root; `odeon/` lives inside it (SDD §2). */
  readonly agoraRoot: string
  /** Invariant §8: the deck template is config, never a literal here. */
  readonly prompts: PromptStore
  /** The task this deck claims, as the ledger has it — or null if unknown. */
  task(taskId: string): Task | null
  /** Records `artifacts.deck`; the ledger endpoint owns `tasks.json`. */
  recordDeck(taskId: string, deckRef: string): void
  /** `log` kind `deck` (SDD §4.3). */
  onLogEvent?(draft: { kind: 'deck' } & Record<string, unknown>): void
  /** Queued through the single committer (ADR-0004), never awaited. */
  commitSoon?(subject: string): void
  now?(): Date
}

export type FileDeckOutcome =
  | { readonly ok: true; readonly ref: string; readonly taskId: string }
  | { readonly ok: false; readonly reasons: readonly string[] }

export class Odeon {
  private readonly now: () => Date

  constructor(private readonly options: OdeonOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** `<agora>/odeon/decks`, created on demand. */
  private decksDir(): string {
    return path.join(this.options.agoraRoot, 'odeon', 'decks')
  }

  /**
   * Archives one deck filed by an agent.
   *
   * Contract: all-or-nothing, and every refusal names every reason at once so
   * the agent can fix them in one pass (the ledger endpoint's contract, for the
   * same reason — a refusal is the only feedback a filing agent gets).
   *
   * The authorship check is here rather than in the router because it is a
   * LEDGER fact: only the task's assignee may discharge its review obligation.
   * ADR-0003 keeps the router to transport rules, and the router does not read
   * `tasks.json`.
   */
  fileDeck(message: Message): FileDeckOutcome {
    const parsed = parseDeckFiling(message.body)
    if (!parsed.ok) return this.refuse(message, [parsed.reason])
    const filing = parsed.filing

    const task = this.options.task(filing.taskId)
    const reasons: string[] = []
    if (task === null) {
      reasons.push(`no task "${filing.taskId}" in the ledger`)
    } else {
      if (task.assignee !== message.from) {
        reasons.push(
          `task ${filing.taskId} is assigned to ${task.assignee ?? 'nobody'}; ` +
            `"${message.from}" may not file its deck`
        )
      }
      if (!task.review.includes('deck')) {
        // Filing a deck for a task that never asked for one would let an agent
        // manufacture an artifact the ledger then treats as an obligation met.
        reasons.push(`task ${filing.taskId} does not carry a "deck" review obligation`)
      }
    }
    if (reasons.length > 0) return this.refuse(message, reasons)

    const at = this.now()
    const dir = this.decksDir()
    fs.mkdirSync(dir, { recursive: true })
    const name = deckFileName(filing.taskId, at)
    const file = path.join(dir, name)
    if (fs.existsSync(file)) {
      // Append-only means the archive never loses a version. Two filings in the
      // same millisecond is the only way here, and refusing is the safe
      // direction: the agent retries and gets its own name.
      return this.refuse(message, [`a deck is already archived at ${name}`])
    }

    // The agent supplied the content; the harness supplies the template. Every
    // section is escaped: a deck is agent-authored text opened in a webview,
    // and a failing test's output containing markup must render, not execute.
    const html = this.options.prompts.render(DECK_TEMPLATE, {
      title: escapeHtml(filing.title),
      taskId: escapeHtml(filing.taskId),
      author: escapeHtml(message.from),
      generatedAt: at.toISOString(),
      ...Object.fromEntries(
        DECK_SECTIONS.map((section) => [section, escapeHtml(filing.sections[section])])
      )
    })
    writeFileAtomic(file, html)

    const ref = path.posix.join('odeon', 'decks', name)
    this.options.recordDeck(filing.taskId, ref)
    this.options.onLogEvent?.({
      kind: 'deck',
      event: 'archived',
      taskId: filing.taskId,
      deckRef: ref,
      by: message.from,
      msgId: message.id,
      bytes: Buffer.byteLength(html)
    })
    this.options.commitSoon?.(`odeon: deck for ${filing.taskId}`)
    return { ok: true, ref, taskId: filing.taskId }
  }

  /**
   * Every archived deck, newest first (SDD §5 `odeon:decks`).
   *
   * Read off the directory rather than from a manifest: the files ARE the
   * record, and a manifest would be a second copy that could disagree with it.
   */
  decks(): readonly DeckRecord[] {
    const dir = this.decksDir()
    if (!fs.existsSync(dir)) return []
    const records: DeckRecord[] = []
    for (const name of fs.readdirSync(dir)) {
      const taskId = taskOfDeckFile(name)
      if (taskId === null) continue
      const stat = fs.statSync(path.join(dir, name))
      records.push({
        ref: path.posix.join('odeon', 'decks', name),
        taskId,
        archivedAt: stat.mtime.toISOString(),
        bytes: stat.size
      })
    }
    return records.sort((a, b) => b.ref.localeCompare(a.ref))
  }

  /** One deck's HTML, for the viewer. Null when the ref names nothing. */
  read(ref: string): string | null {
    const name = path.posix.basename(ref)
    // The ref comes from the renderer, so it is untrusted: only a well-formed
    // deck file name resolves, and never a path that climbs out of the archive.
    if (taskOfDeckFile(name) === null) return null
    const file = path.join(this.decksDir(), name)
    if (!fs.existsSync(file)) return null
    return fs.readFileSync(file, 'utf8')
  }

  private refuse(message: Message, reasons: readonly string[]): FileDeckOutcome {
    this.options.onLogEvent?.({
      kind: 'deck',
      event: 'refused',
      by: message.from,
      msgId: message.id,
      reasons: [...reasons]
    })
    return { ok: false, reasons }
  }
}
