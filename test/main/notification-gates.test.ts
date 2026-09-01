import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ClaudeAdapter } from '../../src/main/engines/claude'
import { PromptStore } from '../../src/main/prompts'
import { GateManager, wireGateChokePoints } from '../../src/main/watch/gates'
import type { GatePolicy } from '../../src/shared/gates'

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))

function adapter(): ClaudeAdapter {
  return new ClaudeAdapter({
    prompts: new PromptStore(path.join(BUNDLED_PROMPTS, '..', 'nowhere'), BUNDLED_PROMPTS),
    hookShimPath: 'shim'
  })
}

/**
 * Claude Code fires one `Notification` for two unrelated situations, and the
 * words are the only thing that separates them.
 *
 * This is not a style point. On the 2026-09-01 live run the Architect was asked
 * to answer ten permission gates; NINE of them carried "Claude is waiting for
 * your input" — an agent sitting idle at an empty prompt, packaged as though it
 * had asked for something. Approving one did nothing back, because `onSettled`
 * has no branch for `tool-permission`: the gate could not reach the engine at
 * all. A human was being interrupted to rubber-stamp an agent's silence.
 */
describe('what an engine notification actually meant', () => {
  it('reads the idle notice as idleness, not as a request', () => {
    expect(adapter().notificationKind({ message: 'Claude is waiting for your input' })).toBe(
      'waiting'
    )
  })

  it('reads a real permission prompt as a permission prompt', () => {
    expect(
      adapter().notificationKind({ message: 'Claude needs your permission to use Bash' })
    ).toBe('permission')
  })

  /**
   * The safe direction is explicit. A prompt mistaken for idleness strands an
   * agent with nobody told; idleness mistaken for a prompt merely annoys. When
   * the harness cannot tell, it must choose the annoying error.
   */
  it('answers null for wording it does not recognise, so the caller gates', () => {
    expect(adapter().notificationKind({ message: 'something new in a later version' })).toBeNull()
    expect(adapter().notificationKind({})).toBeNull()
    expect(adapter().notificationKind(null)).toBeNull()
  })
})

const POLICY: GatePolicy = { schemaVersion: 1, autonomy: 'autonomous', rules: [] }

function rig(over: {
  kind?: 'permission' | 'waiting' | null
  autonomy?: 'manual' | 'supervised' | 'autonomous' | null
}) {
  const opened: string[] = []
  const ungated: { kind: string; message: string }[] = []
  const gates = new GateManager({
    policy: () => POLICY,
    onOpen: (gate) => opened.push(gate.kind)
  })
  const chokes = wireGateChokePoints({
    gates,
    prompts: new PromptStore(path.join(BUNDLED_PROMPTS, '..', 'nowhere'), BUNDLED_PROMPTS),
    notificationKind: () => over.kind ?? null,
    autonomyFor: () => over.autonomy ?? null,
    onUngated: (_agentId, kind, message) => ungated.push({ kind, message })
  })
  return { chokes, opened, ungated }
}

describe('who an engine prompt is actually for', () => {
  it('never gates an idle agent, whatever the autonomy', () => {
    const r = rig({ kind: 'waiting', autonomy: 'manual' })
    r.chokes.submitNotification('agent.mason', { message: 'Claude is waiting for your input' })
    expect(r.opened).toEqual([])
    expect(r.ungated[0]?.kind).toBe('waiting')
  })

  /**
   * The Architect's own words, 2026-09-01: "a software architect does not
   * oversee intern's work". Autonomy is granted once, at activation; asking
   * again per tool call is the thing the grant exists to end.
   */
  it('does not gate a permission prompt for an agent granted autonomy', () => {
    const r = rig({ kind: 'permission', autonomy: 'autonomous' })
    r.chokes.submitNotification('agent.mason', { message: 'Claude needs your permission' })
    expect(r.opened).toEqual([])
    expect(r.ungated[0]?.kind).toBe('permission')
  })

  it('still gates a permission prompt below autonomous', () => {
    const r = rig({ kind: 'permission', autonomy: 'supervised' })
    r.chokes.submitNotification('agent.mason', { message: 'Claude needs your permission' })
    expect(r.opened).toEqual(['tool-permission'])
    expect(r.ungated).toEqual([])
  })

  it('gates wording it cannot classify, rather than assuming idleness', () => {
    const r = rig({ kind: null, autonomy: 'supervised' })
    r.chokes.submitNotification('agent.mason', { message: 'unrecognised' })
    expect(r.opened).toEqual(['tool-permission'])
  })

  it('records every prompt it declined to gate, so autonomy is not silence', () => {
    const r = rig({ kind: 'permission', autonomy: 'autonomous' })
    r.chokes.submitNotification('agent.mason', { message: 'Claude needs your permission' })
    expect(r.ungated).toHaveLength(1)
    expect(r.ungated[0]?.message).toContain('permission')
  })
})
