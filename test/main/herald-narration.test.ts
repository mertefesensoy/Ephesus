import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PromptStore } from '../../src/main/prompts'
import { Phrasebook } from '../../src/main/herald/phrasebook'
import { HeraldSession } from '../../src/main/herald/session'
import {
  checkVoiceApproval,
  meetingLines,
  narrationOf,
  speakBrief,
  voiceApprovalAsk
} from '../../src/main/herald/narration'
import { REPEAT_BACK_TTL_MS } from '../../src/main/herald/policy'
import { fakeVoiceAdapter } from '../fakes/fake-voice'
import { GATE_SCHEMA_VERSION, type OpenGate } from '../../src/shared/gates'
import type { MeetingView } from '../../src/shared/odeon'
import { BRIEF_MAX_SECONDS, renderBriefMarkdown } from '../../src/shared/brief'

/**
 * The Herald narrating RECORDS — FR-7.1, FR-8.4, VOICE-DESIGN §4–§5.
 *
 * The property this file exists for is E-BRIEF-FAITH: the Herald speaks the
 * archived artifact and nothing else. An invented sentence is the failure that
 * gates release, so the test is not "does it sound right" but "is every spoken
 * string present in the archive, in order".
 */

const BUNDLED = fileURLToPath(new URL('../../prompts/', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function phrasebook(): Phrasebook {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-narr-'))
  temps.push(home)
  return new Phrasebook(new PromptStore(path.join(home, 'prompts'), BUNDLED))
}

function session(): HeraldSession {
  return new HeraldSession({
    adapters: [fakeVoiceAdapter({ provider: 'elevenlabs' })],
    phrasebook: phrasebook(),
    now: () => 0
  })
}

/** A real archive, rendered by the SHIPPED writer rather than hand-written. */
const ARCHIVE = renderBriefMarkdown(
  'BR-001',
  {
    sentences: [
      { section: 'headline', text: 'The release shipped overnight.', refs: ['log:1'] },
      { section: 'done', text: 'Mason closed the cache work.', refs: ['task:7'] },
      { section: 'blocked', text: 'One gate is waiting on you.', refs: ['gate:3'] }
    ]
  } as never,
  [
    { section: 'headline', what: 'release shipped', refs: ['log:1'] },
    { section: 'done', what: 'cache work closed', refs: ['task:7'] },
    { section: 'blocked', what: 'gate open', refs: ['gate:3'] }
  ] as never,
  '2026-08-29T09:00:00.000Z'
)

describe('the Herald narrates the archive (E-BRIEF-FAITH)', () => {
  it('reads the sentences back out of the artifact, in order', () => {
    const sentences = narrationOf(ARCHIVE)
    expect(sentences.map((s) => s.text)).toEqual([
      'The release shipped overnight.',
      'Mason closed the cache work.',
      'One gate is waiting on you.'
    ])
    expect(sentences.map((s) => s.section)).toEqual(['headline', 'done', 'blocked'])
    expect(sentences[0]?.refs).toEqual(['log:1'])
  })

  it('speaks ONLY what the archive contains — nothing recompiled, nothing added', async () => {
    const spokenLines: string[] = []
    const herald = new HeraldSession({
      adapters: [fakeVoiceAdapter({ provider: 'elevenlabs' })],
      phrasebook: phrasebook(),
      now: () => 0,
      onTranscript: (entry) => spokenLines.push(entry.text)
    })

    const narration = await speakBrief(herald, ARCHIVE)

    // The whole property, asserted rather than hoped: every string the Herald
    // uttered is verbatim in the artifact the card shows.
    for (const line of spokenLines) expect(ARCHIVE).toContain(line)
    expect(narration.spoken).toEqual(narration.sentences.map((s) => s.text))
    expect(spokenLines).toEqual(narration.spoken)
  })

  it('never reads the source-refs appendix aloud', () => {
    // The appendix is the audit trail behind the narration, not part of it;
    // speaking it would double the brief with what the card already shows.
    const spoken = narrationOf(ARCHIVE).map((s) => s.text)
    expect(ARCHIVE).toContain('## Source refs')
    expect(spoken.some((line) => line.includes('release shipped ['))).toBe(false)
    expect(spoken).toHaveLength(3)
  })

  it('reports the spoken length against the SRS §6.2 budget', async () => {
    const narration = await speakBrief(session(), ARCHIVE)
    expect(narration.seconds).toBeGreaterThan(0)
    expect(narration.withinBudget).toBe(true)
    // A brief that ran long must SAY so rather than quietly overrun.
    const long = await speakBrief(session(), ARCHIVE, { maxSeconds: 0.001 })
    expect(long.withinBudget).toBe(false)
    expect(BRIEF_MAX_SECONDS).toBe(90)
  })

  it('still narrates in full with no voice at all (FR-8.6)', async () => {
    const silent = new HeraldSession({
      adapters: [],
      phrasebook: phrasebook(),
      now: () => 0
    })
    const narration = await speakBrief(silent, ARCHIVE)
    // Zero non-audio loss: every sentence is in the transcript, and the caller
    // is told it was text-only rather than left to infer it.
    expect(narration.textOnly).toBe(true)
    expect(narration.spoken).toHaveLength(3)
    expect(silent.entries().map((e) => e.text)).toEqual(narration.spoken)
  })

  it('speaks nothing at all from an empty archive', async () => {
    const narration = await speakBrief(session(), '# Standup brief BR-000\n')
    expect(narration.spoken).toEqual([])
  })
})

describe('voice approvals need the words (FR-8.4)', () => {
  const gate = (over: Partial<OpenGate> = {}): OpenGate =>
    ({
      schemaVersion: GATE_SCHEMA_VERSION,
      id: 'GATE-1',
      kind: 'destructive',
      agentId: 'mason',
      because: 'destructive',
      channel: 'local',
      packaging: {
        what: 'delete branch release/9',
        why: 'stale',
        blastRadius: 'one branch',
        rollback: 'restore from origin'
      },
      taskId: null,
      requiresRepeatBack: true,
      memoTrigger: null,
      openedAt: '2026-08-29T09:00:00.000Z',
      ...over
    }) as OpenGate

  const ISSUE = { nowMs: 1_000, nonce: 'n-1' }

  it('asks for a token specific to the gate, in the phrase book’s words', () => {
    const ask = voiceApprovalAsk(gate(), phrasebook(), ISSUE)
    expect(ask.token).toContain('confirm')
    expect(ask.token).toContain('delete')
    // The sentence is config; only the token is the policy's (invariant §8).
    expect(ask.line).toContain(ask.token as string)
    expect(ask.line).toContain('delete branch release/9')
  })

  it('REFUSES a bare yes, and the gate stays open', () => {
    const ask = voiceApprovalAsk(gate(), phrasebook(), ISSUE)
    const result = checkVoiceApproval(gate(), 'yes', phrasebook(), {
      challenge: ask.challenge,
      nowMs: ISSUE.nowMs
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.because).toBe('bare-assent')
      // A refusal is not a denial: it comes back with what to say instead.
      expect(result.line).toContain('confirm')
    }
  })

  it('accepts the repeated-back words, spoken exactly', () => {
    const ask = voiceApprovalAsk(gate(), phrasebook(), ISSUE)
    const result = checkVoiceApproval(gate(), ask.token as string, phrasebook(), {
      challenge: ask.challenge,
      nowMs: ISSUE.nowMs
    })
    expect(result).toEqual({ ok: true, repeatBackConfirmed: true, nonce: 'n-1' })
  })

  // ── The M6 close-out audit's finding, as a regression ─────────────────────
  // Before the fix, `checkRepeatBack` matched the token ANYWHERE inside what
  // was said. A spoken refusal quotes the token, so the refusal approved the
  // gate. This is the single most dangerous input FR-8.4 exists to reject.
  it('REFUSES a spoken refusal that quotes the token (FR-8.4)', () => {
    const ask = voiceApprovalAsk(gate(), phrasebook(), ISSUE)
    for (const refusal of [
      `no, do not ${ask.token as string}`,
      `${ask.token as string} — actually, no, stop`,
      `I did not say ${ask.token as string}`
    ]) {
      const result = checkVoiceApproval(gate(), refusal, phrasebook(), {
        challenge: ask.challenge,
        nowMs: ISSUE.nowMs
      })
      expect(result.ok, refusal).toBe(false)
    }
  })

  it('REFUSES an answer to a lapsed asking, and a replayed one', () => {
    const ask = voiceApprovalAsk(gate(), phrasebook(), ISSUE)
    const said = ask.token as string
    const lapsed = checkVoiceApproval(gate(), said, phrasebook(), {
      challenge: ask.challenge,
      nowMs: ISSUE.nowMs + REPEAT_BACK_TTL_MS
    })
    expect(lapsed.ok).toBe(false)
    if (!lapsed.ok) expect(lapsed.because).toBe('expired')

    const replayed = checkVoiceApproval(gate(), said, phrasebook(), {
      challenge: ask.challenge,
      nowMs: ISSUE.nowMs,
      spent: new Set(['n-1'])
    })
    expect(replayed.ok).toBe(false)
    if (!replayed.ok) expect(replayed.because).toBe('replayed')
  })

  it('REFUSES a gate that needs a repeat-back when none was issued', () => {
    // "No challenge" must never read as "no challenge required".
    const result = checkVoiceApproval(gate(), 'confirm delete branch release 9', phrasebook(), {
      challenge: null,
      nowMs: ISSUE.nowMs
    })
    expect(result.ok).toBe(false)
  })

  it('needs no repeat-back for an ordinary gate, and says so by asking plainly', () => {
    const plain = gate({ kind: 'tool-permission', requiresRepeatBack: false })
    const ask = voiceApprovalAsk(plain, phrasebook(), ISSUE)
    expect(ask.token).toBeNull()
    expect(ask.challenge).toBeNull()
    expect(
      checkVoiceApproval(plain, 'yes', phrasebook(), { challenge: null, nowMs: ISSUE.nowMs })
    ).toEqual({
      ok: true,
      repeatBackConfirmed: false
    })
  })

  it('needs one for spend even when the gate did not ask (FR-8.4)', () => {
    // FR-8.4 names destructive AND spend. A policy that only honoured the
    // gate's own flag would let a spend approval through on a bare "yes".
    const spend = gate({ kind: 'spend', requiresRepeatBack: false })
    const ask = voiceApprovalAsk(spend, phrasebook(), ISSUE)
    expect(ask.token).not.toBeNull()
    expect(
      checkVoiceApproval(spend, 'sure', phrasebook(), {
        challenge: ask.challenge,
        nowMs: ISSUE.nowMs
      }).ok
    ).toBe(false)
  })
})

describe('meeting narration (FR-7.4, VOICE-DESIGN §5)', () => {
  const meeting = (over: Partial<MeetingView> = {}): MeetingView => ({
    id: 'MTG-1',
    agenda: 'the cache dependency',
    attendees: ['mason', 'iris'],
    floor: 'mason',
    transcript: [{ from: 'mason', text: 'I would keep it.', at: '2026-08-29T09:00:00.000Z' }],
    held: [],
    status: 'open',
    ...over
  })

  it('always announces the agenda and the floor', () => {
    const lines = meetingLines(meeting(), phrasebook())
    expect(lines.every((l) => l.always)).toBe(true)
    expect(lines[0]?.text).toContain('the cache dependency')
    expect(lines[1]?.text).toContain('mason')
  })

  it('reads replies only on request, and in the speaker’s own words', () => {
    const quiet = meetingLines(meeting(), phrasebook())
    const loud = meetingLines(meeting(), phrasebook(), { readReplies: true })
    // A Herald that read every reply aloud unasked would make a meeting
    // unusable, so replies are opt-in and marked `always: false`.
    expect(loud.length).toBeGreaterThan(quiet.length)
    const reply = loud.find((l) => !l.always)
    expect(reply?.text).toBe('mason: I would keep it.')
  })

  it('closes the meeting out loud', () => {
    const lines = meetingLines(meeting({ status: 'closed', floor: null }), phrasebook())
    expect(lines.at(-1)?.text).toContain('minutes')
    expect(lines.at(-1)?.always).toBe(true)
  })
})
