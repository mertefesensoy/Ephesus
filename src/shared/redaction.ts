/**
 * The redaction filter (ADR-0010): known secret values are scrubbed from PTY
 * streams before they reach the renderer or the logs — defense-in-depth for an
 * agent that `echo $TOKEN`s, deliberately or under prompt injection.
 *
 * Pure and stream-shaped so it can be tested without a PTY: `push` takes the
 * bytes an engine just produced and returns the bytes that are safe to forward.
 *
 * Two properties matter more than they look:
 *
 *  - **A secret split across two chunks must still be caught.** A PTY hands out
 *    whatever the kernel had ready, so a token can arrive as `sk-ab` + `cdef`.
 *    The filter therefore carries a tail forward — but only a tail that is
 *    genuinely the start of a known secret, so ordinary output (the overwhelming
 *    majority) is emitted with zero delay. Holding back a fixed window instead
 *    would stall the last characters of every prompt the engine draws.
 *  - **A mask is visible.** ADR-0010 requires the mask to announce itself so a
 *    confused Architect can diagnose "why does my terminal say that" instead of
 *    hunting a corrupted string.
 */

/** The visible mask, verbatim from ADR-0010. */
export const SECRET_MASK = '•••eph-masked•••'

/**
 * Values shorter than this are never masked. A three-character "secret" has no
 * entropy to protect, and masking it would shred every terminal that happens to
 * print those characters — the filter would do more damage than the leak.
 */
export const REDACTION_MIN_LENGTH = 4

export interface RedactionFilter {
  /** Contract: returns the prefix of the stream that is safe to forward now. */
  push(chunk: string): string
  /** Emits whatever is being carried; call when the stream ends. */
  flush(): string
}

/** Longest suffix of `text` that is a proper prefix of one of `values`. */
function heldSuffixLength(text: string, values: readonly string[]): number {
  let held = 0
  for (const value of values) {
    // A whole occurrence would already have been masked, so only proper
    // prefixes are candidates here.
    const max = Math.min(value.length - 1, text.length)
    for (let len = max; len > held; len--) {
      if (text.endsWith(value.slice(0, len))) {
        held = len
        break
      }
    }
  }
  return held
}

/**
 * Contract: `secrets` is read on every chunk rather than captured once, so a
 * credential set while an agent is already running is masked in that agent's
 * live stream too. Values are never copied out of the supplier.
 */
export function createRedactor(secrets: () => readonly string[]): RedactionFilter {
  let carry = ''

  const usable = (): readonly string[] =>
    // Longest first: masking `abcdef` before `abc` keeps a longer secret from
    // being reported as a masked short one plus a plaintext tail.
    [...secrets()]
      .filter((value) => value.length >= REDACTION_MIN_LENGTH)
      .sort((a, b) => b.length - a.length)

  const mask = (text: string, values: readonly string[]): string => {
    let out = text
    for (const value of values) out = out.split(value).join(SECRET_MASK)
    return out
  }

  return {
    push(chunk: string): string {
      const values = usable()
      if (values.length === 0) {
        const pending = carry + chunk
        carry = ''
        return pending
      }
      const masked = mask(carry + chunk, values)
      const held = heldSuffixLength(masked, values)
      carry = held === 0 ? '' : masked.slice(masked.length - held)
      return held === 0 ? masked : masked.slice(0, masked.length - held)
    },
    flush(): string {
      const pending = carry
      carry = ''
      return pending.length === 0 ? pending : mask(pending, usable())
    }
  }
}
