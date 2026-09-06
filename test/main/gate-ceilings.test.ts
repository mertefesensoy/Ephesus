import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gatePolicyView, loadGatePolicy, saveGateCeilings } from '../../src/main/watch/gates'
import { shippedGatePolicy } from '../../src/shared/gates'
import { removeTempDir } from '../tmpdir'

/**
 * The settings surface's write path (FR-11.7).
 *
 * The interesting cases are all refusals. A writer that patches the two
 * ceilings is three lines; what earns its own file is what it must NOT do —
 * take the deny-all fallback `loadGatePolicy` hands back for an unreadable
 * file, patch that, and write it, which would silently drop every gate rule
 * the Architect wrote while they were adjusting a safety dial.
 */

const dirs: string[] = []

function tempPolicy(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ceilings-'))
  dirs.push(dir)
  const file = path.join(dir, 'gate-policy.json')
  if (contents !== undefined) fs.writeFileSync(file, contents, 'utf8')
  return file
}

afterEach(() => {
  while (dirs.length > 0) removeTempDir(dirs.pop() as string)
})

const SHIPPED = `${JSON.stringify(shippedGatePolicy, null, 2)}\n`

describe('saveGateCeilings', () => {
  it('writes the autonomy ceiling and leaves every gate rule alone', () => {
    const file = tempPolicy(SHIPPED)

    const saved = saveGateCeilings(file, { autonomy: 'supervised', maxDailyTokens: null })

    expect(saved.ok).toBe(true)
    const after = loadGatePolicy(file)
    expect(after.warning).toBeNull()
    expect(after.policy.autonomy).toBe('supervised')
    // The rules table is the thing this must never touch.
    expect(after.policy.rules).toEqual(shippedGatePolicy.rules)
  })

  it('writes a budget ceiling a later read can enforce', () => {
    const file = tempPolicy(SHIPPED)

    saveGateCeilings(file, { autonomy: 'autonomous', maxDailyTokens: 40_000_000 })

    expect(loadGatePolicy(file).policy.maxDailyTokens).toBe(40_000_000)
  })

  it('removes the key for unbudgeted rather than writing a figure', () => {
    const file = tempPolicy(SHIPPED)
    saveGateCeilings(file, { autonomy: 'autonomous', maxDailyTokens: 40_000_000 })

    saveGateCeilings(file, { autonomy: 'autonomous', maxDailyTokens: null })

    // Absence, not zero and not null: on disk unbudgeted IS the missing key
    // (ADR-0029), and a zero would read as breached before the first token.
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')) as object)).not.toContain(
      'maxDailyTokens'
    )
    expect(loadGatePolicy(file).policy.maxDailyTokens).toBeUndefined()
  })

  it('refuses a corrupt policy WITHOUT overwriting it', () => {
    // The defect this function exists to prevent. `loadGatePolicy` answers a
    // corrupt file with deny-all — autonomy `manual`, rules EMPTY — so a writer
    // that patched what the loader returned would persist that: six gate rules
    // gone, and the file that could have been repaired gone with them.
    const file = tempPolicy('{ not json at all')

    const saved = saveGateCeilings(file, { autonomy: 'autonomous', maxDailyTokens: null })

    expect(saved.ok).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json at all')
  })

  it('refuses a policy that parses as JSON but not as a policy, unchanged', () => {
    const file = tempPolicy('{"schemaVersion":1,"autonomy":"whatever","rules":[]}')

    const saved = saveGateCeilings(file, { autonomy: 'supervised', maxDailyTokens: null })

    expect(saved.ok).toBe(false)
    if (saved.ok) throw new Error('unreachable')
    expect(saved.reason).toContain('autonomy')
    expect(fs.readFileSync(file, 'utf8')).toContain('whatever')
  })

  it('refuses a missing policy rather than creating one', () => {
    const file = tempPolicy()

    const saved = saveGateCeilings(file, { autonomy: 'autonomous', maxDailyTokens: null })

    expect(saved.ok).toBe(false)
    // Seeding from here would invent a policy the Architect never wrote, on the
    // one path where they cannot see what they are agreeing to.
    expect(fs.existsSync(file)).toBe(false)
  })

  it('leaves no temp file beside the policy', () => {
    const file = tempPolicy(SHIPPED)

    saveGateCeilings(file, { autonomy: 'supervised', maxDailyTokens: 1_000 })

    expect(fs.readdirSync(path.dirname(file))).toEqual(['gate-policy.json'])
  })

  it('reports the ceilings it wrote', () => {
    const file = tempPolicy(SHIPPED)

    const saved = saveGateCeilings(file, { autonomy: 'manual', maxDailyTokens: 500 })

    if (!saved.ok) throw new Error(saved.reason)
    expect(saved.view).toEqual({ autonomy: 'manual', maxDailyTokens: 500, warning: null })
  })
})

describe('gatePolicyView', () => {
  it('reports what is on disk', () => {
    const file = tempPolicy(SHIPPED)

    expect(gatePolicyView(file)).toEqual({
      autonomy: 'autonomous',
      maxDailyTokens: null,
      warning: null
    })
  })

  it('carries the warning when the panel is showing the deny-all fallback', () => {
    // Invariant §7: the panel must not render a degradation as a setting. A
    // `manual` ceiling nobody chose looks exactly like one somebody did.
    const view = gatePolicyView(tempPolicy())

    expect(view.autonomy).toBe('manual')
    expect(view.warning).toContain('missing')
  })
})
