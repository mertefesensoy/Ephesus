import { describe, expect, it } from 'vitest'
import { TOOL_CLASSES, type ToolClass } from '../../src/shared/avatar'
import { SPEECH_ACTS } from '../../src/shared/message'
import type { LogEntry } from '../../src/shared/log'
import {
  BROADCAST_FAN,
  ENVELOPE_COLOR,
  ENVELOPE_KINDS,
  ENVELOPE_MS,
  ENVELOPE_STEPS,
  MAX_PARTICLES_PER_CITIZEN,
  PARTICLES,
  PARTICLE_SYSTEMS,
  TOKEN_FADE_FRAMES,
  TOKEN_FADE_MS,
  TOKEN_FOR_TOOL_CLASS,
  budgetParticles,
  envelopeFor,
  envelopeInfo,
  envelopePose,
  fanOffsets,
  particlesUnderReducedMotion,
  reduceEnvelope,
  reduceWalk,
  tokenFade,
  tokenFor,
  walkInfo,
  type EnvelopeFlight
} from '../../src/shared/vfx'
import { tokens } from '../../src/renderer/src/tokens'

/**
 * UI-DESIGN §5.3, §5.5, §5.6 and §8.
 *
 * Two properties matter more than the shapes. First, **nothing here exists
 * without a log entry**: an envelope's identity, colour and start all come off
 * the record, so replaying `log.jsonl` reproduces the floor (NFR-13's spirit).
 * Second, **reduced motion loses no information** — §8 calls that "a test case,
 * not a hope", so it is asserted as equality between the moving form's
 * information and the still form's, not as the presence of a label.
 */

const entry = (over: Record<string, unknown> = {}): LogEntry =>
  ({
    ts: 1_000,
    seq: 1,
    kind: 'delivery',
    msgId: 'msg-1',
    from: 'mason',
    to: 'artemis',
    act: 'inform',
    ...over
  }) as unknown as LogEntry

describe('§5.3 carrying tokens key off the tool CLASS', () => {
  it('is total over every tool class SDD §6 defines', () => {
    for (const toolClass of TOOL_CLASSES) {
      expect(TOKEN_FOR_TOOL_CLASS, toolClass).toHaveProperty(toolClass)
    }
    expect(Object.keys(TOKEN_FOR_TOOL_CLASS).sort()).toEqual([...TOOL_CLASSES].sort())
  })

  it('gives a distinct token to each class that has one', () => {
    const carried = TOOL_CLASSES.map((c) => TOKEN_FOR_TOOL_CLASS[c]).filter(Boolean)
    const kinds = new Set(carried.map((t) => t?.kind))
    expect(kinds.size).toBe(carried.length)
    for (const token of carried) {
      // §5.3 sizes them 6–8 px, carried at hand height.
      expect(token?.w).toBeGreaterThanOrEqual(6)
      expect(token?.w).toBeLessThanOrEqual(8)
      expect(token?.h).toBeGreaterThanOrEqual(6)
      expect(token?.h).toBeLessThanOrEqual(8)
      expect(token?.label.length).toBeGreaterThan(0)
    }
  })

  it('carries nothing back from a meeting, rather than inventing a token', () => {
    // §5.3's table gives `meeting` no token. `null` is the honest answer;
    // making one up would be art this design does not specify.
    expect(TOKEN_FOR_TOOL_CLASS.meeting).toBeNull()
  })

  it('knows no tool NAMES — only classes (NFR-12)', () => {
    // The floor must never learn a Claude-ism. If a tool name ever reaches
    // this table, this is what fails.
    const keys = Object.keys(TOKEN_FOR_TOOL_CLASS)
    for (const claudeism of ['Read', 'Bash', 'Edit', 'WebFetch', 'Glob', 'Grep']) {
      expect(keys, claudeism).not.toContain(claudeism)
      expect(tokenFor(claudeism), claudeism).toBeNull()
    }
  })

  it('answers nothing for an unclassified tool rather than throwing', () => {
    for (const bad of ['', 'nope', null, undefined, 42]) {
      expect(tokenFor(bad)).toBeNull()
    }
    expect(tokenFor('file' satisfies ToolClass)?.kind).toBe('scroll')
  })

  it('fades a dropped token over three stepped frames, then stops drawing it', () => {
    expect(TOKEN_FADE_FRAMES).toBe(3)
    expect(tokenFade(0)).toBe(1)
    expect(tokenFade(TOKEN_FADE_MS - 1)).toBe(1)
    expect(tokenFade(TOKEN_FADE_MS)).toBeCloseTo(2 / 3)
    expect(tokenFade(TOKEN_FADE_MS * 2)).toBeCloseTo(1 / 3)
    // "then gone" — not held at low opacity forever.
    expect(tokenFade(TOKEN_FADE_MS * 3)).toBeNull()
    expect(tokenFade(60_000)).toBeNull()
  })
})

describe('§5.5 envelopes come off the record, not from the renderer', () => {
  it('makes no envelope from an entry that is not a delivery', () => {
    for (const kind of ['spawn', 'hook', 'gate', 'brief', 'gym']) {
      expect(envelopeFor(entry({ kind })), kind).toBeNull()
    }
  })

  it('takes its identity and start from the log entry', () => {
    const flight = envelopeFor(entry({ msgId: 'msg-42', ts: 7_000 }))
    // Identity is the message id, so replaying the log flies the same envelope
    // rather than a new one that merely looks the same.
    expect(flight?.id).toBe('msg-42')
    expect(flight?.startedMs).toBe(7_000)
  })

  it('refuses an entry missing the parties or the id', () => {
    expect(envelopeFor(entry({ msgId: undefined }))).toBeNull()
    expect(envelopeFor(entry({ from: undefined }))).toBeNull()
    expect(envelopeFor(entry({ to: undefined }))).toBeNull()
  })

  it('colours by speech act, and names a token for every act', () => {
    for (const act of SPEECH_ACTS) {
      const color = ENVELOPE_COLOR[act]
      expect(color, act).toBeTruthy()
      // Invariant §12: shared logic names a token, never a hex value.
      expect(color, act).not.toMatch(/^#/)
      expect(tokens, act).toHaveProperty(color)
      expect(envelopeFor(entry({ act }))?.color).toBe(color)
    }
    // §5.5's own mapping, spot-checked.
    expect(ENVELOPE_COLOR.request).toBe('aegean')
    expect(ENVELOPE_COLOR.done).toBe('olive')
    expect(ENVELOPE_COLOR.propose).toBe('gold')
    expect(ENVELOPE_COLOR.agree).toBe('laurel')
    expect(ENVELOPE_COLOR.refuse).toBe('wine')
  })

  it('wobbles a refusal and a bounce, and paints a bounce wine whatever it carried', () => {
    expect(envelopeFor(entry({ act: 'refuse' }))?.wobble).toBe(true)
    const bounced = envelopeFor(entry({ kind: 'bounce', act: 'request', reason: 'no mailbox' }))
    expect(bounced?.kind).toBe('bounce')
    expect(bounced?.wobble).toBe(true)
    // To the reader a bounce and a refusal are the same event.
    expect(bounced?.color).toBe('wine')
    expect(envelopeFor(entry({ act: 'inform' }))?.wobble).toBe(false)
  })

  it('fans a broadcast into three envelopes', () => {
    const flight = envelopeFor(entry({ to: 'broadcast' }))
    expect(flight?.kind).toBe('broadcast')
    expect(flight?.fan).toBe(BROADCAST_FAN)
    expect(fanOffsets(flight as EnvelopeFlight)).toHaveLength(3)
    expect(fanOffsets(envelopeFor(entry()) as EnvelopeFlight)).toEqual([0])
  })

  it('turns a hop-cap divert toward the temple, mid-flight', () => {
    const flight = envelopeFor(entry({ kind: 'bounce', reason: 'hop cap reached' }))
    expect(flight?.kind).toBe('divert')
    expect(flight?.towardTemple).toBe(true)
    expect(ENVELOPE_KINDS).toContain(flight?.kind)

    const from = { x: 0, y: 0 }
    const to = { x: 400, y: 0 }
    const temple = { x: 200, y: 300 }
    const early = envelopePose(flight as EnvelopeFlight, from, to, temple, 40)
    const late = envelopePose(flight as EnvelopeFlight, from, to, temple, ENVELOPE_MS)
    // Early it is heading for the addressee; by the end it has gone to the
    // temple instead — the turn is real, not a colour change.
    expect(early.y).toBeLessThan(100)
    expect(late.x).toBe(temple.x)
    expect(late.y).toBe(temple.y)
  })

  it('flies 400 ms in stepped frames, arriving exactly once', () => {
    expect(ENVELOPE_MS).toBe(400)
    const flight = envelopeFor(entry()) as EnvelopeFlight
    const from = { x: 0, y: 0 }
    const to = { x: 320, y: 0 }
    const steps = new Set<number>()
    for (let t = 0; t <= ENVELOPE_MS; t += 10) {
      const pose = envelopePose(flight, from, to, from, t)
      steps.add(pose.step)
      // Stepped: the position only ever sits on a step boundary.
      expect(Number.isInteger(pose.x)).toBe(true)
    }
    expect(steps.size).toBeLessThanOrEqual(ENVELOPE_STEPS + 1)
    expect(envelopePose(flight, from, to, from, ENVELOPE_MS).done).toBe(true)
    expect(envelopePose(flight, from, to, from, ENVELOPE_MS - 1).done).toBe(false)
    // Past the end it stays landed rather than flying on.
    const after = envelopePose(flight, from, to, from, 10_000)
    expect(after).toEqual(envelopePose(flight, from, to, from, ENVELOPE_MS))
  })

  it('is pure — the same elapsed time gives the same pose', () => {
    const flight = envelopeFor(entry()) as EnvelopeFlight
    const from = { x: 0, y: 0 }
    const to = { x: 160, y: 64 }
    for (const t of [0, 99, 200, 399]) {
      expect(envelopePose(flight, from, to, from, t)).toEqual(
        envelopePose(flight, from, to, from, t)
      )
    }
  })
})

describe('§5.6 allows exactly three particle systems', () => {
  it('has three, and no fourth', () => {
    // §5.6 is unusually explicit: "Nothing else. No weather, no fireflies, no
    // screen shake." A fourth system fails here before it reaches review.
    expect([...PARTICLE_SYSTEMS]).toEqual(['sparkle', 'dust', 'tray-pulse'])
    expect(PARTICLE_SYSTEMS).toHaveLength(3)
    expect(Object.keys(PARTICLES).sort()).toEqual([...PARTICLE_SYSTEMS].sort())
  })

  it('ties every system to a logged event', () => {
    for (const system of PARTICLE_SYSTEMS) {
      // §5.6: "Each tied to a logged event." A system that could not name one
      // would be ambience.
      expect(PARTICLES[system].firedBy.length, system).toBeGreaterThan(0)
    }
  })

  it('transcribes §5.6’s counts and durations', () => {
    expect(PARTICLES.sparkle).toMatchObject({ count: 4, durationMs: 250, repeats: false })
    expect(PARTICLES.dust).toMatchObject({ count: 3, durationMs: 300, repeats: false })
    expect(PARTICLES['tray-pulse']).toMatchObject({ durationMs: 800, repeats: true })
  })

  it('runs at most two systems on one citizen', () => {
    expect(MAX_PARTICLES_PER_CITIZEN).toBe(2)
    expect(budgetParticles(['sparkle', 'dust', 'tray-pulse'])).toHaveLength(2)
    // Ordered by the §5.6 list, so the cap drops the same one every time.
    expect(budgetParticles(['tray-pulse', 'dust', 'sparkle'])).toEqual(['sparkle', 'dust'])
    expect(budgetParticles([])).toEqual([])
    expect(budgetParticles(['dust'])).toEqual(['dust'])
  })
})

describe('§8 reduced motion keeps information parity', () => {
  const flights: EnvelopeFlight[] = [
    envelopeFor(entry()) as EnvelopeFlight,
    envelopeFor(entry({ act: 'propose' })) as EnvelopeFlight,
    envelopeFor(entry({ to: 'broadcast' })) as EnvelopeFlight,
    envelopeFor(entry({ kind: 'bounce', reason: 'no mailbox' })) as EnvelopeFlight,
    envelopeFor(entry({ kind: 'bounce', reason: 'hop cap reached' })) as EnvelopeFlight
  ]

  it('turns every envelope into a tray flash carrying the same information', () => {
    for (const flight of flights) {
      const reduced = reduceEnvelope(flight)
      // Equality, not "there is a label": the still form must say exactly what
      // the moving form said, or the parity claim is decoration.
      expect(reduced.info, flight.kind).toEqual(envelopeInfo(flight))
      expect(reduced.at).toEqual([flight.from, flight.to])
      expect(reduced.color).toBe(flight.color)
    }
  })

  it('names both parties and the act in words', () => {
    const info = envelopeInfo(flights[0] as EnvelopeFlight)
    expect(info.text).toContain('mason')
    expect(info.text).toContain('artemis')
    expect(info.text).toContain('inform')
    // §9 copy voice: no emoji, short.
    expect(info.text).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(info.text.split(' ').length).toBeLessThanOrEqual(12)
  })

  it('distinguishes a bounce and a divert from a delivery, in words', () => {
    const [, , , bounced, diverted] = flights
    expect(envelopeInfo(bounced as EnvelopeFlight).text).toContain('could not reach')
    expect(envelopeInfo(diverted as EnvelopeFlight).text).toContain('diverted')
    // A reader with motion off must still be able to tell them apart.
    expect(envelopeInfo(bounced as EnvelopeFlight).text).not.toBe(
      envelopeInfo(diverted as EnvelopeFlight).text
    )
  })

  it('turns a walk into a teleport that says where the citizen went', () => {
    const reduced = reduceWalk('mason', 'shelf')
    // §8: "walks become teleports + labels".
    expect(reduced.progress).toBe(1)
    expect(reduced.info).toEqual(walkInfo('mason', 'shelf'))
    expect(reduced.info.text).toContain('mason')
    expect(reduced.info.text).toContain('shelf')
  })

  it('suppresses every particle, because none of them carries unique information', () => {
    expect(particlesUnderReducedMotion()).toEqual([])
    // The claim behind the suppression: each particle's fact is already carried
    // by a badge, a tray flag or a log line, so nothing becomes unreachable.
    for (const system of PARTICLE_SYSTEMS) {
      expect(PARTICLES[system].firedBy).toBeTruthy()
    }
  })
})
