import { describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA_VERSION, defaultConfig, parseConfig } from '../../src/shared/config'

describe('config validator (src/shared/config.ts)', () => {
  it('accepts the default config', () => {
    expect(parseConfig(defaultConfig)).toEqual({ schemaVersion: CONFIG_SCHEMA_VERSION })
  })

  // Table-driven rejects per TEST-STRATEGY §2 (unit: schema validators).
  const rejects: Array<[label: string, raw: unknown]> = [
    ['null', null],
    ['empty object (missing schemaVersion)', {}],
    ['wrong schemaVersion', { schemaVersion: 999 }],
    ['schemaVersion of wrong type', { schemaVersion: '1' }],
    ['unknown extra key (strict schema)', { schemaVersion: CONFIG_SCHEMA_VERSION, apiKey: 'x' }],
    ['array', []],
    ['string', 'schemaVersion: 1']
  ]

  it.each(rejects)('rejects %s', (_label, raw) => {
    expect(() => parseConfig(raw)).toThrow()
  })

  it('does not mutate its input', () => {
    const raw = { schemaVersion: CONFIG_SCHEMA_VERSION }
    const parsed = parseConfig(raw)
    expect(parsed).not.toBe(raw)
    expect(raw).toEqual({ schemaVersion: CONFIG_SCHEMA_VERSION })
  })
})
