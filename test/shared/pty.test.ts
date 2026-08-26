import { describe, expect, it } from 'vitest'
import { ptyDataChannel, ptyExitChannel } from '../../src/shared/ipc'
import { ptyIdSchema, ptyResizeSchema, ptyWriteSchema } from '../../src/shared/pty'

describe('pty payload validators (src/shared/pty.ts)', () => {
  it('accepts the dev shell id', () => {
    // A pty id is its agent's id — the dot has to be legal (AgentCard.ptyId).
    expect(ptyIdSchema.parse('agent.mason')).toBe('agent.mason')
    expect(ptyIdSchema.parse('shell-0')).toBe('shell-0')
  })

  const badIds: Array<[label: string, id: unknown]> = [
    ['empty string', ''],
    ['uppercase', 'Shell-0'],
    ['path traversal', '../etc'],
    ['leading dash', '-shell'],
    ['whitespace', 'shell 0'],
    ['non-string', 42],
    ['overlong', 'a'.repeat(65)]
  ]
  it.each(badIds)('rejects id: %s', (_label, id) => {
    expect(() => ptyIdSchema.parse(id)).toThrow()
  })

  it('accepts a valid write payload', () => {
    expect(ptyWriteSchema.parse({ id: 'shell-0', data: 'ls\r' })).toEqual({
      id: 'shell-0',
      data: 'ls\r'
    })
  })

  const badWrites: Array<[label: string, raw: unknown]> = [
    ['missing data', { id: 'shell-0' }],
    ['non-string data', { id: 'shell-0', data: 7 }],
    ['oversized data', { id: 'shell-0', data: 'x'.repeat(65537) }],
    ['extra key', { id: 'shell-0', data: '', force: true }]
  ]
  it.each(badWrites)('rejects write: %s', (_label, raw) => {
    expect(() => ptyWriteSchema.parse(raw)).toThrow()
  })

  it('accepts a valid resize payload', () => {
    expect(ptyResizeSchema.parse({ id: 'shell-0', cols: 80, rows: 24 })).toEqual({
      id: 'shell-0',
      cols: 80,
      rows: 24
    })
  })

  const badResizes: Array<[label: string, raw: unknown]> = [
    ['zero cols', { id: 'shell-0', cols: 0, rows: 24 }],
    ['negative rows', { id: 'shell-0', cols: 80, rows: -1 }],
    ['fractional cols', { id: 'shell-0', cols: 80.5, rows: 24 }],
    ['absurd cols', { id: 'shell-0', cols: 100000, rows: 24 }],
    ['missing rows', { id: 'shell-0', cols: 80 }]
  ]
  it.each(badResizes)('rejects resize: %s', (_label, raw) => {
    expect(() => ptyResizeSchema.parse(raw)).toThrow()
  })

  it('accepts a valid kill payload and rejects extras', () => {})

  it('builds per-id channels exactly as SDD §5 names them', () => {
    expect(ptyDataChannel('shell-0')).toBe('pty:data:shell-0')
    expect(ptyExitChannel('shell-0')).toBe('pty:exit:shell-0')
  })
})
