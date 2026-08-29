import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CountBadge } from '../../src/renderer/src/StatusBadge'

/**
 * The status strip's `odeon:queue` badge — the third carried item (M5
 * close-out: "the panels poll today").
 *
 * `odeon:queue` has been a push channel since M5 and nothing above the panels
 * listened to it, so a memo could sit in the queue with no sign of it unless
 * the Architect happened to open the tab. The badge is the sign.
 *
 * Rendered on M6.1's `react-dom/server` harness. `CountBadge` is shared with
 * the gate badge because both obey one rule that is easy to get wrong
 * separately, and it is the rule worth pinning.
 */

const memos = (count: number | 'error' | null): string =>
  renderToStaticMarkup(
    <CountBadge
      label="memos"
      count={count}
      none="none waiting"
      some={(n) => `${String(n)} need you`}
      tone="var(--eph-status-working)"
    />
  )

describe('the memo-queue badge (UI-DESIGN §4)', () => {
  it('shows an unread state before it has read anything, never "none"', () => {
    // The rule the badge exists to keep: an unknown count must not render as
    // reassurance. A stale "none waiting" is a degradation failing as GOOD
    // news, which is the one direction invariant §7 forbids.
    expect(memos(null)).toContain('memos: …')
    expect(memos(null)).not.toContain('none waiting')
  })

  it('distinguishes "could not read" from "none"', () => {
    expect(memos('error')).toContain('unavailable')
    expect(memos('error')).not.toContain('none waiting')
    expect(memos(0)).toContain('none waiting')
  })

  it('counts what is waiting, in the §9 register', () => {
    // "Three items need you" beats a bare number with no verb.
    expect(memos(3)).toContain('3 need you')
    expect(memos(1)).toContain('1 need you')
  })

  it('paints from tokens only (invariant §12)', () => {
    // The strip is chrome, and chrome is where a stray hex creeps in.
    for (const count of [null, 'error', 0, 4] as const) {
      expect(memos(count)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
    expect(memos(4)).toContain('var(--eph-')
  })
})
