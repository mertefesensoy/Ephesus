import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ceilingForm,
  describeAutonomy,
  describeBudget,
  parseTokenCeiling,
  SettingsPanel,
  type CeilingEdit
} from '../../src/renderer/src/SettingsPanel'
import type { GatePolicyView } from '../../src/shared/gates'

/**
 * The settings surface for the two company ceilings (FR-11.7).
 *
 * Static markup, no DOM — the M6.1 harness. Effects and clicks do not run, so
 * the decisions live in `ceilingForm` where a test can reach them, and this
 * file exercises that rather than a copy of it.
 */

const view = (over: Partial<GatePolicyView> = {}): GatePolicyView => ({
  autonomy: 'autonomous',
  maxDailyTokens: null,
  warning: null,
  ...over
})

const untouched: CeilingEdit = { autonomy: null, unbudgeted: null, tokens: '' }

describe('parseTokenCeiling — what may become a ceiling', () => {
  it('accepts a figure a human typed with separators', () => {
    expect(parseTokenCeiling('40,000,000')).toEqual({ ok: true, tokens: 40_000_000 })
    expect(parseTokenCeiling(' 1 000 ')).toEqual({ ok: true, tokens: 1_000 })
  })

  it('refuses zero, because a zero ceiling reads as already breached', () => {
    const parsed = parseTokenCeiling('0')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('unreachable')
    expect(parsed.reason).toContain('breached')
  })

  it('refuses what Number() would have silently accepted', () => {
    // `Number('')` is 0 and `Number('4e9')` is a finite number: both pass a bare
    // isNaN check and reach the schema as a refusal with no field named.
    for (const text of ['', '   ', '4e9', '-1', '1.5', 'lots']) {
      expect(parseTokenCeiling(text).ok).toBe(false)
    }
  })

  it('refuses a figure the policy schema would reject anyway', () => {
    expect(parseTokenCeiling('1000000000').ok).toBe(true)
    expect(parseTokenCeiling('1000000001').ok).toBe(false)
  })
})

describe('ceilingForm — what the panel shows and the button sends', () => {
  it('shows what main reported while nothing has been touched', () => {
    const form = ceilingForm(view({ autonomy: 'supervised', maxDailyTokens: 250 }), {
      ...untouched,
      tokens: '250'
    })
    expect(form).toMatchObject({ autonomy: 'supervised', unbudgeted: false, dirty: false })
    // Nothing to send: a button that could re-post the values already in force
    // would rewrite the policy file for a click that changed nothing.
    expect(form.send).toBeNull()
  })

  it('sends nothing at all before the ceilings have been read', () => {
    expect(ceilingForm(null, untouched)).toMatchObject({
      autonomy: null,
      unbudgeted: null,
      dirty: false,
      send: null
    })
  })

  it('carries an autonomy change through as a change', () => {
    const form = ceilingForm(view(), { ...untouched, autonomy: 'supervised' })
    expect(form.dirty).toBe(true)
    expect(form.send).toEqual({ autonomy: 'supervised', maxDailyTokens: null })
  })

  it('turns a ceiling off without needing the figure cleared', () => {
    // The text stays in the field so the Architect can put the ceiling back;
    // what goes over the wire is `null`, which is what deletes the key.
    const form = ceilingForm(view({ maxDailyTokens: 250 }), {
      ...untouched,
      unbudgeted: true,
      tokens: '250'
    })
    expect(form.dirty).toBe(true)
    expect(form.send).toEqual({ autonomy: 'autonomous', maxDailyTokens: null })
  })

  it('turns a ceiling on', () => {
    const form = ceilingForm(view(), { ...untouched, unbudgeted: false, tokens: '40,000,000' })
    expect(form.send).toEqual({ autonomy: 'autonomous', maxDailyTokens: 40_000_000 })
  })

  it('holds a half-typed figure back while still saying it is unsaved', () => {
    const form = ceilingForm(view(), { ...untouched, unbudgeted: false, tokens: '4o' })
    // Both halves matter: the button must not post `4o`, and the panel must not
    // look settled while an edit is sitting in it unsaved.
    expect(form.send).toBeNull()
    expect(form.dirty).toBe(true)
    expect(form.ceiling).toMatchObject({ ok: false })
  })

  it('does not hold an autonomy change hostage to a valid figure it does not need', () => {
    const form = ceilingForm(view({ maxDailyTokens: 250 }), {
      ...untouched,
      autonomy: 'manual',
      unbudgeted: true,
      tokens: 'nonsense'
    })
    expect(form.send).toEqual({ autonomy: 'manual', maxDailyTokens: null })
  })

  it('treats a re-typed identical figure as no change', () => {
    const form = ceilingForm(view({ maxDailyTokens: 40_000_000 }), {
      ...untouched,
      tokens: '40,000,000'
    })
    expect(form.dirty).toBe(false)
    expect(form.send).toBeNull()
  })
})

describe('what the Architect is told these dials do', () => {
  it('describes each autonomy level as the engine behaves, not as it is named', () => {
    expect(describeAutonomy('manual')).toContain('waits for you')
    expect(describeAutonomy('supervised')).toContain('edits run')
    expect(describeAutonomy('autonomous')).toContain('no human')
  })

  it('says out loud that unbudgeted means nothing stops a run on cost', () => {
    // ADR-0029 made unbudgeted the default. A panel that rendered it as a blank
    // field would be the quietest possible way to ship that.
    expect(describeBudget(null)).toContain('nothing stops a run on cost')
  })

  it('renders a ceiling in a form someone can check at a glance', () => {
    expect(describeBudget(40_000_000)).toContain('40,000,000')
    expect(describeBudget(40_000_000)).toContain('clamped')
  })
})

describe('the panel itself', () => {
  it('says these are ceilings every profile is composed against', () => {
    const html = renderToStaticMarkup(<SettingsPanel />)
    expect(html).toContain('every profile')
    expect(html).toContain('stricter of the two wins')
  })

  it('offers all three autonomy levels', () => {
    const html = renderToStaticMarkup(<SettingsPanel />)
    for (const level of ['MANUAL', 'SUPERVISED', 'AUTONOMOUS']) expect(html).toContain(level)
  })

  it('offers unbudgeted as a stated choice, not an empty field', () => {
    expect(renderToStaticMarkup(<SettingsPanel />)).toContain('UNBUDGETED')
  })

  it('shows nothing as chosen until the ceilings have actually been read', () => {
    // Invariant §7 again: rendering a default before main has answered would
    // show the Architect a ceiling that may not be the one in force.
    const html = renderToStaticMarkup(<SettingsPanel />)
    expect(html).toContain('reading gate-policy.json')
    expect(html).not.toContain('aria-pressed="true"')
  })
})
