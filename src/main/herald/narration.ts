import { BRIEF_MAX_SECONDS, BRIEF_WPM, spokenSeconds } from '../../shared/brief'
import type { MeetingView } from '../../shared/odeon'
import type { OpenGate } from '../../shared/gates'
import { checkRepeatBack, needsRepeatBack, repeatBackChallenge, repeatBackToken } from './policy'
import type { RepeatBackChallenge } from './policy'
import type { Phrasebook } from './phrasebook'
import type { HeraldSession } from './session'

/**
 * What the Herald says — FR-7.1, FR-8.4, VOICE-DESIGN §4–§5.
 *
 * **The Herald narrates records.** It reads the ARCHIVED brief artifact — the
 * same file the Briefs card shows — and speaks the sentences that are in it, in
 * the order they are in it. It does not compile, re-compile, summarise or
 * improve. That is not a style preference: `checkNarrative` (SDD §7.2) already
 * refused any sentence whose refs no fact supports, so the archive is the
 * artifact that PASSED that gate. A Herald that recompiled would be speaking
 * prose nothing had checked, and an invented sentence is the E-BRIEF-FAITH
 * failure that gates release.
 *
 * So the parser here reads the archive back out rather than taking a
 * `BriefFiling` — if it took the filing it could drift from what was written,
 * and nobody would notice until an audit read both.
 */

export interface SpokenSentence {
  readonly section: string
  readonly text: string
  readonly refs: readonly string[]
}

const SENTENCE = /^(.+?)\s*\[([^\]]*)\]\s*$/

/**
 * Contract: the sentences of an archived brief, parsed back out of the
 * artifact `renderBriefMarkdown` wrote.
 *
 * The `## Source refs` appendix is deliberately excluded: it is the audit trail
 * behind the narration, not part of it, and reading it aloud would double the
 * brief's length with material the Architect can see on the card.
 */
export function narrationOf(markdown: string): readonly SpokenSentence[] {
  const sentences: SpokenSentence[] = []
  let section: string | null = null
  for (const raw of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw)
    if (heading?.[1]) {
      const title = heading[1]
      section = title.toLowerCase() === 'source refs' ? null : title
      continue
    }
    if (section === null) continue
    const line = raw.trim()
    if (line === '' || line.startsWith('-') || line.startsWith('#')) continue
    const match = SENTENCE.exec(line)
    if (!match?.[1]) continue
    sentences.push({
      section,
      text: match[1].trim(),
      refs: (match[2] ?? '')
        .split(',')
        .map((ref) => ref.trim())
        .filter(Boolean)
    })
  }
  return sentences
}

export interface BriefNarration {
  readonly sentences: readonly SpokenSentence[]
  /** What the Herald actually said, in order. */
  readonly spoken: readonly string[]
  /** Estimated spoken length, against SRS §6.2's 90 s budget. */
  readonly seconds: number
  readonly withinBudget: boolean
  /** True when no provider carried it — text-only, and nothing lost (FR-8.6). */
  readonly textOnly: boolean
}

/**
 * Contract: reads an archived brief aloud, sentence by sentence, verbatim.
 *
 * Every string handed to the session comes from `narrationOf(markdown)`. There
 * is no path in this function by which a sentence not in the archive could be
 * spoken — which is the property the E-BRIEF-FAITH eval checks, made structural
 * rather than trusted.
 */
export async function speakBrief(
  session: HeraldSession,
  markdown: string,
  options: { readonly wpm?: number; readonly maxSeconds?: number } = {}
): Promise<BriefNarration> {
  const sentences = narrationOf(markdown)
  const spoken: string[] = []
  let anyAudio = false
  for (const sentence of sentences) {
    const result = await session.speak(sentence.text)
    spoken.push(sentence.text)
    if (result.spoken) anyAudio = true
  }
  const seconds = spokenSeconds(spoken.join(' '), options.wpm ?? BRIEF_WPM)
  return {
    sentences,
    spoken,
    seconds,
    withinBudget: seconds <= (options.maxSeconds ?? BRIEF_MAX_SECONDS),
    textOnly: !anyAudio
  }
}

// ── Voice approvals (FR-8.4) ────────────────────────────────────────────────

export interface VoiceApprovalAsk {
  /** The line the Herald says to request the approval. */
  readonly line: string
  /** The exact words that will count as a confirmation, or null. */
  readonly token: string | null
  /**
   * The issued repeat-back, or null when this gate needs none.
   *
   * The caller holds it between the ask and the answer, and passes it back to
   * `checkVoiceApproval`. That is the whole reason answering is single-use: the
   * check verifies the challenge that was ISSUED rather than re-deriving one,
   * so a replayed or lapsed answer has something to fail against.
   */
  readonly challenge: RepeatBackChallenge | null
}

/**
 * Contract: what the Herald asks before approving a gate by voice.
 *
 * The token is specific to the gate (`policy.repeatBackToken`); the sentence
 * comes from the phrase book (invariant §8). A gate that needs no repeat-back
 * still gets asked — it simply gets no token, and a plain answer settles it.
 */
export function voiceApprovalAsk(
  gate: OpenGate,
  phrasebook: Phrasebook,
  issue: { readonly nowMs: number; readonly nonce: string }
): VoiceApprovalAsk {
  if (!needsRepeatBack(gate.kind) && !gate.requiresRepeatBack) {
    return {
      line: phrasebook.line('approve-ask', { what: gate.packaging.what }),
      token: null,
      challenge: null
    }
  }
  const challenge = repeatBackChallenge(
    { kind: gate.kind, what: gate.packaging.what },
    issue.nowMs,
    issue.nonce
  )
  return {
    line: phrasebook.line('repeat-back', { what: gate.packaging.what, token: challenge.token }),
    token: challenge.token,
    challenge
  }
}

export type VoiceApproval =
  | {
      readonly ok: true
      readonly repeatBackConfirmed: boolean
      /** The nonce the caller marks spent, so the same answer cannot be replayed. */
      readonly nonce?: string
    }
  | { readonly ok: false; readonly line: string; readonly because: string }

/**
 * Contract: whether a spoken reply may approve this gate.
 *
 * It does not settle the gate — `GateManager.decide` does, with
 * `channel: 'voice'` and this function's `repeatBackConfirmed`. The Herald
 * holds no authority of its own (ADR-0007), so all it can do is report whether
 * the words it heard were the words the policy required.
 *
 * A refusal is not a denial. It comes back with the line to say and the reason,
 * and the gate stays open — "I could not confirm you meant it" and "no" are
 * different answers, which is the same distinction `GateManager` already makes.
 */
export function checkVoiceApproval(
  gate: OpenGate,
  spoken: string,
  phrasebook: Phrasebook,
  answering: {
    readonly challenge: RepeatBackChallenge | null
    readonly nowMs: number
    readonly spent?: ReadonlySet<string>
  }
): VoiceApproval {
  if (!needsRepeatBack(gate.kind) && !gate.requiresRepeatBack) {
    return { ok: true, repeatBackConfirmed: false }
  }
  // A gate that needs a repeat-back and was answered without one being issued
  // is refused, not waved through: "no challenge" must never read as "no
  // challenge required".
  if (answering.challenge === null) {
    return {
      ok: false,
      because: 'mismatch',
      line: phrasebook.line('repeat-back-refused-mismatch', {
        token: repeatBackToken({ kind: gate.kind, what: gate.packaging.what })
      })
    }
  }
  const check = checkRepeatBack(spoken, answering.challenge, answering.nowMs, answering.spent)
  if (check.confirmed) return { ok: true, repeatBackConfirmed: true, nonce: check.nonce }
  return {
    ok: false,
    because: check.because,
    line: phrasebook.line(
      check.because === 'bare-assent'
        ? 'repeat-back-refused-bare-assent'
        : 'repeat-back-refused-mismatch',
      { token: answering.challenge.token }
    )
  }
}

// ── Meeting narration (FR-7.4, VOICE-DESIGN §5) ─────────────────────────────

export interface MeetingLine {
  readonly text: string
  /** Chair announcements are always spoken; replies only on request (§5). */
  readonly always: boolean
}

/**
 * Contract: what the Herald says during a meeting.
 *
 * VOICE-DESIGN §5: "Herald announces the agenda and each speaker … reads
 * replies aloud (toggleable) … and closes by reading action items." The split
 * matters — a Herald that read every reply aloud unasked would make a meeting
 * unusable, so replies carry `always: false` and the caller decides.
 *
 * Every line is derived from the meeting RECORD. Nothing here summarises what
 * was said; the transcript's own words are read back.
 */
export function meetingLines(
  meeting: MeetingView,
  phrasebook: Phrasebook,
  options: { readonly readReplies?: boolean } = {}
): readonly MeetingLine[] {
  const lines: MeetingLine[] = [
    { text: phrasebook.line('meeting-open', { agenda: meeting.agenda }), always: true }
  ]
  if (meeting.floor) {
    lines.push({ text: phrasebook.line('meeting-floor', { who: meeting.floor }), always: true })
  }
  if (options.readReplies) {
    for (const turn of meeting.transcript) {
      // The speaker's own words, not a summary of them.
      lines.push({ text: `${turn.from}: ${turn.text}`, always: false })
    }
  }
  if (meeting.status === 'closed') {
    lines.push({ text: phrasebook.line('meeting-closed'), always: true })
  }
  return lines
}
