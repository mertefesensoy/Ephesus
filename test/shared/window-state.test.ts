import { describe, expect, it } from 'vitest'
import { sanitizeBounds, windowBoundsSchema } from '../../src/shared/window-state'

const primary = { x: 0, y: 0, width: 1920, height: 1080 }

describe('windowBoundsSchema', () => {
  const rejects: Array<[label: string, raw: unknown]> = [
    ['null', null],
    ['missing height', { x: 0, y: 0, width: 800 }],
    ['fractional', { x: 0.5, y: 0, width: 800, height: 600 }],
    ['too small', { x: 0, y: 0, width: 100, height: 100 }],
    ['absurdly large', { x: 0, y: 0, width: 99999, height: 600 }],
    ['extra key', { x: 0, y: 0, width: 800, height: 600, z: 1 }]
  ]
  it.each(rejects)('rejects %s', (_label, raw) => {
    expect(windowBoundsSchema.safeParse(raw).success).toBe(false)
  })
})

describe('sanitizeBounds', () => {
  it('accepts bounds on a live display', () => {
    const b = { x: 100, y: 100, width: 1280, height: 800 }
    expect(sanitizeBounds(b, [primary])).toEqual(b)
  })

  it('returns null for malformed rows', () => {
    expect(sanitizeBounds({ x: 'a' }, [primary])).toBeNull()
    expect(sanitizeBounds(null, [primary])).toBeNull()
  })

  it('returns null when the window would land off every display', () => {
    const stranded = { x: 5000, y: 5000, width: 1280, height: 800 }
    expect(sanitizeBounds(stranded, [primary])).toBeNull()
  })

  it('accepts bounds on a secondary display that still exists', () => {
    const second = { x: 1920, y: 0, width: 1920, height: 1080 }
    const onSecond = { x: 2000, y: 50, width: 1280, height: 800 }
    expect(sanitizeBounds(onSecond, [primary, second])).toEqual(onSecond)
    expect(sanitizeBounds(onSecond, [primary])).toBeNull() // monitor unplugged
  })

  it('returns null with no displays at all', () => {
    expect(sanitizeBounds({ x: 0, y: 0, width: 800, height: 600 }, [])).toBeNull()
  })
})
