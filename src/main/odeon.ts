import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './fsx'
import {
  DECK_SECTIONS,
  deckFileName,
  escapeHtml,
  parseDeckFiling,
  taskOfDeckFile,
  type BriefRecord,
  type DeckCommentOutcome,
  type DeckRecord
} from '../shared/odeon'
import {
  checkNarrative,
  parseBriefFiling,
  renderBriefMarkdown,
  type BriefFact
} from '../shared/brief'
import {
  gateVerdictFor,
  MEMO_SCHEMA_VERSION,
  memoVerdictSchema,
  parseMemoFiling,
  parseMemoHeader,
  renderMemoMarkdown,
  type MemoFiling,
  type MemoHeader,
  type MemoTrigger,
  type MemoVerdict,
  type MemoVerdictName
} from '../shared/memo'
import { composeMessage, makeMessageId, type Message } from '../shared/message'
import { ODEON_ENDPOINT } from '../shared/reserved'
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
  /** The open gate a memo answers, so a filing cannot claim somebody else’s. */
  gate?(
    gateId: string
  ): { readonly agentId: string; readonly memoTrigger: MemoTrigger | null } | null
  /** `log` kinds `deck`, `memo` and `brief` (SDD §4.3). */
  onLogEvent?(draft: { kind: 'deck' | 'memo' | 'brief' } & Record<string, unknown>): void
  /** Queued through the single committer (ADR-0004), never awaited. */
  commitSoon?(subject: string): void
  now?(): Date
}

export type FileDeckOutcome =
  | { readonly ok: true; readonly ref: string; readonly taskId: string }
  | { readonly ok: false; readonly reasons: readonly string[] }

export type FileBriefOutcome =
  | {
      readonly ok: true
      readonly ref: string
      readonly briefId: string
      readonly spokenSeconds: number
    }
  | { readonly ok: false; readonly reasons: readonly string[] }

/** Who settled a memo, and under what. */
export type MemoDecider =
  | { readonly kind: 'architect' }
  | { readonly kind: 'orchestrator'; readonly agentId: string; readonly under: string }

export type DecideOutcome =
  | {
      readonly ok: true
      readonly gateId: string
      readonly gateVerdict: 'approved' | 'denied'
      readonly trigger: MemoTrigger
      readonly taskId: string | null
    }
  | { readonly ok: false; readonly reason: string }

export type FileMemoOutcome =
  | { readonly ok: true; readonly memoId: string; readonly filing: MemoFiling }
  | { readonly ok: false; readonly reasons: readonly string[] }

export type VerdictOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export type MemoQueue = 'open' | 'decided' | 'all'

/** One archived memo and its verdict, as the queue lists them. */
export interface MemoRecord {
  readonly memoId: string
  readonly markdown: string
  readonly verdict: MemoVerdict | null
}

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

  /**
   * Turns an Architect review comment into mail for the orchestrator
   * (UC-05 step 4).
   *
   * Contract: it does NOT create a task. FR-5.2 gives the ledger to Artemis,
   * and a harness that minted its own follow-up task would be deciding what
   * work the company does — the one thing ADR-0005 keeps out of the harness.
   * The comment goes to her as a `request`; what it becomes is her judgment.
   *
   * A comment that can reach nobody says so rather than vanishing: an
   * Architect who typed into a company with no orchestrator has to learn it
   * here (invariant §7).
   */
  comment(
    ref: string,
    text: string,
    orchestratorId: string | null
  ): DeckCommentOutcome & { readonly message?: Message } {
    if (orchestratorId === null) {
      return { queued: false, because: 'no orchestrator is hired to receive it' }
    }
    const record = this.decks().find((deck) => deck.ref === ref)
    if (record === undefined) return { queued: false, because: `no archived deck at ${ref}` }

    const vars = { ref, taskId: record.taskId, comment: text }
    const message = composeMessage({
      id: makeMessageId(this.now(), `cmt${randomBytes(3).toString('hex')}`),
      conversation: `conv-deck-${record.taskId}`,
      in_reply_to: null,
      // The Architect wrote it, but §4.4 puts `human` in the ADDRESS domain
      // only — `from` must be an agent id. So the Odeon relays it and signs as
      // itself, the same reserved-identity answer M3 gave the router's bounce
      // (which used to claim `from: <the original sender>` for a message the
      // sender never wrote). The template says whose comment it is.
      from: ODEON_ENDPOINT,
      to: orchestratorId,
      act: 'request',
      subject: this.options.prompts
        .render(path.join('odeon', 'deck-comment-subject.md'), vars)
        .trim()
        .slice(0, 200),
      body: this.options.prompts.render(path.join('odeon', 'deck-comment.md'), vars).trim(),
      hops: 0,
      created_at: this.now().toISOString()
    })
    this.options.onLogEvent?.({
      kind: 'deck',
      event: 'commented',
      taskId: record.taskId,
      deckRef: ref,
      to: orchestratorId,
      msgId: message.id
    })
    return { queued: true, to: orchestratorId, message }
  }

  /**
   * Archives one memo filed by an agent (ADR-0008 §3, FR-7.3, SDD §4.5).
   *
   * Contract: all-or-nothing, every refusal named at once. The memo must
   * answer a gate that is actually open and that actually held THIS agent’s
   * action — otherwise an agent could file against somebody else’s hold and
   * have a verdict on it release work it never owned.
   *
   * The memo is archived the moment it is filed, before any verdict exists.
   * That is deliberate: ADR-0008 calls rejected memos part of the training
   * substrate, so a memo the Architect turns down must still be a permanent
   * record rather than a file that only survives approval.
   */
  fileMemo(message: Message): FileMemoOutcome {
    const parsed = parseMemoFiling(message.body)
    if (!parsed.ok) return this.refuseMemo(message, [parsed.reason])
    const filing = parsed.filing

    const gate = this.options.gate?.(filing.gateId) ?? null
    const reasons: string[] = []
    if (gate === null) {
      reasons.push(`no open gate "${filing.gateId}" to answer`)
    } else {
      if (gate.agentId !== message.from) {
        reasons.push(`gate ${filing.gateId} holds ${gate.agentId}, not "${message.from}"`)
      }
      if (gate.memoTrigger === null) {
        reasons.push(`gate ${filing.gateId} is not waiting on a memo`)
      } else if (gate.memoTrigger !== filing.trigger) {
        reasons.push(
          `gate ${filing.gateId} was held for ${gate.memoTrigger}, not ${filing.trigger}`
        )
      }
    }
    if (reasons.length > 0) return this.refuseMemo(message, reasons)

    const at = this.now()
    const memoId = this.mintMemoId(at)
    const dir = path.join(this.memosDir(), memoId)
    if (fs.existsSync(dir)) return this.refuseMemo(message, [`a memo already exists at ${memoId}`])
    fs.mkdirSync(dir, { recursive: true })
    writeFileAtomic(path.join(dir, 'memo.md'), renderMemoMarkdown(memoId, filing, at.toISOString()))

    this.options.onLogEvent?.({
      kind: 'memo',
      event: 'filed',
      memoId,
      trigger: filing.trigger,
      gateId: filing.gateId,
      taskId: filing.taskId,
      by: message.from,
      msgId: message.id
    })
    this.options.commitSoon?.(`odeon: memo ${memoId} filed`)
    return { ok: true, memoId, filing }
  }

  /**
   * Records a verdict on a filed memo (SDD §4.5’s `verdict.json`).
   *
   * Contract: a memo gets exactly ONE verdict. The archive is immutable
   * (invariant §5), and a memo that could be re-decided would let an approval
   * be quietly replaced after the action it released had already run.
   *
   * The schema refuses a delegated verdict carrying no countersignature and no
   * named grant, so FR-5.5 is enforced by the validator rather than by the
   * caller remembering to.
   */
  recordVerdict(verdict: MemoVerdict): VerdictOutcome {
    const dir = path.join(this.memosDir(), verdict.memoId)
    if (!fs.existsSync(path.join(dir, 'memo.md'))) {
      return { ok: false, reason: `no memo "${verdict.memoId}" is on file` }
    }
    const file = path.join(dir, 'verdict.json')
    if (fs.existsSync(file)) {
      return { ok: false, reason: `memo ${verdict.memoId} already carries a verdict` }
    }
    const parsed = memoVerdictSchema.safeParse(verdict)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return { ok: false, reason: issue?.message ?? 'invalid verdict' }
    }
    writeFileAtomic(file, `${JSON.stringify(parsed.data, null, 2)}\n`)
    this.options.onLogEvent?.({
      kind: 'memo',
      event: 'decided',
      memoId: verdict.memoId,
      trigger: verdict.trigger,
      verdict: verdict.verdict,
      decidedBy: verdict.decidedBy,
      countersigned: verdict.countersigned,
      authority: verdict.authority,
      taskId: verdict.taskId
    })
    this.options.commitSoon?.(`odeon: memo ${verdict.memoId} ${verdict.verdict}`)
    return { ok: true }
  }

  /**
   * The memo queue (SDD §5 `odeon:memos(queue)`), newest first.
   *
   * Read off the directory for the same reason `decks()` is: the files are the
   * record, and a manifest would be a second copy that could disagree with it.
   */
  memos(queue: MemoQueue = 'all'): readonly MemoRecord[] {
    const dir = this.memosDir()
    if (!fs.existsSync(dir)) return []
    const records: MemoRecord[] = []
    for (const memoId of fs.readdirSync(dir)) {
      const body = path.join(dir, memoId, 'memo.md')
      if (!fs.existsSync(body)) continue
      const verdictFile = path.join(dir, memoId, 'verdict.json')
      const decided = fs.existsSync(verdictFile)
      if (queue === 'open' && decided) continue
      if (queue === 'decided' && !decided) continue
      const parsed = decided
        ? memoVerdictSchema.safeParse(JSON.parse(fs.readFileSync(verdictFile, 'utf8')))
        : null
      records.push({
        memoId,
        markdown: fs.readFileSync(body, 'utf8'),
        verdict: parsed?.success === true ? parsed.data : null
      })
    }
    return records.sort((a, b) => b.memoId.localeCompare(a.memoId))
  }

  /**
   * Settles a filed memo, from either bench (FR-7.3, UC-06 step 4).
   *
   * Contract: the harness fills `decidedBy`, `countersigned` and `authority`
   * from what it knows — never from what the decider claimed. An orchestrator
   * that could write its own countersignature could grant itself authority it
   * was never given, which is the widening FR-5.5 exists to prevent.
   *
   * Returns the gate the verdict settles and how, so the caller can release or
   * refuse the held action without re-deriving either.
   */
  decideMemo(input: {
    readonly memoId: string
    readonly verdict: MemoVerdictName
    readonly notes: string
    readonly decider: MemoDecider
  }): DecideOutcome {
    const header = this.headerOf(input.memoId)
    if (header === null) {
      return { ok: false, reason: `no memo "${input.memoId}" is on file` }
    }
    const recorded = this.recordVerdict({
      schemaVersion: MEMO_SCHEMA_VERSION,
      memoId: header.memoId,
      trigger: header.trigger,
      verdict: input.verdict,
      decidedBy: input.decider.kind === 'architect' ? 'architect' : input.decider.agentId,
      countersigned: input.decider.kind === 'orchestrator',
      authority: input.decider.kind === 'orchestrator' ? input.decider.under : null,
      notes: input.notes,
      decidedAt: this.now().toISOString(),
      taskId: header.taskId
    })
    if (!recorded.ok) return recorded
    return {
      ok: true,
      gateId: header.gateId,
      gateVerdict: gateVerdictFor(input.verdict),
      trigger: header.trigger,
      taskId: header.taskId
    }
  }

  /** The header of one filed memo, or null when it is not on file. */
  headerOf(memoId: string): MemoHeader | null {
    const body = path.join(this.memosDir(), memoId, 'memo.md')
    if (!fs.existsSync(body)) return null
    return parseMemoHeader(fs.readFileSync(body, 'utf8'))
  }

  /** One memo’s markdown, for the queue UI and the triage message. */
  memoBody(memoId: string): string | null {
    const body = path.join(this.memosDir(), memoId, 'memo.md')
    return fs.existsSync(body) ? fs.readFileSync(body, 'utf8') : null
  }

  /**
   * Archives one narrated brief (ADR-0008 §1, FR-7.1, SDD §2).
   *
   * Contract: the narration is checked against the facts the compiler issued
   * BEFORE anything is written. A brief whose sentences cite nothing, or cite
   * something no fact supports, is refused — that check is the only thing
   * standing between "compiled strictly from Agora data" and an instruction
   * nobody can audit.
   *
   * The facts are supplied by the caller rather than re-derived here, because
   * they must be the SAME set the narrator was given: re-deriving them would
   * check the prose against a window that had moved on since.
   */
  fileBrief(
    message: Message,
    facts: readonly BriefFact[],
    options: { readonly wpm?: number; readonly maxSeconds?: number } = {}
  ): FileBriefOutcome {
    const parsed = parseBriefFiling(message.body)
    if (!parsed.ok) return this.refuseBrief(message, [parsed.reason])
    const filing = parsed.filing

    const check = checkNarrative(filing, facts, options)
    if (!check.ok) return this.refuseBrief(message, check.reasons)

    const at = this.now()
    const dir = path.join(this.options.agoraRoot, 'odeon', 'briefs')
    fs.mkdirSync(dir, { recursive: true })
    const name = `${at.toISOString().replace(/[:.]/g, '-')}.md`
    const file = path.join(dir, name)
    if (fs.existsSync(file)) {
      return this.refuseBrief(message, [`a brief is already archived at ${name}`])
    }
    writeFileAtomic(file, renderBriefMarkdown(filing.briefId, filing, facts, at.toISOString()))

    const ref = path.posix.join('odeon', 'briefs', name)
    this.options.onLogEvent?.({
      kind: 'brief',
      event: 'archived',
      briefId: filing.briefId,
      briefRef: ref,
      by: message.from,
      msgId: message.id,
      sentences: filing.sentences.length,
      facts: facts.length,
      spokenSeconds: Math.round(check.spokenSeconds)
    })
    this.options.commitSoon?.(`odeon: brief ${filing.briefId}`)
    return { ok: true, ref, briefId: filing.briefId, spokenSeconds: check.spokenSeconds }
  }

  /** Every archived brief, newest first (SDD §5 `odeon:briefs`). */
  briefs(): readonly BriefRecord[] {
    const dir = path.join(this.options.agoraRoot, 'odeon', 'briefs')
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort((a, b) => b.localeCompare(a))
      .map((name) => ({
        ref: path.posix.join('odeon', 'briefs', name),
        archivedAt: name.replace(/\.md$/, ''),
        markdown: fs.readFileSync(path.join(dir, name), 'utf8')
      }))
  }

  private refuseBrief(message: Message, reasons: readonly string[]): FileBriefOutcome {
    this.options.onLogEvent?.({
      kind: 'brief',
      event: 'refused',
      by: message.from,
      msgId: message.id,
      reasons: [...reasons]
    })
    return { ok: false, reasons }
  }

  private memosDir(): string {
    return path.join(this.options.agoraRoot, 'odeon', 'memos')
  }

  /** `m-<time>-<random>`, so two memos in the same millisecond cannot collide. */
  private mintMemoId(at: Date): string {
    const stamp = at
      .toISOString()
      .toLowerCase()
      .replace(/[:.tz]/g, '-')
      .replace(/-+/g, '-')
      .replace(/-$/, '')
    return `m-${stamp}-${randomBytes(2).toString('hex')}`
  }

  private refuseMemo(message: Message, reasons: readonly string[]): FileMemoOutcome {
    this.options.onLogEvent?.({
      kind: 'memo',
      event: 'refused',
      by: message.from,
      msgId: message.id,
      reasons: [...reasons]
    })
    return { ok: false, reasons }
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
