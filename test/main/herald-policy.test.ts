import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VOICE_FAULTS, VOICE_PROVIDERS, isConversational } from '../../src/main/herald/seam'
import {
  BARGE_IN_MS,
  FAILOVER_BUDGET_MS,
  FAILOVER_STATES,
  PROVIDER_ORDER,
  REPEAT_BACK_KINDS,
  VOICE_MODES,
  activeModes,
  bargeIn,
  checkRepeatBack,
  initialFailover,
  needsRepeatBack,
  reduceFailover,
  repeatBackChallenge,
  repeatBackToken,
  voiceAvailable,
  type FailoverSnapshot
} from '../../src/main/herald/policy'
import { GATE_KINDS } from '../../src/shared/gates'
import { fakeVoiceAdapter } from '../fakes/fake-voice'

/**
 * The Herald's policy layer — ADR-0007's "where all safety-relevant voice
 * behavior lives".
 *
 * Voice is the one modality where a wrong decision spends money or deletes a
 * branch, so these are table tests over values rather than assertions about a
 * session object. Three properties carry the safety weight: barge-in is
 * unconditional, a bare "yes" never approves a destructive gate, and failover
 * is decided HERE and never by an adapter.
 */

const PROMPTS = fileURLToPath(new URL('../../prompts/herald/', import.meta.url))

describe('modes (FR-8.3)', () => {
  it('always offers push-to-talk, with or without the wake word', () => {
    // FR-8.3 says "push-to-talk always". A build that could switch it off
    // would leave the wake word as the only way in — and the wake word is
    // optional and off by default.
    expect(activeModes({ wakeWordEnabled: false })).toEqual(['push-to-talk'])
    expect(activeModes({ wakeWordEnabled: true })).toContain('push-to-talk')
    expect(activeModes({ wakeWordEnabled: true })).toEqual([...VOICE_MODES])
  })
})

describe('barge-in is absolute (NFR-3, VOICE-DESIGN §2)', () => {
  const line = 'Mason wants to force-push to main.'

  it('always stops, inside 250 ms', () => {
    expect(BARGE_IN_MS).toBe(250)
    for (const spokenSoFar of ['', 'Mason', line]) {
      const result = bargeIn(line, spokenSoFar)
      // "The Herald never talks over the Architect, ever" — there is no input
      // for which this returns `stop: false`, and that is the point.
      expect(result.stop, spokenSoFar).toBe(true)
      expect(result.withinMs).toBeLessThanOrEqual(BARGE_IN_MS)
    }
  })

  it('keeps the interrupted sentence, split at the cut', () => {
    const result = bargeIn(line, 'Mason wants')
    // VOICE-DESIGN §2: the text remains, "marked 'unspoken from here'".
    expect(result.spoken).toBe('Mason wants')
    expect(result.unspoken).toBe(' to force-push to main.')
    expect(result.spoken + result.unspoken).toBe(line)
  })

  it('loses nothing when the provider reports a spoken prefix it never said', () => {
    // A provider that returns garbage must not make the transcript lie: the
    // whole line becomes unspoken rather than half of it being invented.
    const result = bargeIn(line, 'something else entirely')
    expect(result.spoken).toBe('')
    expect(result.unspoken).toBe(line)
  })
})

describe('repeat-back (FR-8.4)', () => {
  it('requires one for destructive and spend, and for nothing else', () => {
    for (const kind of REPEAT_BACK_KINDS) expect(needsRepeatBack(kind), kind).toBe(true)
    for (const kind of GATE_KINDS) {
      const expected = (REPEAT_BACK_KINDS as readonly string[]).includes(kind)
      expect(needsRepeatBack(kind), kind).toBe(expected)
    }
    expect(needsRepeatBack('unknown-kind')).toBe(false)
  })

  it('builds a token specific to the gate, not a generic word', () => {
    const token = repeatBackToken({ kind: 'destructive', what: 'delete branch release/9' })
    expect(token).toContain('confirm')
    // Specific: "confirm" alone would be a bare assent with extra steps.
    expect(token).not.toBe('confirm')
    expect(token).toContain('delete')
    // Two different gates never share a token.
    const other = repeatBackToken({ kind: 'spend', what: 'raise the daily cap to $80' })
    expect(other).not.toBe(token)
  })

  // ── The M6 close-out audit's finding, as a regression ─────────────────────
  // The token used to carry the first three words of the gate's subject, which
  // read as faithful to FR-8.4's example and was not: gates that differ only in
  // their tail collapsed onto one token. The amount of a SPEND gate — the whole
  // subject of the approval — was never in the words approving it.
  it('distinguishes gates that differ only in their tail (FR-8.4)', () => {
    const nine = repeatBackToken({ kind: 'destructive', what: 'delete branch release/9' })
    const ten = repeatBackToken({ kind: 'destructive', what: 'delete branch release/10' })
    expect(nine).not.toBe(ten)

    const small = repeatBackToken({ kind: 'spend', what: 'raise the daily cap to $80' })
    const large = repeatBackToken({ kind: 'spend', what: 'raise the daily cap to $8000' })
    expect(small).not.toBe(large)
    // The amount is IN the words, or the repeat-back is not of the spend.
    expect(large).toContain('8000')
  })

  it('falls back to the gate kind when the description has no usable words', () => {
    expect(repeatBackToken({ kind: 'destructive', what: '!!! ***' })).toBe('confirm destructive')
  })

  it('REJECTS a bare yes, and says that is why', () => {
    const c = repeatBackChallenge({ kind: 'destructive', what: 'delete branch' }, 0, 'n')
    for (const bare of ['yes', 'Yes.', 'yeah', 'ok', 'sure', 'go ahead', 'do it', 'confirm']) {
      const check = checkRepeatBack(bare, c, 0)
      expect(check.confirmed, bare).toBe(false)
      // The reason has to name the failure, or the Herald cannot explain
      // itself — and "I did not hear you" would be a lie.
      if (!check.confirmed) expect(check.because, bare).toBe('bare-assent')
    }
  })

  it('accepts the token spoken exactly, however it is cased or punctuated', () => {
    const c = repeatBackChallenge({ kind: 'destructive', what: 'delete branch release/9' }, 0, 'n')
    for (const said of [c.token, `${c.token}.`, c.token.toUpperCase(), ` ${c.token} `]) {
      expect(checkRepeatBack(said, c, 0).confirmed, said).toBe(true)
    }
  })

  // ── The M6 close-out audit's finding, as a regression ─────────────────────
  // `said.includes(wanted)` accepted the token anywhere in the utterance, so a
  // spoken REFUSAL — which necessarily quotes the token — approved the gate.
  // Proven by execution at the M6 head before this fix.
  it('REFUSES an utterance that merely CONTAINS the token (FR-8.4)', () => {
    const c = repeatBackChallenge({ kind: 'destructive', what: 'delete branch release/9' }, 0, 'n')
    for (const said of [
      `no, do not ${c.token}`,
      `${c.token} — wait, no`,
      `do not ${c.token} yet`,
      `${c.token}, please` // courtesy costs a retry; a refusal costs a branch
    ]) {
      const check = checkRepeatBack(said, c, 0)
      expect(check.confirmed, said).toBe(false)
      if (!check.confirmed) expect(check.because, said).toBe('mismatch')
    }
  })

  it('REFUSES a lapsed asking and a replayed answer', () => {
    const c = repeatBackChallenge({ kind: 'destructive', what: 'delete branch' }, 1_000, 'n-7')
    expect(checkRepeatBack(c.token, c, 1_000).confirmed).toBe(true)
    // One second before the deadline it still stands; at it, it does not.
    expect(checkRepeatBack(c.token, c, c.expiresAtMs - 1).confirmed).toBe(true)
    expect(checkRepeatBack(c.token, c, c.expiresAtMs)).toEqual({
      confirmed: false,
      because: 'expired'
    })
    expect(checkRepeatBack(c.token, c, 1_000, new Set(['n-7']))).toEqual({
      confirmed: false,
      because: 'replayed'
    })
  })

  it('hands back the nonce so the caller can spend it', () => {
    const c = repeatBackChallenge({ kind: 'spend', what: 'raise the cap' }, 0, 'n-42')
    expect(checkRepeatBack(c.token, c, 0)).toEqual({ confirmed: true, nonce: 'n-42' })
  })

  it('refuses silence and a mismatch, distinctly', () => {
    const c = repeatBackChallenge({ kind: 'spend', what: 'raise the cap' }, 0, 'n')
    expect(checkRepeatBack('', c, 0)).toEqual({ confirmed: false, because: 'empty' })
    expect(checkRepeatBack('   ', c, 0)).toEqual({ confirmed: false, because: 'empty' })
    expect(checkRepeatBack('confirm something else', c, 0)).toEqual({
      confirmed: false,
      because: 'mismatch'
    })
  })
})

describe('failover is the POLICY’s decision (ADR-0007)', () => {
  const both = [...VOICE_PROVIDERS]

  it('starts healthy on the reference provider', () => {
    const start = initialFailover(0, both)
    expect(start.state).toBe('healthy')
    // ADR-0007 makes ElevenLabs the reference implementation and OpenAI
    // Realtime the fallback; the order is a decision, not an accident.
    expect(PROVIDER_ORDER[0]).toBe('elevenlabs')
    expect(start.provider).toBe('elevenlabs')
    expect(start.notice).toBeNull()
    expect(voiceAvailable(start)).toBe(true)
  })

  it.each(VOICE_FAULTS)('switches to the fallback on a %s fault, with a notice', (fault) => {
    const start = initialFailover(0, both)
    const after = reduceFailover(start, { kind: 'fault', provider: 'elevenlabs', fault }, 100, both)
    expect(after.state).toBe('degraded')
    expect(after.provider).toBe('openai-realtime')
    expect(after.reason).toBe(fault)
    // FR-8.2's one-line notice — a KEY, not a sentence: invariant §8 keeps the
    // Herald's words in prompts/herald/.
    expect(after.notice).toBe('switching-provider')
    expect(after.notice).not.toContain(' ')
    expect(voiceAvailable(after)).toBe(true)
    expect(after.sinceMs - start.sinceMs).toBeLessThanOrEqual(FAILOVER_BUDGET_MS)
  })

  it('reaches cooldown when the last provider fails, and says voice is gone', () => {
    let snap: FailoverSnapshot = initialFailover(0, both)
    snap = reduceFailover(snap, { kind: 'fault', provider: 'elevenlabs', fault: 'auth' }, 1, both)
    snap = reduceFailover(
      snap,
      { kind: 'fault', provider: 'openai-realtime', fault: 'transient' },
      2,
      both
    )
    expect(snap.state).toBe('cooldown')
    expect(snap.provider).toBeNull()
    expect(voiceAvailable(snap)).toBe(false)
    // FR-8.6: both down is a VISIBLE text-only degradation, never silence.
    expect(snap.notice).toBe('voice-unavailable')
    expect(FAILOVER_STATES).toContain(snap.state)
  })

  it('never climbs back on its own — failback is manual (ADR-0007)', () => {
    let snap: FailoverSnapshot = initialFailover(0, both)
    snap = reduceFailover(snap, { kind: 'fault', provider: 'elevenlabs', fault: 'auth' }, 1, both)
    // No amount of time recovers it: a provider that failed auth will fail it
    // again, and a timer-based failback would flap the session.
    for (const later of [1_000, 60_000, 3_600_000]) {
      const same = reduceFailover(
        snap,
        { kind: 'fault', provider: 'elevenlabs', fault: 'auth' },
        later,
        both
      )
      expect(same, String(later)).toBe(snap)
    }
    const back = reduceFailover(snap, { kind: 'failback' }, 5_000, both)
    expect(back.state).toBe('healthy')
    expect(back.provider).toBe('elevenlabs')
    expect(back.burned).toEqual([])
    expect(back.notice).toBe('failback')
  })

  it('ignores a stale fault from a provider it already left', () => {
    let snap: FailoverSnapshot = initialFailover(0, both)
    snap = reduceFailover(snap, { kind: 'fault', provider: 'elevenlabs', fault: 'auth' }, 1, both)
    // Acting on it would burn the provider we just switched TO, silencing the
    // session over an error that arrived late.
    const same = reduceFailover(
      snap,
      { kind: 'fault', provider: 'elevenlabs', fault: 'transient' },
      2,
      both
    )
    expect(same).toBe(snap)
    expect(same.provider).toBe('openai-realtime')
  })

  it('starts in cooldown with no provider configured (FR-8.6)', () => {
    const none = initialFailover(0, [])
    expect(none.state).toBe('cooldown')
    expect(none.provider).toBeNull()
    expect(voiceAvailable(none)).toBe(false)
  })

  it('is a no-op when a failback has nothing better to offer', () => {
    const start = initialFailover(0, both)
    expect(reduceFailover(start, { kind: 'failback' }, 10, both)).toBe(start)
  })
})

describe('adapters report; they do not decide (ADR-0007)', () => {
  it('gives the seam no way for an adapter to act on its own health', () => {
    for (const provider of VOICE_PROVIDERS) {
      const adapter = fakeVoiceAdapter({ provider })
      expect(isConversational(adapter)).toBe(true)
      for (const forbidden of ['failover', 'retry', 'switchProvider', 'select']) {
        expect(Object.keys(adapter), `${provider}.${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})

describe('the Herald’s words are config (invariant §8)', () => {
  const phrasebook = fs.readFileSync(path.join(PROMPTS, 'phrasebook.md'), 'utf8')

  it('ships a persona and a phrase book under prompts/herald/', () => {
    expect(fs.existsSync(path.join(PROMPTS, 'persona.md'))).toBe(true)
    expect(phrasebook.length).toBeGreaterThan(0)
  })

  it('has an entry for every notice key the policy can emit', () => {
    // The policy names a KEY; the sentence lives here. A key with no entry
    // would be the Herald silently saying nothing at the moment it most needs
    // to speak.
    for (const key of ['switching-provider', 'voice-unavailable', 'failback', 'repeat-back']) {
      expect(phrasebook, key).toContain(`## ${key}`)
    }
  })

  it('keeps no spoken sentence in the policy or the seam', () => {
    const policy = fs.readFileSync(
      fileURLToPath(new URL('../../src/main/herald/policy.ts', import.meta.url)),
      'utf8'
    )
    // Strip comments — the ban is on prose the Herald would SAY, and the
    // documentation quotes the specs it implements.
    const code = policy.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const line of ['Switching voice provider', 'One moment', 'All quiet']) {
      expect(code, line).not.toContain(line)
    }
  })

  it('claims no actor and no studio character (FR-8.5)', () => {
    const persona = fs.readFileSync(path.join(PROMPTS, 'persona.md'), 'utf8')
    // The persona is an homage STYLE. Naming a specific character or actor
    // would make it a clone, which FR-8.5 forbids in as many words.
    expect(persona.toLowerCase()).toContain('homage')
    expect(persona.toLowerCase()).toContain('not any studio')
  })
})
