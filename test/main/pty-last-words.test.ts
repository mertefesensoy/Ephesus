import { describe, expect, it } from 'vitest'
import {
  LAST_WORDS_BYTES,
  LAST_WORDS_REPORTED,
  attachRedactedStream,
  readableTail,
  type PtyDataSource
} from '../../src/main/pty-stream'
import type { RedactionFilter } from '../../src/shared/redaction'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/**
 * An agent that dies takes its terminal with it. Until this existed the harness
 * kept nothing — a crash was an exit code and a shrug — and the real one-hour
 * run on 2026-09-05 stopped there: agents exiting 1 within a second of a wake,
 * with no way to ask them why.
 */
describe('an agent’s last words', () => {
  function source(): PtyDataSource & {
    emit(data: string): void
    end(code: number): void
  } {
    let onData: (d: string) => void = () => {}
    let onExit: (e: { exitCode: number }) => void = () => {}
    return {
      onData: (cb) => {
        onData = cb
      },
      onExit: (cb) => {
        onExit = cb
      },
      emit: (d) => onData(d),
      end: (code) => onExit({ exitCode: code })
    }
  }

  function attach(filter: RedactionFilter = { push: (c) => c, flush: () => '' }) {
    const src = source()
    const words: string[] = []
    const exits: number[] = []
    attachRedactedStream({
      id: 'agent.a',
      source: src,
      filter,
      sink: () => null,
      onExit: (code) => exits.push(code),
      onLastWords: (tail) => words.push(tail)
    })
    return { src, words, exits }
  }

  it('keeps what the process said, and hands it over on exit', () => {
    const r = attach()
    r.src.emit('Error: something went wrong\n')
    r.src.end(1)

    expect(r.words).toEqual(['Error: something went wrong'])
  })

  /** The record is the point: an empty tail says nothing, and must not lie. */
  it('is empty when the process said nothing', () => {
    const r = attach()
    r.src.end(1)
    expect(r.words).toEqual([''])
  })

  it('reports before the exit is handled, so the row can carry it', () => {
    const order: string[] = []
    const src = source()
    attachRedactedStream({
      id: 'agent.a',
      source: src,
      filter: { push: (c) => c, flush: () => '' },
      sink: () => null,
      onExit: () => order.push('exit'),
      onLastWords: () => order.push('lastWords')
    })
    src.end(1)
    expect(order).toEqual(['lastWords', 'exit'])
  })

  /**
   * It reaches `log.jsonl`, which is committed and must never carry a secret
   * (ADR-0010, NFR-8). Fed from the REDACTED stream, so the filter's output is
   * what is kept — never the raw bytes.
   */
  it('keeps only what the redaction filter passed', () => {
    const r = attach({
      push: (chunk) => chunk.replace('sk-live-SECRET', '[redacted]'),
      flush: () => ''
    })
    r.src.emit('token was sk-live-SECRET here')
    r.src.end(1)

    expect(r.words[0]).toContain('[redacted]')
    expect(r.words[0]).not.toContain('SECRET')
  })

  it('includes the filter’s flushed tail, which a mid-match filter still holds', () => {
    const r = attach({ push: () => '', flush: () => 'held-back-tail' })
    r.src.emit('anything')
    r.src.end(1)
    expect(r.words[0]).toBe('held-back-tail')
  })

  it('keeps the NEWEST bytes when a process talks more than the bound', () => {
    const r = attach()
    r.src.emit('x'.repeat(LAST_WORDS_BYTES * 2))
    r.src.emit('THE-END')
    r.src.end(1)

    expect(r.words[0]?.endsWith('THE-END')).toBe(true)
    expect(r.words[0]?.length).toBeLessThanOrEqual(LAST_WORDS_REPORTED)
  })
})

describe('readableTail', () => {
  it('strips a real terminal frame down to its words', () => {
    const frame =
      `${ESC}[2J${ESC}[H${ESC}[38;5;204m` +
      `Error: ENOENT` +
      `${ESC}[0m\r\n${ESC}]0;claude${BEL}` +
      `  at spawn (node:internal)`

    expect(readableTail(frame)).toBe('Error: ENOENT at spawn (node:internal)')
  })

  it('leaves ordinary text alone', () => {
    expect(readableTail('plain words')).toBe('plain words')
  })

  it('is empty for a frame that is nothing but choreography', () => {
    expect(readableTail(`${ESC}[2J${ESC}[H${ESC}[0m`)).toBe('')
  })

  it('bounds what it returns, keeping the end', () => {
    const out = readableTail('a'.repeat(LAST_WORDS_REPORTED * 3) + 'TAIL')
    expect(out.length).toBe(LAST_WORDS_REPORTED)
    expect(out.endsWith('TAIL')).toBe(true)
  })
})
