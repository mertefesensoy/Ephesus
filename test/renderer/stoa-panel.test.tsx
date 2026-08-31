import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BriefCard, registerDraft, SourceRow, StoaPanel } from '../../src/renderer/src/StoaPanel'
import type { BriefView, SourceView } from '../../src/shared/stoa-view'

/**
 * The reading desk's first renderer-side regression — owed since the M5b
 * close-out audit, which recorded that "the reading-desk pin fix carries no
 * renderer regression until M6.1 establishes a DOM harness".
 *
 * **The harness.** Components render through `react-dom/server`, which is
 * already a dependency, so no DOM library joins the tree for three files
 * (BUILD-PROMPT §3.10 makes a new package a must-ask, and this coverage did
 * not need one). What it buys: the SHIPPED component bodies are what a test
 * reads — not a copy of them, which is the M5b rig defect this repository has
 * already paid for once. What it does not buy: effects and clicks do not run,
 * so behaviour that only exists inside a handler is tested at the module
 * boundary instead (BUILD-PROMPT §6), which is where `registerDraft` now
 * lives. A jsdom upgrade for interaction coverage is a must-ask carried in the
 * session report.
 *
 * **The defect under test.** M5b.1 deferred pin-setting to the study flow and
 * M5b.2 only READ the pin, so the panel hard-coded `pin: null` and every source
 * registered from this desk was permanently unstudiable (FR-13.2). Two halves
 * are asserted here: the form offers the field, and the mapping carries what is
 * typed into it.
 */

const source = (over: Partial<SourceView> = {}): SourceView => ({
  id: 'SRC-001',
  url: 'https://github.com/owner/repo',
  kind: 'git',
  tags: ['orchestration'],
  license: 'MIT',
  pin: 'b91a49f',
  registeredAt: '2026-08-29T00:00:00.000Z',
  notes: '',
  retired: false,
  blocked: null,
  intakeBlocked: null,
  ...over
})

describe('registerDraft — the pin the desk actually sends (FR-13.2)', () => {
  const fields = { url: ' https://x/y ', tags: 'a, b ,, c', license: ' MIT ', pin: '', notes: 'n' }

  it('sends null for an unpinned source, never an empty string', () => {
    // The regression proper. `""` would read downstream as "a pin exists",
    // where null is the documented, visibly-refused unpinned state.
    expect(registerDraft({ ...fields, pin: '' }).pin).toBeNull()
    expect(registerDraft({ ...fields, pin: '   ' }).pin).toBeNull()
  })

  it('carries a typed pin through, trimmed — it is not hard-coded away', () => {
    // The defect was `pin: null` regardless of input. If it ever returns,
    // this is what fails.
    expect(registerDraft({ ...fields, pin: 'b91a49f' }).pin).toBe('b91a49f')
    expect(registerDraft({ ...fields, pin: '  b91a49f  ' }).pin).toBe('b91a49f')
  })

  it('splits, trims and drops empty tags, and trims url and license', () => {
    const draft = registerDraft(fields)
    expect(draft.tags).toEqual(['a', 'b', 'c'])
    expect(draft.url).toBe('https://x/y')
    expect(draft.license).toBe('MIT')
    // Notes are free prose: kept verbatim, not trimmed into a different note.
    expect(draft.notes).toBe('n')
  })
})

describe('the reading desk renders (UI-DESIGN §4)', () => {
  it('offers the pin field, so a source can be registered studiable', () => {
    const html = renderToStaticMarkup(<StoaPanel />)
    // Without this input nothing on the Architect's side can set a pin, which
    // is the state the M5b exit demo walked into.
    expect(html).toContain('aria-label="pin"')
    for (const label of ['source url', 'tags', 'license', 'notes']) {
      expect(html, label).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain('REGISTER')
  })

  it('says out loud that watched-source content is data, not instructions', () => {
    // Invariant §13 / NFR-17 made visible: a governance rule nobody can see is
    // a rule nobody checks.
    const html = renderToStaticMarkup(<StoaPanel />)
    expect(html).toContain('untrusted data')
    expect(html).toContain('ADR-0017 R1')
  })

  it('shows empty states rather than a blank panel', () => {
    const html = renderToStaticMarkup(<StoaPanel />)
    expect(html).toContain('No sources registered.')
    expect(html).toContain('No briefs archived.')
  })

  it('reads an unpinned source as a dash, not as a blank', () => {
    const html = renderToStaticMarkup(<SourceRow row={source({ pin: null })} onRetire={() => {}} />)
    // The visible half of the same FR-13.2 state: unpinned must be legible as
    // unpinned, not as an empty gap the eye slides past.
    expect(html).toContain('pin: —')
    const pinned = renderToStaticMarkup(<SourceRow row={source()} onRetire={() => {}} />)
    expect(pinned).toContain('pin: b91a49f')
  })

  it('keeps retired sources on the list, struck through', () => {
    // Nothing is deleted: an archived citation must not look like it came from
    // nowhere.
    const html = renderToStaticMarkup(
      <SourceRow row={source({ retired: true })} onRetire={() => {}} />
    )
    expect(html).toContain('line-through')
    expect(html).toContain('SRC-001')
    // A retired source offers no RETIRE control.
    expect(html).not.toContain('RETIRE')
  })

  it('surfaces both degradation notes when a source cannot be studied', () => {
    const html = renderToStaticMarkup(
      <SourceRow
        row={source({ pin: null, blocked: 'no pin', intakeBlocked: 'license unverified' })}
        onRetire={() => {}}
      />
    )
    // Invariant §7: every degradation is visible, never a silent fallback.
    expect(html).toContain('no pin')
    expect(html).toContain('license unverified')
  })

  it('shows a brief closed, then its archived text once opened', () => {
    const row: BriefView = { id: 'RB-001', title: 'Orchestration autonomy', file: 'RB-001.md' }
    const closed = renderToStaticMarkup(<BriefCard row={row} text={undefined} onRead={() => {}} />)
    expect(closed).toContain('READ')
    expect(closed).not.toContain('<pre')
    const open = renderToStaticMarkup(
      <BriefCard row={row} text={'## Findings\n- cited'} onRead={() => {}} />
    )
    expect(open).toContain('<pre')
    expect(open).toContain('## Findings')
  })
})

describe('token discipline (invariant §12)', () => {
  it('paints the desk from tokens only — no hex literal reaches the markup', () => {
    const html = [
      renderToStaticMarkup(<StoaPanel />),
      renderToStaticMarkup(<SourceRow row={source()} onRetire={() => {}} />),
      renderToStaticMarkup(
        <BriefCard row={{ id: 'RB-001', title: 't', file: 'f' }} text="x" onRead={() => {}} />
      )
    ].join('\n')
    // "A hex literal in a component is a defect" — asserted on the rendered
    // output, which is where one would actually show up.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(html).toContain('var(--eph-')
  })
})
