import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { consentSentences, type ConsentView } from '../../shared/consent'

/**
 * The first-launch consent banner (DD-6, M8.12).
 *
 * ## Why a banner and not a settings row
 *
 * This is the first thing a stranger meets. M8's exit is a developer who is not
 * the author working from a clean clone and the README alone; asking them to
 * find WATCH → settings before the company will do anything would make the
 * app's first state a puzzle. It sits above the tab strip, spans the window,
 * and is the only control that matters until it is answered.
 *
 * ## It is a degradation, not a splash screen
 *
 * A company that has not been authorised looks exactly like a company that has
 * finished its work: quiet terminals, still avatars, no errors. Invariant §7
 * calls that out by name — every degradation is a visible state, never an empty
 * floor. So the copy says what is NOT happening ("nobody is hired, no schedule
 * is running") before it says what would.
 *
 * The main process reports the same condition through the degradation channel,
 * so it also reaches the status strip and the book of record. This is the half
 * a person can act on.
 *
 * ## The promises are computed, never written here
 *
 * Every sentence comes from `consentSentences`, which builds them from the live
 * disclosure main sends: the actual engine, the actual cadences and their
 * intervals, the actual daily ceiling. A component that listed them by hand
 * would be describing a company that stopped existing the first time a trigger
 * was added.
 */

const banner = {
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-parchment-100)',
  color: 'var(--eph-ink-900)',
  padding: '8px 12px'
} as const

const heading = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '10px',
  margin: '0 0 6px'
} as const

const control = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  padding: '6px 12px',
  marginRight: '8px',
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-marble-50)',
  color: 'var(--eph-ink-900)'
} as const

const note = { color: 'var(--eph-ink-500)', margin: '4px 0', fontSize: '12px' } as const
const warn = { color: 'var(--eph-wine)', margin: '4px 0', fontSize: '12px' } as const

/** §9 copy voice: name the state before offering the action. */
export function headlineFor(view: ConsentView): string {
  if (view.state === 'stale-terms') return 'The company is paused — what it does has changed'
  return 'The company is not working yet'
}

export function ConsentGate(): ReactElement | null {
  const [view, setView] = useState<ConsentView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const eph = window.eph
    // The optional chain is not defensive noise: `window.eph` comes from
    // preload, and a renderer newer than its preload (a dev reload across this
    // change, an interrupted rebuild) would otherwise crash the WHOLE app in a
    // mount effect at the top of the tree. Missing is treated exactly like a
    // read that failed — see the catch below.
    if (!eph?.consent) return
    let cancelled = false
    void eph.consent.get().then(
      (next) => {
        if (!cancelled) setView(next)
      },
      (err: unknown) => {
        // Left null on failure, deliberately. A consent banner that rendered
        // itself because it could not READ the state would block an app whose
        // company is already running; the strip's bridge badge is what reports
        // a main process that cannot answer.
        if (!cancelled) setProblem(err instanceof Error ? err.message : String(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [])

  const grant = useCallback(() => {
    const eph = window.eph
    if (!eph?.consent) return
    setBusy(true)
    setProblem(null)
    void eph.consent.grant().then(
      (outcome) => {
        setBusy(false)
        // Adopt what main reports, refusal included: after a grant that could
        // not be written down the banner must show what is IN FORCE, which is
        // still "not working".
        setView(outcome.view)
        setProblem(outcome.reason)
      },
      (err: unknown) => {
        setBusy(false)
        setProblem(err instanceof Error ? err.message : String(err))
      }
    )
  }, [])

  if (problem !== null && view === null) return null
  if (view === null || view.mayStartWork) return null

  return (
    <section style={banner} aria-label="first-launch consent">
      <p style={heading}>{headlineFor(view)}</p>
      <p style={note}>{view.because}</p>
      <ul style={{ margin: '6px 0', paddingLeft: '18px', fontSize: '12px' }}>
        {consentSentences(view.disclosure).map((sentence) => (
          <li key={sentence} style={{ margin: '2px 0' }}>
            {sentence}
          </li>
        ))}
      </ul>
      <p style={{ margin: '8px 0 0' }}>
        <button type="button" style={control} disabled={busy} onClick={grant}>
          {busy ? 'STARTING…' : 'START THE COMPANY'}
        </button>
        <span style={note}>
          Or leave it closed — everything else in the app stays readable, and nothing runs.
        </span>
      </p>
      {problem !== null && <p style={warn}>⚠ {problem}</p>}
    </section>
  )
}
