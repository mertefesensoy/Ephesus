import { describe, expect, it } from 'vitest'
import {
  decideRelaunch,
  describeRendererDeath,
  RENDERER_RELAUNCH_LIMIT,
  RENDERER_RELAUNCH_WINDOW_MS
} from '../../src/shared/renderer-health'

/**
 * The ladder that brings a dead window back without letting a crash loop spin.
 *
 * Found live on 2026-09-06: the renderer process was gone — `main`,
 * `gpu-process` and `utility` left, no renderer — while twenty engine processes
 * kept running and the scheduled sweeps kept firing. Nothing anywhere said so,
 * because nothing was listening for it.
 */

const T0 = 1_000_000

describe('decideRelaunch — a dead window comes back', () => {
  it('relaunches on the first death', () => {
    expect(decideRelaunch([T0], T0)).toEqual({ relaunch: true, recent: 1 })
  })

  it('keeps relaunching up to the limit', () => {
    const deaths: number[] = []
    for (let i = 1; i <= RENDERER_RELAUNCH_LIMIT; i++) {
      deaths.push(T0 + i)
      expect(decideRelaunch(deaths, T0 + i).relaunch).toBe(true)
    }
  })

  it('STOPS once the limit is passed, and says why', () => {
    // The failure this bounds is load → die → reload → die, which spends the
    // machine the agents are working on.
    const deaths = Array.from({ length: RENDERER_RELAUNCH_LIMIT + 1 }, (_, i) => T0 + i)
    const verdict = decideRelaunch(deaths, T0 + RENDERER_RELAUNCH_LIMIT)

    expect(verdict.relaunch).toBe(false)
    if (!verdict.relaunch) {
      expect(verdict.because).toContain(String(RENDERER_RELAUNCH_LIMIT + 1))
      // The Architect is told what still works and how to get the window back.
      expect(verdict.because).toContain('still running')
      expect(verdict.because).toContain('restarting the app')
    }
  })

  it('forgets deaths older than the window, so a slow trickle always relaunches', () => {
    // A renderer that dies once an hour is not looping, and each of those
    // deaths has earned its own relaunch.
    const old = Array.from({ length: 20 }, (_, i) => T0 + i)
    const now = T0 + RENDERER_RELAUNCH_WINDOW_MS + 5_000

    const verdict = decideRelaunch([...old, now], now)

    expect(verdict).toEqual({ relaunch: true, recent: 1 })
  })

  it('counts a death exactly at the window edge as outside it', () => {
    const now = T0 + RENDERER_RELAUNCH_WINDOW_MS
    // T0 is exactly one window ago: `now - at < WINDOW` is false, so it is out.
    expect(decideRelaunch([T0, now], now).recent).toBe(1)
  })

  it('reports how many deaths it counted either way', () => {
    // The number is what makes the report actionable — "died 4 times in 60s" is
    // a different problem from "died once".
    expect(decideRelaunch([T0, T0 + 1], T0 + 1).recent).toBe(2)
    const many = Array.from({ length: RENDERER_RELAUNCH_LIMIT + 3 }, (_, i) => T0 + i)
    expect(decideRelaunch(many, T0).recent).toBe(RENDERER_RELAUNCH_LIMIT + 3)
  })
})

describe('describeRendererDeath — what the Architect is told', () => {
  it('carries Electron’s own reason and exit code, not a word of ours', () => {
    // "out of memory", "the OS killed it" and "it crashed" need different
    // answers, and only the engine's own reason separates them.
    const detail = describeRendererDeath('oom', 9)

    expect(detail).toContain('oom')
    expect(detail).toContain('9')
  })

  it('says the company kept running, and that gates now have nobody', () => {
    // The white window is the symptom. The thing worth knowing is that agents
    // are still spending and a gate raised now cannot be answered.
    const detail = describeRendererDeath('crashed', 133)

    expect(detail).toContain('headless')
    expect(detail).toContain('gate')
  })
})
