import type { VfxInfo } from '../../../shared/vfx'

/**
 * §8's reduced-motion parity, as words the census can carry.
 *
 * UI-DESIGN §8: *"walks become teleports + labels; envelopes become list
 * flashes; information parity is a test case, not a hope."* The moving forms
 * carry their meaning in pixels. When motion is suppressed, that meaning has to
 * arrive somewhere else or the setting costs the reader information — so it
 * arrives here, and `FloorCanvas` folds these lines into the canvas `aria-label`
 * beside the floor and station censuses. That label is the floor's declared
 * parity surface: a `<canvas>` is opaque to a screen reader, so it is already
 * the only place the floor's information exists in words (NFR-15).
 *
 * Architect decision 2026-08-30: the census is the parity surface, rather than
 * text drawn onto the canvas. One surface cannot drift from another, and a
 * string is testable without a renderer.
 *
 * Everything here is pure and takes its clock as an argument — the M6 close-out
 * audit found the overlay and the walk bob both silently accepting `Date.now()`,
 * and `check-invariants` now forbids a clock in this directory.
 */

/** One thing that happened, and when it was noticed. */
export interface ParityNotice {
  readonly text: string
  readonly atMs: number
}

/**
 * How long a notice stays in the label.
 *
 * Long enough to read, short enough that the label describes the floor NOW
 * rather than accumulating the session's history. A screen reader announcing a
 * label that never stops growing is worse than one that says nothing.
 */
export const PARITY_WINDOW_MS = 8_000

/** The most notices the label will ever carry, newest kept. */
export const PARITY_MAX = 4

/**
 * Contract: record what a suppressed animation would have said.
 *
 * Deduplicates on text — a citizen re-arriving at the same station, or a
 * broadcast flashing several trays, must not repeat one line four times. The
 * newest occurrence wins its timestamp, so a repeated event stays fresh rather
 * than ageing out mid-repeat.
 */
export function noteParity(
  notices: readonly ParityNotice[],
  info: VfxInfo,
  nowMs: number
): readonly ParityNotice[] {
  const withoutDuplicate = notices.filter((notice) => notice.text !== info.text)
  return [...withoutDuplicate, { text: info.text, atMs: nowMs }].slice(-PARITY_MAX)
}

/**
 * Contract: the label segment for what is still recent, oldest first, or `''`
 * when nothing is.
 *
 * Returning the empty string rather than a placeholder matters: `FloorCanvas`
 * appends this to the census, and a segment that always rendered would add a
 * permanent "nothing happened" to a label that is read aloud.
 */
export function parityLine(notices: readonly ParityNotice[], nowMs: number): string {
  const live = notices.filter((notice) => nowMs - notice.atMs < PARITY_WINDOW_MS)
  return live.length === 0 ? '' : live.map((notice) => notice.text).join('; ')
}
