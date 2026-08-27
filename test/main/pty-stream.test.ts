import { describe, expect, it } from 'vitest'
import { ptyDataChannel, ptyExitChannel } from '../../src/shared/ipc'
import { createRedactor, SECRET_MASK } from '../../src/shared/redaction'
import { attachRedactedStream, PASS_THROUGH, type PtyDataSource } from '../../src/main/pty-stream'

/**
 * The wiring ADR-0010 actually depends on: bytes leave a process, pass through
 * the filter, and only then reach the renderer. The pure filter is asserted in
 * test/shared/redaction.test.ts and the broker's in test/main/secrets.test.ts —
 * this file exists because both of those stayed green when the production call
 * to `filter.push` was removed, which is the failure that matters.
 *
 * Fixture values are scanner-neutral (M1-audit ruling).
 */

const TOKEN = 'not-a-real-credential-0123456789'

/** A process whose stream the test drives by hand. */
class ScriptedProcess implements PtyDataSource {
  private data: ((chunk: string) => void) | null = null
  private exit: ((event: { exitCode: number }) => void) | null = null
  onData(cb: (chunk: string) => void): void {
    this.data = cb
  }
  onExit(cb: (event: { exitCode: number }) => void): void {
    this.exit = cb
  }
  emit(chunk: string): void {
    this.data?.(chunk)
  }
  die(exitCode = 0): void {
    this.exit?.({ exitCode })
  }
}

function rig(secrets: readonly string[] = [TOKEN]) {
  const sent: { channel: string; payload: string | number }[] = []
  const source = new ScriptedProcess()
  const exits: number[] = []
  attachRedactedStream({
    id: 'agent.mason',
    source,
    filter: secrets.length === 0 ? PASS_THROUGH : createRedactor(() => secrets),
    sink: () => ({ send: (channel, payload) => sent.push({ channel, payload }) }),
    onExit: (code) => exits.push(code)
  })
  const streamed = (): string =>
    sent
      .filter((s) => s.channel === ptyDataChannel('agent.mason'))
      .map((s) => String(s.payload))
      .join('')
  return { source, sent, exits, streamed }
}

describe('the outbound edge (S-SECRETS)', () => {
  it('masks a credential before it reaches the renderer', () => {
    const { source, streamed } = rig()
    source.emit(`leaking ${TOKEN} now\r\n`)
    expect(streamed()).toBe(`leaking ${SECRET_MASK} now\r\n`)
    expect(streamed()).not.toContain(TOKEN)
  })

  it('masks a credential torn across two reads', () => {
    const { source, streamed } = rig()
    source.emit('split:not-a-real-cre')
    source.emit('dential-0123456789\r\n')
    expect(streamed()).toBe(`split:${SECRET_MASK}\r\n`)
  })

  it('forwards ordinary output on the pty:data channel, unchanged', () => {
    const { source, sent, streamed } = rig()
    source.emit('$ ready\r\n')
    expect(streamed()).toBe('$ ready\r\n')
    expect(sent[0]?.channel).toBe('pty:data:agent.mason')
  })

  it('sends nothing when the filter is holding everything back', () => {
    const { source, sent } = rig()
    source.emit('not-a-real-cre')
    // An empty send would blank nothing but still cost an IPC hop per chunk.
    expect(sent).toHaveLength(0)
  })

  it('flushes the held tail on exit, so no bytes are lost', () => {
    const { source, streamed } = rig()
    source.emit('tail: not-a-real-cre')
    expect(streamed()).toBe('tail: ')
    source.die(0)
    expect(streamed()).toBe('tail: not-a-real-cre')
  })

  it('reports the exit code after the flush, on its own channel', () => {
    const { source, sent, exits } = rig()
    source.emit('bye\r\n')
    source.die(3)
    expect(exits).toEqual([3])
    expect(sent.at(-1)).toEqual({ channel: ptyExitChannel('agent.mason'), payload: 3 })
  })

  it('is a pass-through when no broker is wired', () => {
    const { source, streamed } = rig([])
    source.emit(`${TOKEN}\r\n`)
    expect(streamed()).toBe(`${TOKEN}\r\n`)
  })

  it('survives a sink that is not there yet', () => {
    const source = new ScriptedProcess()
    const exits: number[] = []
    attachRedactedStream({
      id: 'agent.mason',
      source,
      filter: PASS_THROUGH,
      // A window closed or not yet created: bytes are dropped, never thrown on.
      sink: () => null,
      onExit: (code) => exits.push(code)
    })
    expect(() => {
      source.emit('into the void\r\n')
      source.die(0)
    }).not.toThrow()
    expect(exits).toEqual([0])
  })
})
