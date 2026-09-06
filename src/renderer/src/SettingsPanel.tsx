import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  AUTONOMY_LEVELS,
  type AutonomyLevel,
  type GateCeilings,
  type GatePolicyView
} from '../../shared/gates'

/**
 * The two company-wide ceilings (FR-11.7, ADR-0012, ADR-0029).
 *
 * Until this existed both dials were real, enforced, composed stricter-wins —
 * and reachable only by hand-editing `~/.ephesus/gate-policy.json` while the
 * app was running. An Architect who wanted the company supervised for an hour,
 * or capped before walking away, had to know the file existed, know the field
 * names, and get the JSON right. A safety control nobody can find is not a
 * safety control.
 *
 * ## Ceilings, not switches — the distinction the copy has to carry
 *
 * Neither figure here *grants* anything. Both are maxima that every profile is
 * composed against, and the stricter of the two governs (ADR-0012 for autonomy;
 * the same rule for the budget since the M8.9 fix). Raising the ceiling to
 * `autonomous` does not make the Skeleton Crew autonomous — it stops clamping a
 * crew that already asked to be. Copy reading "set the company to autonomous"
 * would describe a switch this is not, and would make the `manual` position
 * look careful when what it actually does is park every agent at a permission
 * prompt nobody is there to answer (DD-1, 2026-09-04).
 *
 * ## What is deliberately NOT here
 *
 * The `rules` table. It decides which action CLASSES need a human — destructive
 * ops, prod-facing changes, outbound communication — and it is edited in the
 * file by someone who has read what a kind means. `gateCeilingsSchema` is
 * strict, so a renderer cannot reach `rules` even by sending it.
 */

/** What the engine actually does at each level (threat model §6.2). */
export function describeAutonomy(level: AutonomyLevel): string {
  if (level === 'manual') return 'every tool call waits for you'
  if (level === 'supervised') return 'edits run; anything heavier waits for you'
  return "the engine's own classifier decides, with no human in the loop"
}

/** Contract: pure. The budget ceiling as a sentence, for the line under it. */
export function describeBudget(maxDailyTokens: number | null): string {
  if (maxDailyTokens === null) {
    return 'unbudgeted — nothing stops a run on cost. The breaker and the wake cap still bound behaviour.'
  }
  return `${maxDailyTokens.toLocaleString('en-US')} tokens a day, per agent. A hire asking for more is clamped to this.`
}

export type CeilingParse =
  { readonly ok: true; readonly tokens: number } | { readonly ok: false; readonly reason: string }

/**
 * Contract: pure. A typed ceiling → the figure to send, or why it was refused.
 *
 * Separators are stripped because the field holds an eight-digit token count
 * and `40,000,000` is the form a human can check. Everything else is refused
 * rather than coerced: `Number('')` is 0 and `Number('4e9')` is a valid float,
 * and both would sail past a bare `isNaN` into a policy file — one as a ceiling
 * that reads as breached before the first token, the other as a refusal from
 * the schema with no explanation of which field caused it.
 */
export function parseTokenCeiling(text: string): CeilingParse {
  const cleaned = text.replace(/[\s,_]/g, '')
  if (cleaned.length === 0) return { ok: false, reason: 'enter a number of tokens' }
  if (!/^\d+$/.test(cleaned)) return { ok: false, reason: 'whole tokens only, digits' }
  const tokens = Number(cleaned)
  if (tokens === 0) {
    return { ok: false, reason: 'zero would read as breached before the first token' }
  }
  if (tokens > 1_000_000_000) return { ok: false, reason: 'at most 1,000,000,000 tokens' }
  return { ok: true, tokens }
}

/** What the Architect has changed but not yet saved. `null` means "untouched". */
export interface CeilingEdit {
  readonly autonomy: AutonomyLevel | null
  readonly unbudgeted: boolean | null
  readonly tokens: string
}

/** Everything the panel renders and the button decides, resolved in one place. */
export interface CeilingForm {
  readonly autonomy: AutonomyLevel | null
  readonly unbudgeted: boolean | null
  /** The typed ceiling's verdict, or `null` when no figure is being asked for. */
  readonly ceiling: CeilingParse | null
  readonly dirty: boolean
  /** What the SAVE button sends, or `null` when there is nothing valid to send. */
  readonly send: GateCeilings | null
}

/**
 * Contract: pure. Saved ceilings + a pending edit → what is on screen.
 *
 * Extracted rather than left inline because the renderer harness renders
 * through `react-dom/server`: effects and clicks do not run, so logic living
 * inside a component is logic no test can reach (the M5b rig lesson, and the
 * same reason `registerDraft` sits outside `StoaPanel`).
 *
 * The rule it encodes: the panel NEVER holds authority (invariant §2). It shows
 * the pending edit where there is one and what main reported everywhere else,
 * and `send` is null unless there is a real, valid change — so the button
 * cannot re-post the values already in force, and cannot post a half-typed
 * figure.
 */
export function ceilingForm(saved: GatePolicyView | null, edit: CeilingEdit): CeilingForm {
  const autonomy = edit.autonomy ?? saved?.autonomy ?? null
  const unbudgeted = edit.unbudgeted ?? (saved === null ? null : saved.maxDailyTokens === null)
  const ceiling = unbudgeted === false ? parseTokenCeiling(edit.tokens) : null
  if (saved === null || autonomy === null || unbudgeted === null) {
    return { autonomy, unbudgeted, ceiling, dirty: false, send: null }
  }
  // Null whenever the company is unbudgeted, because `ceiling` is only parsed
  // for a ceiling — so this IS the figure to send, with no second test of
  // `unbudgeted` that could ever disagree with it.
  const wanted = ceiling !== null && ceiling.ok ? ceiling.tokens : null
  const dirty =
    autonomy !== saved.autonomy ||
    unbudgeted !== (saved.maxDailyTokens === null) ||
    (wanted !== null && wanted !== saved.maxDailyTokens)
  // Unbudgeted needs no figure; a ceiling needs a valid one. A dirty form whose
  // figure does not parse stays unsavable, which is why `ok` is checked here
  // and not folded into `dirty` — the Architect still sees "unsaved".
  const savable = dirty && (unbudgeted || (ceiling !== null && ceiling.ok))
  return {
    autonomy,
    unbudgeted,
    ceiling,
    dirty,
    send: savable ? { autonomy, maxDailyTokens: wanted } : null
  }
}

/** UI-DESIGN §4 headings, matched to the sibling panels inside the Watch. */
const heading = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  margin: '12px 0 6px'
} as const

const field = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  padding: '3px 6px',
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-parchment-100)',
  color: 'var(--eph-ink-900)',
  marginRight: '4px'
} as const

const control = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  padding: '4px 8px',
  marginRight: '4px',
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-marble-200)',
  color: 'var(--eph-ink-900)'
} as const

const chosen = { ...control, background: 'var(--eph-marble-50)' } as const

const note = { color: 'var(--eph-ink-500)', margin: '4px 0' } as const
const warn = { color: 'var(--eph-wine)', margin: '4px 0' } as const

export function SettingsPanel(): ReactElement {
  /** What is in force, as main last reported it. Never edited in place. */
  const [saved, setSaved] = useState<GatePolicyView | null>(null)
  const [edit, setEdit] = useState<CeilingEdit>({ autonomy: null, unbudgeted: null, tokens: '' })
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const adopt = useCallback((view: GatePolicyView) => {
    setSaved(view)
    setEdit({
      autonomy: null,
      unbudgeted: null,
      tokens: view.maxDailyTokens === null ? '' : String(view.maxDailyTokens)
    })
  }, [])

  useEffect(() => {
    const eph = window.eph
    if (!eph) return
    void eph.watch.policy().then(adopt, (err: unknown) => {
      setProblem(err instanceof Error ? err.message : String(err))
    })
  }, [adopt])

  const form = ceilingForm(saved, edit)

  const save = useCallback(() => {
    const eph = window.eph
    const send = form.send
    if (!eph || send === null) return
    setProblem(null)
    setBusy(true)
    void eph.watch.setPolicy(send).then(
      (result) => {
        setBusy(false)
        // Adopt whatever main reports, refusal or not: after a refused save the
        // panel must show what is IN FORCE, never the edit that failed.
        adopt(result.view)
        setProblem(result.reason)
      },
      (err: unknown) => {
        setBusy(false)
        setProblem(err instanceof Error ? err.message : String(err))
      }
    )
  }, [adopt, form.send])

  return (
    <div>
      <p style={heading}>Ceilings</p>
      <p style={note}>
        Company-wide maxima, applied to every profile. A profile may sit under them and never above
        — the stricter of the two wins, so these do not grant anything, they cap it.
      </p>

      {saved === null && <p style={note}>reading gate-policy.json…</p>}
      {saved !== null && saved.warning !== null && <p style={warn}>⚠ {saved.warning}</p>}

      <p style={heading}>Autonomy</p>
      <p style={{ margin: '0 0 4px' }}>
        {AUTONOMY_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            style={form.autonomy === level ? chosen : control}
            aria-pressed={form.autonomy === level}
            disabled={saved === null}
            onClick={() => setEdit((was) => ({ ...was, autonomy: level }))}
          >
            {level.toUpperCase()}
          </button>
        ))}
      </p>
      {form.autonomy !== null && <p style={note}>{describeAutonomy(form.autonomy)}</p>}

      <p style={heading}>Daily budget</p>
      <p style={{ margin: '0 0 4px' }}>
        <button
          type="button"
          style={form.unbudgeted === true ? chosen : control}
          aria-pressed={form.unbudgeted === true}
          disabled={saved === null}
          onClick={() => setEdit((was) => ({ ...was, unbudgeted: true }))}
        >
          UNBUDGETED
        </button>
        <button
          type="button"
          style={form.unbudgeted === false ? chosen : control}
          aria-pressed={form.unbudgeted === false}
          disabled={saved === null}
          onClick={() => setEdit((was) => ({ ...was, unbudgeted: false }))}
        >
          CEILING
        </button>
        {form.unbudgeted === false && (
          <input
            style={{ ...field, width: '120px' }}
            value={edit.tokens}
            inputMode="numeric"
            aria-label="daily token ceiling"
            placeholder="tokens"
            onChange={(e) => setEdit((was) => ({ ...was, tokens: e.target.value }))}
          />
        )}
      </p>
      {form.unbudgeted === true && <p style={note}>{describeBudget(null)}</p>}
      {form.ceiling?.ok === true && <p style={note}>{describeBudget(form.ceiling.tokens)}</p>}
      {form.ceiling?.ok === false && <p style={warn}>⚠ {form.ceiling.reason}</p>}

      <p style={{ margin: '8px 0 0' }}>
        <button type="button" style={control} disabled={busy || form.send === null} onClick={save}>
          {busy ? 'SAVING…' : 'SAVE CEILINGS'}
        </button>
        {form.dirty && <span style={note}>unsaved</span>}
      </p>
      {problem !== null && <p style={warn}>⚠ {problem}</p>}
    </div>
  )
}
