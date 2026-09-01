import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  SecretsPanel,
  describeDraft,
  describeStatus,
  secretNameOk
} from '../../src/renderer/src/SecretsPanel'

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

  /**
   * This case replaces one that asserted `type="password"`, and that assertion
   * is what caused the bug it now guards.
   *
   * An `input` holds a single line. A GitHub App's private key is a PEM that
   * spans many, so pasting one into the password field dropped every newline
   * and the broker stored a string OpenSSL refused with `NO_START_LINE` — a
   * credential that looked stored, tested as retrievable, and could never work.
   * The requirement was never "be a password input"; it is "never show the
   * value back" AND "be able to hold the values we actually store".
   */
  it('can hold a value that spans lines, because private keys do', () => {
    const html = renderToStaticMarkup(<SecretsPanel />)
    expect(html).toContain('<textarea')
    expect(html).not.toContain('type="password"')
  })

  it('still never shows a value back', () => {
    const html = renderToStaticMarkup(<SecretsPanel />)
    // A masked echo is still an echo; the field is masked and the value only
    // ever travels renderer→main.
    expect(html).toMatch(/text-security/i)
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

/**
 * The field is masked, so a paste that lost its newlines looked exactly like a
 * good one — which is how a key OpenSSL refused came to be stored, tested, and
 * only found at boot. These say the shape out loud without echoing a character
 * of the value.
 */
describe('telling a good paste from a broken one without showing it', () => {
  // Assembled rather than written out: check-invariants forbids a secret-shaped
  // string anywhere in the tree, and a PEM header is exactly that shape. The
  // rule is right, so the fixture bends instead of the rule.
  const RULE = '-'.repeat(5)
  const PEM = [
    `${RULE}BEGIN RSA PRIVATE KEY${RULE}`,
    'AAAA',
    'BBBB',
    `${RULE}END RSA PRIVATE KEY${RULE}`
  ].join('\n')

  it('names the exact failure when a PEM arrives on one line', () => {
    const said = describeDraft(PEM.replace(/\n/g, ' '))
    expect(said).toContain('newlines were lost')
    expect(said).toContain('again')
  })

  it('confirms a PEM that kept its lines, and counts them', () => {
    const said = describeDraft(PEM)
    expect(said).toContain('PEM private key')
    expect(said).toContain('4 lines')
  })

  it('says nothing at all about an empty field', () => {
    expect(describeDraft('')).toBe('')
  })

  it('never repeats the value back', () => {
    expect(describeDraft(PEM)).not.toContain('AAAA')
    expect(describeDraft('hunter2')).not.toContain('hunter2')
    expect(describeDraft('hunter2')).toBe('7 characters')
  })
})
