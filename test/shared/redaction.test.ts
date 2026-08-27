import { describe, expect, it } from 'vitest'
import {
  createRedactor,
  REDACTION_MIN_LENGTH,
  SECRET_MASK,
  type RedactionFilter
} from '../../src/shared/redaction'

/**
 * The redaction filter (ADR-0010), asserted as a pure stream transform. The
 * cases that matter are the ones a naive `replaceAll` gets wrong: a credential
 * split across two PTY chunks, and ordinary output being delayed because the
 * filter is hoarding a window "just in case".
 *
 * Fixture values are scanner-neutral by the project's own M1-audit ruling: no
 * string here has a real provider's prefix.
 */

function drain(filter: RedactionFilter, chunks: readonly string[]): string {
  return chunks.map((chunk) => filter.push(chunk)).join('') + filter.flush()
}

const TOKEN = 'not-a-real-credential-0123456789'

describe('masking', () => {
  it('masks a planted value in a single chunk, visibly', () => {
    const filter = createRedactor(() => [TOKEN])
    const out = drain(filter, [`export TOK=${TOKEN}\r\n`])
    expect(out).toBe(`export TOK=${SECRET_MASK}\r\n`)
    expect(out).not.toContain(TOKEN)
    // ADR-0010: the mask announces itself so confusion is diagnosable.
    expect(out).toContain(SECRET_MASK)
  })

  it('masks every occurrence, not just the first', () => {
    const filter = createRedactor(() => [TOKEN])
    expect(drain(filter, [`${TOKEN} and ${TOKEN}`])).toBe(`${SECRET_MASK} and ${SECRET_MASK}`)
  })

  it('masks a value split across chunk boundaries', () => {
    const filter = createRedactor(() => [TOKEN])
    // A PTY hands out whatever the kernel had ready; this is the real shape.
    const out = drain(filter, ['echo $TOK\r\nnot-a-real-cre', 'dential-0123456789\r\n'])
    expect(out).toBe(`echo $TOK\r\n${SECRET_MASK}\r\n`)
    expect(out).not.toContain('dential')
  })

  it('masks a value split one character at a time', () => {
    const filter = createRedactor(() => [TOKEN])
    expect(drain(filter, [...TOKEN])).toBe(SECRET_MASK)
  })

  it('masks the longest matching value when secrets share a prefix', () => {
    const short = 'shared-prefix-value'
    const long = `${short}-with-more`
    const filter = createRedactor(() => [short, long])
    const out = drain(filter, [`${long}\r\n`])
    expect(out).toBe(`${SECRET_MASK}\r\n`)
    // The short secret masking first would have left "-with-more" in the clear.
    expect(out).not.toContain('-with-more')
  })

  it('reads the secret list on every chunk, so a value set mid-stream is masked', () => {
    const values: string[] = []
    const filter = createRedactor(() => values)
    expect(filter.push(`${TOKEN} before\r\n`)).toContain(TOKEN)
    values.push(TOKEN)
    expect(filter.push(`${TOKEN} after\r\n`)).toBe(`${SECRET_MASK} after\r\n`)
  })
})

describe('latency', () => {
  it('holds nothing back when output cannot be the start of a secret', () => {
    const filter = createRedactor(() => [TOKEN])
    // Nothing may be delayed: a filter that hoards a fixed window would stall
    // the last characters of every prompt the engine draws.
    expect(filter.push('$ ')).toBe('$ ')
    expect(filter.push('ready> ')).toBe('ready> ')
    expect(filter.flush()).toBe('')
  })

  it('holds back only a genuine partial prefix, and releases it when it cannot complete', () => {
    const filter = createRedactor(() => [TOKEN])
    expect(filter.push('value: not-a-real')).toBe('value: ')
    // The next chunk proves it was not the secret after all — nothing is lost.
    expect(filter.push('ity check\r\n')).toBe('not-a-reality check\r\n')
  })

  it('emits a held partial prefix on flush, so no bytes are lost at exit', () => {
    const filter = createRedactor(() => [TOKEN])
    expect(filter.push('tail: not-a-real-cre')).toBe('tail: ')
    expect(filter.flush()).toBe('not-a-real-cre')
  })

  it('is a pass-through when the broker holds nothing', () => {
    const filter = createRedactor(() => [])
    expect(drain(filter, ['anything at all\r\n'])).toBe('anything at all\r\n')
  })
})

describe('safety floor', () => {
  it('never masks a value shorter than the floor', () => {
    const tiny = 'a'.repeat(REDACTION_MIN_LENGTH - 1)
    const filter = createRedactor(() => [tiny])
    // Masking a 3-character "secret" would shred every terminal that prints
    // those characters — more damage than the leak it prevents.
    expect(drain(filter, ['banana bread'])).toBe('banana bread')
  })

  it('masks a value exactly at the floor', () => {
    const atFloor = 'a'.repeat(REDACTION_MIN_LENGTH)
    const filter = createRedactor(() => [atFloor])
    expect(drain(filter, [`x ${atFloor} y`])).toBe(`x ${SECRET_MASK} y`)
  })

  it('ignores an empty value without masking the whole stream', () => {
    const filter = createRedactor(() => [''])
    expect(drain(filter, ['unchanged'])).toBe('unchanged')
  })
})
