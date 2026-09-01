import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SecretsPanel, describeStatus, secretNameOk } from '../../src/renderer/src/SecretsPanel'

/**
 * The broker's only surface (ADR-0010, FR-11.4).
 *
 * The broker itself has been tested since M3.1 and was reachable from nowhere:
 * `secrets:set` was wired through main and exposed on the preload bridge, and
 * no component ever called it. Five hire templates declare `envGrants:
 * ["GH_TOKEN"]`, so every one of them spawned with `grantsMissing:
 * ["GH_TOKEN"]` and there was no place in the app to fix it — a green suite
 * over a feature nothing could reach, which is the M6 lesson exactly.
 *
 * Static markup, no DOM — the M6.1 harness pattern.
 */
describe('the credentials desk', () => {
  it('offers the names the built-in profiles actually declare', () => {
    const html = renderToStaticMarkup(<SecretsPanel />)
    expect(html).toContain('GH_TOKEN')
  })

  it('never renders an input that would show a value back', () => {
    const html = renderToStaticMarkup(<SecretsPanel />)
    // Write-only is not a convention here, it is the type of the field: a
    // masked echo is still an echo, and the reason people think it is safe.
    expect(html).toContain('type="password"')
    expect(html).not.toContain('type="text"')
  })

  it('says the value only ever travels one way', () => {
    expect(renderToStaticMarkup(<SecretsPanel />)).toContain('never read back')
  })
})

describe('what the Architect is told about a credential', () => {
  it('distinguishes never-checked from checked-and-absent', () => {
    // These are different facts and collapsing them is how someone concludes a
    // secret is missing when the bridge was simply not up.
    expect(describeStatus(null)).toBe('not checked')
    expect(describeStatus({ name: 'GH_TOKEN', present: false, lastRotated: null })).toBe('not set')
  })

  it('reports presence and a rotation date, and nothing about the value', () => {
    const said = describeStatus({
      name: 'GH_TOKEN',
      present: true,
      lastRotated: '2026-09-01T11:45:00.000Z'
    })
    expect(said).toContain('set')
    expect(said).toContain('2026-09-01 11:45')
    expect(said).not.toMatch(/length|char|\*{2,}/i)
  })
})

describe('the name field refuses before the round trip', () => {
  it('accepts the shape the broker accepts', () => {
    expect(secretNameOk('GH_TOKEN')).toBe(true)
    expect(secretNameOk('GH_APP_PRIVATE_KEY')).toBe(true)
    expect(secretNameOk('A')).toBe(true)
  })

  it('refuses everything the broker would refuse', () => {
    expect(secretNameOk('')).toBe(false)
    expect(secretNameOk('gh_token')).toBe(false)
    expect(secretNameOk('9LIVES')).toBe(false)
    expect(secretNameOk('GH-TOKEN')).toBe(false)
    expect(secretNameOk('GH TOKEN')).toBe(false)
    expect(secretNameOk('X'.repeat(65))).toBe(false)
  })
})
