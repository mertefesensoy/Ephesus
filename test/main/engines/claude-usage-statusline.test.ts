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

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-usage-shim-'))
  temps.push(dir)
  return dir
}

function prompts(): PromptStore {
  return new PromptStore('x', BUNDLED_PROMPTS)
}

/** The captured render, trimmed to the fields the shim reads. */
const REAL_STATUS = {
  session_id: '0fd850ec-e990-4ecb-92cc-4ba23df2271c',
  version: '2.1.252',
  model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
  context_window: { context_window_size: 200000, used_percentage: 21 },
  cost: {
    total_cost_usd: 0.08599799999999999,
    total_duration_ms: 25184,
    total_api_duration_ms: 3502
  },
  rate_limits: {
    five_hour: { used_percentage: 12, resets_at: 1788294000 },
    seven_day: { used_percentage: 28.999999999999996, resets_at: 1788753600 }
  }
}

/**
 * Runs the shim exactly as an engine would: JSON on stdin, `--dir` pointing at
 * the per-agent report directory, and `EPH_AGENT_ID` in the environment.
 */
function runShim(
  input: unknown,
  dir: string | null,
  agentId: string | null = 'agent.artemis'
): { stdout: string; files: readonly string[] } {
  const args = dir === null ? [SHIM] : [SHIM, '--dir', dir]
  const env = { ...process.env }
  if (agentId === null) delete env['EPH_AGENT_ID']
  else env['EPH_AGENT_ID'] = agentId
  const stdout = execFileSync(process.execPath, args, {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env
  })
  const files =
    dir !== null && fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort()
      : []
  return { stdout, files }
}

/** The report the shim wrote for one agent. */
function reportIn(dir: string, name = 'agent.artemis.json') {
  return usageReportSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
}

describe('the statusline block the adapter installs', () => {
  it('runs our shim and points it at the harness usage file', () => {
    const settings = JSON.parse(
      mergeClaudeSettings(null, {
        prompts: prompts(),
        hookShimPath: 'hook-shim',
        usageShimPath: '/app/shims/eph-usage.mjs',
        usageStatusDir: '/home/usage'
      })
    ) as Record<string, Record<string, string>>
    expect(settings['statusLine']?.['type']).toBe('command')
    expect(settings['statusLine']?.['command']).toContain('eph-usage.mjs')
    expect(settings['statusLine']?.['command']).toContain('/home/usage')
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
        usageStatusDir: '/home/usage'
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
      usageStatusDir: '/home/usage'
    }
    const once = mergeClaudeSettings(null, deps)
    const twice = mergeClaudeSettings(once, deps)
    expect(JSON.parse(twice)).toEqual(JSON.parse(once))
  })
})

describe('eph-usage.mjs — the shim itself', () => {
  it('turns a real render into a usable report', () => {
    const dir = tempDir()
    const { stdout } = runShim(REAL_STATUS, dir)

    const report = reportIn(dir)
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

  it('carries the live session cost and the session it belongs to', () => {
    // The live half of the money figure. The durable half only lands when the
    // session ends, so without this a running agent shows no cost at all.
    const dir = tempDir()
    runShim(REAL_STATUS, dir)
    const report = reportIn(dir)
    expect(report.sessionCostUsd).toBeCloseTo(0.085998, 9)
    expect(report.session).toBe('0fd850ec-e990-4ecb-92cc-4ba23df2271c')
  })

  it('writes one file per agent, named after the agent', () => {
    // Several agents render status lines constantly. One shared file would mean
    // last-writer-wins, and whichever agent rendered most recently would have
    // every other agent's spend attributed to it.
    const dir = tempDir()
    runShim(REAL_STATUS, dir, 'agent.artemis')
    runShim(
      { ...REAL_STATUS, session_id: 'other', cost: { total_cost_usd: 9 } },
      dir,
      'agent.mason'
    )

    const { files } = runShim(REAL_STATUS, dir, 'agent.artemis')
    expect(files).toEqual(['agent.artemis.json', 'agent.mason.json'])
    // Neither agent's figure moved the other's.
    expect(reportIn(dir, 'agent.artemis.json').sessionCostUsd).toBeCloseTo(0.085998, 9)
    expect(reportIn(dir, 'agent.mason.json').sessionCostUsd).toBe(9)
  })

  it('keeps an unknown agent out of the per-agent namespace', () => {
    // The Architect's own `claude` in a repo where our settings are installed.
    // Its windows are still worth having (they are account-wide); its cost is
    // nobody's to attribute.
    const dir = tempDir()
    const { files } = runShim(REAL_STATUS, dir, null)
    expect(files).toEqual(['_account.json'])
    expect(reportIn(dir, '_account.json').agentId).toBeNull()
  })

  it('never lets an agent id escape the report directory', () => {
    // The id reaches a path. An unsanitised one is a traversal waiting for the
    // first id with a separator in it.
    const dir = tempDir()
    // A name unique to this run: a file left outside by an earlier run — or by
    // a mutation check that deliberately broke the sanitiser — must not be
    // able to make this pass or fail for the wrong reason.
    const unique = `escape-${path.basename(dir)}`
    const { files } = runShim(REAL_STATUS, dir, `../../${unique}`)
    expect(files).toEqual([`----${unique}.json`])
    expect(fs.existsSync(path.join(dir, '..', '..', `${unique}.json`))).toBe(false)
  })

  it('writes a report saying "nothing" when the engine reported no limits', () => {
    // The first render of every session has no rate_limits at all — the engine
    // documents it as arriving only after the first API response, and it did
    // exactly that in the captured run. "We looked and there was nothing" is a
    // fact the harness needs; its ABSENCE is what says the shim is not running.
    const dir = tempDir()
    const { session_id, version, model, context_window } = REAL_STATUS
    runShim({ session_id, version, model, context_window }, dir)

    const report = reportIn(dir)
    expect(report.fiveHour).toBeNull()
    expect(report.sevenDay).toBeNull()
    // …and no cost either: null, not zero. "Not reported" and "free" are
    // different claims (ADR-0011).
    expect(report.sessionCostUsd).toBeNull()
  })

  it('keeps one window when the engine reports only one', () => {
    const dir = tempDir()
    runShim({ rate_limits: { five_hour: { used_percentage: 7, resets_at: 1788294000 } } }, dir)
    const report = reportIn(dir)
    expect(report.fiveHour?.usedPercent).toBe(7)
    expect(report.sevenDay).toBeNull()
  })

  it('ignores a cost that is not a usable number', () => {
    const dir = tempDir()
    for (const cost of [{ total_cost_usd: 'lots' }, { total_cost_usd: -1 }, {}, null]) {
      runShim({ ...REAL_STATUS, cost }, dir)
      expect(reportIn(dir).sessionCostUsd).toBeNull()
    }
  })

  it('fails open on input that is not JSON', () => {
    // The status line renders on the agent's critical path. A shim that threw
    // or exited non-zero would cost the agent its turn over a telemetry file.
    const dir = tempDir()
    expect(() => runShim('not json at all', dir)).not.toThrow()
    expect(reportIn(dir).fiveHour).toBeNull()
  })

  it('fails open when it cannot write where it was told to', () => {
    const dir = tempDir()
    // A plain FILE standing where the shim expects a directory: the mkdir and
    // the write both fail, which is the realistic version of a bad path.
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'not a directory', 'utf8')
    const { stdout } = runShim(REAL_STATUS, path.join(blocker, 'nested'))
    // Still renders the status line for the Architect, having reported the
    // trouble on stderr only.
    expect(stdout).toContain('5h 12%')
  })

  it('ignores a window whose numbers make no sense', () => {
    const dir = tempDir()
    runShim(
      {
        rate_limits: {
          five_hour: { used_percentage: 'lots', resets_at: 1788294000 },
          seven_day: { used_percentage: 40, resets_at: 0 }
        }
      },
      dir
    )
    const report = reportIn(dir)
    expect(report.fiveHour).toBeNull()
    expect(report.sevenDay).toBeNull()
  })
})
