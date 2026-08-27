/**
 * WCAG contrast maths (UI-DESIGN §8, NFR-15).
 *
 * §8 says body text must reach 4.5:1 against its panel fill and that this is
 * "verified in CI via token test". It was not: nothing checked it, so the
 * clause was a promise rather than a gate. This is the arithmetic that gate
 * needs, kept pure and in `src/shared/` so both the token test and (later) any
 * design tooling can use the same numbers.
 */

/** WCAG 2.1 AA for body text. */
export const AA_BODY = 4.5

/** WCAG 2.1 AA for large text (≥ 18.66px bold or ≥ 24px). */
export const AA_LARGE = 3

/** Contract: `#rrggbb` or a 24-bit number to its three channels, 0–255. */
export function channels(color: string | number): readonly [number, number, number] {
  const value = typeof color === 'number' ? color : Number.parseInt(color.replace(/^#/, ''), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/** Relative luminance, per the WCAG 2.1 definition. */
export function luminance(color: string | number): number {
  const [r, g, b] = channels(color)
  const linear = (channel: number): number => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/**
 * Contract: the WCAG contrast ratio between two colours, 1–21, order
 * independent. Rounded to two decimals so a test failure reads like the
 * number a designer would quote.
 */
export function contrastRatio(a: string | number, b: string | number): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return Math.round((((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)) * 100) / 100
}

/** Whether a foreground/background pair clears a threshold. */
export function meetsContrast(
  foreground: string | number,
  background: string | number,
  threshold: number = AA_BODY
): boolean {
  return contrastRatio(foreground, background) >= threshold
}
