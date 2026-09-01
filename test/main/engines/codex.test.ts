import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../../../src/main/engines/codex'
import { PromptStore } from '../../../src/main/prompts'
import type { AgentSpawnConfig, EngineAdapter } from '../../../src/main/engines'
import { removeTempDir } from '../../tmpdir'

/**
 * The codex adapter's own behaviour, beyond the conformance table.
 *
 * The cases that matter most here are about **honesty**: the grade it declares,
 * the capabilities it does not claim, and the fact that it writes nothing into
 * the Architect's repository. An adapter that quietly over-claimed any of the
 * three would be the defect ADR-0009's grading exists to catch.
 */

const BUNDLED = fileURLToPath(new URL('../../../prompts/', import.meta.url))
const ESCAPE = String.fromCharCode(0x1b)
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

/** The adapter is read through the SURFACE, the way every caller reads it. */
function rig(): { adapter: EngineAdapter; cfg: AgentSpawnConfig; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-codex-'))
  temps.push(root)
  const cwd = path.join(root, 'repo')
  const agentDir = path.join(root, 'agora', 'agents', 'agent.mason')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'identity.md'), '# Mason\n\nrole: engineer\n', 'utf8')
  fs.writeFileSync(path.join(root, 'agora', 'PROTOCOL.md'), '# Company protocol\n\nrules\n', 'utf8')

  return {
    adapter: new CodexAdapter({
      prompts: new PromptStore(path.join(root, 'prompts'), BUNDLED)
    }),
    cwd,
    cfg: {
      agentId: 'agent.mason',
      hookToken: 'codex-token',
      hookEndpoint: path.join(root, 'events.sock'),
      cwd,
      commitIdentity: null,
      ghTokenCommand: '',
      envGrants: {},
      identityPath: path.join(agentDir, 'identity.md'),
      protocolPath: path.join(root, 'agora', 'PROTOCOL.md'),
      memory: '## Your memory\n\nThe kiln fires at 1280C.',
      recallCommand: 'node /shims/eph-recall.mjs',
      autonomy: 'manual'
    }
  }
}

describe('the version probe, against what the real CLI prints', () => {
  it('reads `codex-cli 0.150.1`', () => {
    // Captured from a real `codex --version` at 0.150.1.
    expect(rig().adapter.binary().parseVersion('codex-cli 0.150.1\n')).toBe('0.150.1')
  })

  it('reads a bare `codex 1.2.3` too', () => {
    expect(rig().adapter.binary().parseVersion('codex 1.2.3')).toBe('1.2.3')
  })

  it('returns null rather than guessing at output it does not recognize', () => {
    const { adapter } = rig()
    expect(adapter.binary().parseVersion('some other tool')).toBeNull()
    expect(adapter.binary().parseVersion('')).toBeNull()
  })

  it('offers the real install command (FR-1.6)', () => {
    const spec = rig().adapter.binary()
    expect(spec.name).toBe('codex')
    expect([spec.install.command, ...spec.install.args].join(' ')).toBe(
      'npm install -g @openai/codex'
    )
  })
})

describe('the spawn plan uses flags the real CLI has', () => {
  it('passes the working root with --cd and the identity as the first prompt', () => {
    const { adapter, cfg, cwd } = rig()
    const plan = adapter.spawnArgs(cfg)

    expect(plan.argv[0]).toBe('codex')
    expect(plan.argv[1]).toBe('--cd')
    expect(plan.argv[2]).toBe(cwd)
    // SDD §3 names first-prompt injection as one of the three mechanisms.
    expect(plan.argv[3]).toContain('# Mason')
    expect(plan.argv[3]).toContain('Company protocol')
  })

  it('carries the memory layer the Library composed', () => {
    const { adapter, cfg } = rig()
    expect(adapter.spawnArgs(cfg).argv.join('\n')).toContain('The kiln fires at 1280C.')
  })

  it('carries the harness variables and the recall command', () => {
    const { adapter, cfg } = rig()
    const plan = adapter.spawnArgs(cfg)
    expect(plan.env['EPH_AGENT_ID']).toBe('agent.mason')
    expect(plan.env['EPH_HOOK_TOKEN']).toBe('codex-token')
    expect(plan.env['EPH_RECALL']).toBe('node /shims/eph-recall.mjs')
  })

  it('refuses to build a plan when identity is missing', () => {
    const { adapter, cfg } = rig()
    fs.rmSync(cfg.identityPath)
    expect(() => adapter.spawnArgs(cfg)).toThrow(/identity\.md missing/)
    expect(() => adapter.injectIdentity(cfg)).toThrow(/identity\.md missing/)
  })
})

describe('honesty (ADR-0009, FR-2.3)', () => {
  it('declares the grade it can demonstrate, and no more', () => {
    // Codex 0.150.1 HAS a hook plane, but its events reach nobody without
    // persisted hook trust, and this adapter will not lower that default on the
    // Architect's behalf. So: no events claimed.
    expect(rig().adapter.hooks).toBe('pty-heuristic')
  })

  it('writes nothing into the agent repository, ever', async () => {
    const { adapter, cfg, cwd } = rig()
    const before = fs.readdirSync(cwd)
    const plan = adapter.wireHooks(cfg)

    expect(plan.injections).toEqual([])
    expect(adapter.spawnArgs(cfg).settings).toEqual([])
    await plan.install()
    expect(fs.readdirSync(cwd)).toEqual(before)
    await plan.uninstall()
    expect(fs.readdirSync(cwd)).toEqual(before)
  })

  it('never passes --dangerously-bypass-hook-trust', () => {
    const { adapter, cfg } = rig()
    expect(adapter.spawnArgs(cfg).argv.join(' ')).not.toContain('dangerously')
  })

  it('claims no resume, because ResumeSupport cannot express a subcommand', () => {
    // `codex resume <id>` is real, but ResumeSupport is an argv fragment
    // APPENDED to the plan, and a subcommand has to come first. Declaring it
    // and silently not resuming is exactly what the grading forbids.
    expect(rig().adapter.resume).toBeUndefined()
  })

  it('claims no transcript reader, so nothing invented reaches the ledger', () => {
    expect(rig().adapter.transcripts).toBeUndefined()
  })

  it('offers Escape as its cancel key', () => {
    expect(rig().adapter.interrupt()).toEqual({ label: 'Escape', bytes: ESCAPE })
  })
})
