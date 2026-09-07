import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { reasonsFor } from '../../src/shared/parse-reasons'

/**
 * How a schema refusal is worded (M8.9, invariant §8).
 *
 * The live defect this exists for: every root-cause verdict the company has
 * ever received — three of three on the Architect's machine — was refused with
 * `because: Too big: expected string to have <=2000 characters`, and nothing in
 * that sentence tells the verifier how far over it went.
 */

const schema = z
  .object({
    because: z.string().min(1).max(2_000),
    read: z.array(z.string()).max(16),
    verdict: z.enum(['agree', 'refute'])
  })
  .strict()

const reasons = (raw: unknown): readonly string[] => {
  const parsed = schema.safeParse(raw)
  if (parsed.success) throw new Error('fixture parsed; it is meant to fail')
  return reasonsFor(parsed.error, 'root-cause verdict', raw)
}

describe('reasonsFor (the words an agent reads when it is refused)', () => {
  it('names the limit AND how far over the value actually went', () => {
    const [reason] = reasons({ because: 'x'.repeat(4_231), read: [], verdict: 'agree' })
    // Both numbers, because one of them alone is not actionable: "the limit is
    // 2000" does not say whether to cut fifty characters or four thousand.
    expect(reason).toBe('because: 4231 characters, and the limit is 2000')
  })

  it('counts a too-long array in items, not characters', () => {
    const [reason] = reasons({
      because: 'short',
      read: Array.from({ length: 21 }, (_, i) => String(i)),
      verdict: 'agree'
    })
    expect(reason).toBe('read: 21 items, and the limit is 16')
  })

  it('names the minimum and what was sent when a value is too short', () => {
    const [reason] = reasons({ because: '', read: [], verdict: 'agree' })
    expect(reason).toBe('because: 0 characters, and at least 1 is required')
  })

  it('leaves every other kind of issue in the words zod wrote', () => {
    // A checker that paraphrases EVERY refusal is a second place refusals can
    // drift from the schema producing them. Only the size family is re-worded.
    const [reason] = reasons({ because: 'ok', read: [], verdict: 'maybe' })
    expect(reason).toMatch(/^verdict: /)
    expect(reason).not.toMatch(/the limit is/)
  })

  it('names the document, not an empty path, for a root-level issue', () => {
    const [reason] = reasons('not an object at all')
    expect(reason).toMatch(/^root-cause verdict: /)
  })

  it('still refuses when the size cannot be measured from the raw value', () => {
    // The path walk returns undefined for a value that is not where the schema
    // looked. The refusal must still name the limit rather than throw or
    // silently report a size of zero.
    const error = new z.ZodError([
      {
        code: 'too_big',
        origin: 'string',
        maximum: 2_000,
        inclusive: true,
        path: ['because'],
        message: 'Too big'
      }
    ])
    expect(reasonsFor(error, 'root-cause verdict', { unrelated: true })).toEqual([
      'because: over the limit — the limit is 2000'
    ])
  })
})
