import { z } from 'zod'
import { taskIdSchema } from './tasks'

/**
 * The Odeon's filing protocol (ADR-0008, FR-7.2, SDD §2).
 *
 * Accountability is *mechanism-enforced*, and the mechanism has a shape worth
 * stating plainly: **agents never write `odeon/`.** SDD §2 gives that directory
 * to the harness alone. An agent files an artifact the only way it can say
 * anything — a message from its own outbox, addressed to the Odeon endpoint —
 * and the harness archives it. So a deck cannot be back-dated, edited in place,
 * or written for a task its author was not given.
 *
 * The split inside a deck follows the same reasoning the briefing compiler uses
 * (SDD §7.2): the agent supplies the CONTENT, the harness supplies the
 * TEMPLATE. FR-7.2 requires "an HTML slide deck from the standard template",
 * and the only way "from the standard template" can be enforced rather than
 * hoped for is for the harness to be the one that applies it. It also keeps the
 * template where invariant §8 puts every other word an agent's work is dressed
 * in: `prompts/odeon/`, never a string literal here.
 */

export const ODEON_SCHEMA_VERSION = 1

/**
 * One archived deck, as the viewer lists them. Lives here rather than beside
 * the archive because the renderer needs the type and may not import main.
 */
/**
 * What filing a review comment did. A comment that reached nobody must say so:
 * an Architect who typed a comment into a company with no orchestrator has to
 * learn that here, not discover it missing later (invariant §7).
 */
export type DeckCommentOutcome =
  | { readonly queued: true; readonly to: string }
  | { readonly queued: false; readonly because: string }

/**
 * One memo as the queue surface shows it. The markdown is the archived
 * artifact itself, so the panel can never show a memo that differs from the
 * one on disk.
 */
export interface MemoQueueRow {
  readonly memoId: string
  readonly markdown: string
  readonly decided: boolean
  readonly verdict: string | null
  readonly decidedBy: string | null
  readonly countersigned: boolean
}

/** What recording a verdict did. */
export type MemoDecided =
  | { readonly ok: true; readonly gateVerdict: string }
  | { readonly ok: false; readonly reason: string }

/** The live meeting as the panel sees it (FR-7.4). */
export interface MeetingView {
  readonly id: string
  readonly agenda: string
  readonly attendees: readonly string[]
  /** Who may speak now — the one thing the driver owns. */
  readonly floor: string | null
  readonly transcript: readonly { from: string; text: string; at: string }[]
  /** Said early, waiting for the floor. Shown, so nothing looks lost. */
  readonly held: readonly { from: string; text: string; at: string }[]
  readonly status: 'open' | 'closed'
}

/** One action item a meeting produced. */
export interface MeetingAction {
  readonly title: string
  readonly assignee: string
  readonly spec: string
}

export type ConveneOutcome =
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string }

export type MeetingSaid = {
  readonly kind: 'accepted' | 'held' | 'refused'
  readonly reason?: string
}

export type MeetingClosed =
  { readonly ok: true; readonly ref: string } | { readonly ok: false; readonly reason: string }

/** One archived brief, as the Briefs tab lists them. */
export interface BriefRecord {
  readonly ref: string
  readonly archivedAt: string
  readonly markdown: string
}

export interface DeckRecord {
  readonly ref: string
  readonly taskId: string
  readonly archivedAt: string
  readonly bytes: number
}

/**
 * The six sections FR-7.2 names, in the order they are presented. Order is part
 * of the contract: a reviewer reads decks from many agents and should not have
 * to hunt for the trade-offs.
 */
export const DECK_SECTIONS = [
  'goal',
  'built',
  'decisions',
  'tradeOffs',
  'evidence',
  'openQuestions'
] as const

export type DeckSection = (typeof DECK_SECTIONS)[number]

/** Human-facing labels live in the template; this is the machine ordering. */
const sectionShape = Object.fromEntries(
  DECK_SECTIONS.map((section) => [section, z.string().min(1).max(50_000)])
) as Record<DeckSection, z.ZodString>

export const deckFilingSchema = z
  .object({
    schemaVersion: z.literal(ODEON_SCHEMA_VERSION),
    kind: z.literal('deck'),
    /** The task this deck discharges. A deck with no task closes nothing. */
    taskId: taskIdSchema,
    title: z.string().min(1).max(200),
    sections: z.object(sectionShape).strict()
  })
  .strict()

export type DeckFiling = z.infer<typeof deckFilingSchema>

export type DeckParse =
  | { readonly ok: true; readonly filing: DeckFiling }
  | { readonly ok: false; readonly reason: string }

/**
 * Contract: parses a filing, or explains why it could not. Never throws, and
 * never repairs — an agent that filed half a deck is told which half, because
 * the refusal is the only feedback it gets (the same contract the ledger
 * endpoint's parser has).
 *
 * A missing section is a *refusal*, not a blank slide: FR-7.2 lists six
 * sections, and a deck that quietly omitted "trade-offs" would satisfy the
 * close gate while defeating the reason the gate exists.
 */
export function parseDeckFiling(body: string): DeckParse {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (err) {
    return { ok: false, reason: `deck: body is not JSON — ${reason(err)}` }
  }
  const parsed = deckFilingSchema.safeParse(raw)
  if (parsed.success) return { ok: true, filing: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'deck'
  return { ok: false, reason: `${where}: ${issue?.message ?? 'invalid deck filing'}` }
}

/**
 * Contract: the archive file name for a deck — SDD §2's
 * `odeon/decks/<taskId>-<ts>.html`.
 *
 * The timestamp is what makes the archive append-only in practice: a second
 * deck for the same task is a NEW file at a NEW name, so revising a deck adds
 * to the record instead of destroying the version the Architect already read
 * (invariant §5). Colons are stripped because they are illegal in Windows file
 * names, and the result stays time-sortable.
 */
export function deckFileName(taskId: string, at: Date): string {
  return `${taskId}-${at.toISOString().replace(/[:.]/g, '-')}.html`
}

/** Contract: the task a deck file belongs to, or null if the name is foreign. */
export function taskOfDeckFile(fileName: string): string | null {
  const match = /^(t-[a-z0-9-]+?)-(\d{4}-\d{2}-\d{2}T[\dZ-]+)\.html$/.exec(fileName)
  return match?.[1] ?? null
}

/**
 * Contract: `text` rendered safe for HTML body content.
 *
 * A deck is agent-authored content the Architect opens in a webview. Escaping
 * it is not politeness — an agent that pasted a failing test's output
 * containing `<script>` would otherwise get it executed in the reviewer's
 * window. The template is the only HTML; everything filled into it is text.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
