import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AA_BODY, contrastRatio, luminance, meetsContrast } from '../../src/shared/contrast'
import { tokens } from '../../src/renderer/src/tokens'

/**
 * The token contrast gate UI-DESIGN §8 promises: "Contrast: body text ≥ 4.5:1
 * against its panel fill (verified in CI via token test)."
 *
 * It was promised from M0 and never existed — nothing checked it, so the clause
 * was a hope. This file is the check. It also keeps `tokens.ts` and
 * `tokens.css` in lockstep, which `tokens.ts`'s own header asks for and which
 * nothing verified either.
 */

const CSS = fs.readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'src', 'tokens.css'),
  'utf8'
)

/**
 * The fills BODY text is drawn on (UI-DESIGN §4's shell). `marble-100` is
 * deliberately absent: it is a control fill (buttons, tabs), and `ink-500` on
 * it measures 4.49:1 — a hair under AA, which is exactly the kind of near-miss
 * a gate exists to catch. Body text on `marble-100` uses `ink-700` or darker.
 */
const PANEL_FILLS = {
  'marble-50': tokens.marble50,
  'parchment-100': tokens.parchment100
} as const

/** Colours used for BODY text (12px), which owe the full 4.5:1. */
const BODY_INKS = {
  'ink-900': tokens.ink900,
  'ink-700': tokens.ink700,
  'ink-500': tokens.ink500
} as const

describe('the maths', () => {
  it('is 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21)
    expect(contrastRatio(tokens.ink900, tokens.ink900)).toBe(1)
  })

  it('is order independent', () => {
    expect(contrastRatio(tokens.ink900, tokens.marble50)).toBe(
      contrastRatio(tokens.marble50, tokens.ink900)
    )
  })

  it('reads a hex string and a 24-bit number identically', () => {
    expect(luminance('#221a14')).toBeCloseTo(luminance(0x221a14), 12)
  })
})

describe('body text clears AA on every panel fill (UI-DESIGN §8)', () => {
  const pairs = Object.entries(BODY_INKS).flatMap(([inkName, ink]) =>
    Object.entries(PANEL_FILLS).map(([fillName, fill]) => [inkName, ink, fillName, fill] as const)
  )

  it.each(pairs)('%s on %s', (_inkName, ink, _fillName, fill) => {
    expect(contrastRatio(ink, fill)).toBeGreaterThanOrEqual(AA_BODY)
  })
})

describe('status colours must never be the only carrier of meaning', () => {
  /**
   * The status palette is chosen for hue recognition on the floor, not for
   * text contrast: most of it is well under AA on any panel fill. UI-DESIGN §8's
   * answer is double-encoding — the WORD carries the state and the colour
   * merely reinforces it.
   *
   * These ratios are pinned rather than asserted as a blanket rule, because
   * the blanket rule is not true (`status-thinking` is 5.2:1) and a test that
   * claims it would be a test that lies. Pinning them means a palette change
   * that quietly makes a decorative colour look text-safe is noticed.
   */
  const SUB_AA = {
    'status-idle': tokens.statusIdle,
    'status-working': tokens.statusWorking,
    'status-waiting': tokens.statusWaiting,
    'status-blocked': tokens.statusBlocked,
    'status-looping': tokens.statusLooping,
    'status-success': tokens.statusSuccess
  } as const

  it.each(Object.entries(SUB_AA))(
    '%s is below AA on marble-50, so it may only reinforce a word',
    (_name, color) => {
      expect(meetsContrast(color, tokens.marble50)).toBe(false)
    }
  )

  it('status-thinking happens to clear AA, which changes nothing about the rule', () => {
    // Double-encoding is a rule about *information*, not about contrast: a
    // colour-blind reader needs the word whether or not the hue is legible.
    expect(meetsContrast(tokens.statusThinking, tokens.marble50)).toBe(true)
  })

  it('the verdict tokens are used as BORDERS, not as letterforms', () => {
    // UI-DESIGN §2.3 names `laurel` for approvals granted and `wine` for
    // destructive. `laurel` is 2.89:1 on the button fill — fine for a 2px
    // border that distinguishes the two controls at a glance, not fine for the
    // word inside them, which stays ink-900.
    expect(meetsContrast(tokens.laurel, tokens.marble100)).toBe(false)
    expect(meetsContrast(tokens.ink900, tokens.marble100)).toBe(true)
  })
})

describe('tokens.ts and tokens.css stay in lockstep', () => {
  const named: readonly (readonly [string, number])[] = [
    ['--eph-marble-50', tokens.marble50],
    ['--eph-marble-100', tokens.marble100],
    ['--eph-parchment-100', tokens.parchment100],
    ['--eph-ink-900', tokens.ink900],
    ['--eph-ink-700', tokens.ink700],
    ['--eph-ink-500', tokens.ink500],
    ['--eph-laurel', tokens.laurel],
    ['--eph-wine', tokens.wine],
    ['--eph-status-blocked', tokens.statusBlocked],
    ['--eph-status-looping', tokens.statusLooping],
    ['--eph-status-success', tokens.statusSuccess]
  ]

  it.each(named)('%s matches the numeric token', (name, value) => {
    // `tokens.ts` calls itself "a numeric mirror of tokens.css … keep the two
    // files in lockstep"; nothing checked that they were.
    const match = new RegExp(`${name}:\\s*#([0-9a-f]{6})`, 'i').exec(CSS)
    expect(match?.[1]).toBeDefined()
    expect(Number.parseInt(match?.[1] ?? '', 16)).toBe(value)
  })
})
