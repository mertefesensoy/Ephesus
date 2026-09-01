import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeClaudeSettings } from '../../../src/main/engines/claude'
import { PromptStore } from '../../../src/main/prompts'
import { usageReportSchema } from '../../../src/shared/pacing'

/**
 * The observation end of usage-aware pacing (ADR-0023): the settings the
 * adapter installs, and the shim those settings run.
 *
 * The statusline payload used here is **verbatim from a real render**. On
 * 2026-09-01 a `claude` (2.1.252) was spawned in a node-pty pseudo-terminal —
 * the way this harness spawns agents — with a `statusLine` command that
 * appended its stdin to a file. The third render carried exactly this
 * `rate_limits` block. Nothing about the shape below is inferred.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../../prompts/', import.meta.url))
const SHIM = fileURLToPath(new URL('../../../shims/eph-usage.mjs', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function prompts(): PromptStore {
  return new PromptStore('x', BUNDLED_PROMPTS)
}

/** The captured render, trimmed to the fields the shim reads. */
const REAL_STATUS = {
  session_id: '0fd850ec-e990-4ecb-92cc-4ba23df2271c',
  version: '2.1.252',
  model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
  context_window: { context_window_size: 200000, used_percentage: 21 },
  rate_limits: {
    five_hour: { used_percentage: 12, resets_at: 1788294000 },
    seven_day: { used_percentage: 28.999999999999996, resets_at: 1788753600 }
  }
}

function runShim(input: unknown, out: string | null): { stdout: string } {
  const args = out === null ? [SHIM] : [SHIM, '--out', out]
  const stdout = execFileSync(process.execPath, args, {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8'
  })
  return { stdout }
}

describe('the statusline block the adapter installs', () => {
  it('runs our shim and points it at the harness usage file', () => {
    const settings = JSON.parse(
      mergeClaudeSettings(null, {
        prompts: prompts(),
        hookShimPath: 'hook-shim',
        usageShimPath: '/app/shims/eph-usage.mjs',
        usageStatusPath: '/home/usage.json'
      })
    ) as Record<string, Record<string, string>>
    expect(settings['statusLine']?.['type']).toBe('command')
    expect(settings['statusLine']?.['command']).toContain('eph-usage.mjs')
    expect(settings['statusLine']?.['command']).toContain('/home/usage.json')
  })

  it('installs nothing when the harness supplied no shim', () => {
    // Pacing is a governor, not an interlock: a harness assembled without the
    // observation point behaves exactly as it did before.
    const settings = JSON.parse(
      mergeClaudeSettings(null, { prompts: prompts(), hookShimPath: 'hook-shim' })
    ) as Record<string, unknown>
    expect(settings['statusLine']).toBeUndefined()
  })

  it("leaves the Architect's own status line alone", () => {
    // Their status line is a surface they were already using. We do not take
    // it; we simply do not observe, and pacing runs on `unobserved`.
    const mine = { type: 'command', command: 'my-own-statusline.sh' }
    const settings = JSON.parse(
      mergeClaudeSettings(JSON.stringify({ statusLine: mine }), {
        prompts: prompts(),
        hookShimPath: 'hook-shim',
        usageShimPath: '/app/shims/eph-usage.mjs',
        usageStatusPath: '/home/usage.json'
      })
    ) as Record<string, unknown>
    expect(settings['statusLine']).toEqual(mine)
  })

  it('replaces its own previous install rather than accumulating', () => {
    // The same failure the hook merge already had to close: the base is re-read
    // from disk per agent, so several agents in one working directory merge
    // into each other's output.
    const deps = {
      prompts: prompts(),
      hookShimPath: 'hook-shim',
      usageShimPath: '/app/shims/eph-usage.mjs',
      usageStatusPath: '/home/usage.json'
    }
    const once = mergeClaudeSettings(null, deps)
    const twice = mergeClaudeSettings(once, deps)
    expect(JSON.parse(twice)).toEqual(JSON.parse(once))
  })
})

describe('eph-usage.mjs — the shim itself', () => {
  it('turns a real render into a usable report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usage-shim-'))
    temps.push(dir)
    const out = path.join(dir, 'usage.json')

    const { stdout } = runShim(REAL_STATUS, out)

    const report = usageReportSchema.parse(JSON.parse(fs.readFileSync(out, 'utf8')))
    expect(report.fiveHour?.usedPercent).toBe(12)
    expect(report.sevenDay?.usedPercent).toBeCloseTo(29)
    // Epoch SECONDS on the wire, epoch MILLISECONDS in the harness — converted
    // once, at the boundary, so nothing downstream has to remember the unit.
    expect(report.fiveHour?.resetsAt).toBe(1788294000 * 1000)
    expect(report.sevenDay?.resetsAt).toBe(1788753600 * 1000)
    // And the Architect sees the same number the harness is steering on.
    expect(stdout).toContain('5h 12%')
    expect(stdout).toContain('7d 29%')
  })

  it('writes a report saying "nothing" when the engine reported no limits', () => {
    // The first render of every session has no rate_limits at all — the engine
    // documents it as arriving only after the first API response, and it did
    // exactly that in the captured run. "We looked and there was nothing" is a
    // fact the harness needs; its ABSENCE is what says the shim is not running.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usage-shim-'))
    temps.push(dir)
    const out = path.join(dir, 'usage.json')

    const { session_id, version, model, context_window } = REAL_STATUS
    runShim({ session_id, version, model, context_window }, out)

    const report = usageReportSchema.parse(JSON.parse(fs.readFileSync(out, 'utf8')))
    expect(report.fiveHour).toBeNull()
    expect(report.sevenDay).toBeNull()
  })

  it('keeps one window when the engine reports only one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usage-shim-'))
    temps.push(dir)
    const out = path.join(dir, 'usage.json')
    runShim({ rate_limits: { five_hour: { used_percentage: 7, resets_at: 1788294000 } } }, out)
    const report = usageReportSchema.parse(JSON.parse(fs.readFileSync(out, 'utf8')))
    expect(report.fiveHour?.usedPercent).toBe(7)
    expect(report.sevenDay).toBeNull()
  })

  it('fails open on input that is not JSON', () => {
    // The status line renders on the agent's critical path. A shim that threw
    // or exited non-zero would cost the agent its turn over a telemetry file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usage-shim-'))
    temps.push(dir)
    const out = path.join(dir, 'usage.json')
    expect(() => runShim('not json at all', out)).not.toThrow()
    const report = usageReportSchema.parse(JSON.parse(fs.readFileSync(out, 'utf8')))
    expect(report.fiveHour).toBeNull()
  })

  it('fails open when it cannot write where it was told to', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usage-shim-'))
    temps.push(dir)
    // A plain FILE standing where the shim expects a directory: the mkdir and
    // the write both fail, which is the realistic version of a bad path.
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'not a directory', 'utf8')
    const { stdout } = runShim(REAL_STATUS, path.join(blocker, 'usage.json'))
    // Still renders the status line for the Architect, having reported the
    // trouble on stderr only.
    expect(stdout).toContain('5h 12%')
  })

  it('ignores a window whose numbers make no sense', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usage-shim-'))
    temps.push(dir)
    const out = path.join(dir, 'usage.json')
    runShim(
      {
        rate_limits: {
          five_hour: { used_percentage: 'lots', resets_at: 1788294000 },
          seven_day: { used_percentage: 40, resets_at: 0 }
        }
      },
      out
    )
    const report = usageReportSchema.parse(JSON.parse(fs.readFileSync(out, 'utf8')))
    expect(report.fiveHour).toBeNull()
    expect(report.sevenDay).toBeNull()
  })
})
