import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveToolGrants, TOOLS_DIR } from '../../../src/main/engines/tool-grants'
import { describeToolGrants, toolGrantsSchema } from '../../../src/shared/engine-tools'
import { hireTemplateSchema } from '../../../src/shared/org'
import { ClaudeAdapter } from '../../../src/main/engines/claude'
import { engineConfigDir } from '../../../src/main/engines/engine-home'
import { PromptStore } from '../../../src/main/prompts'
import type { AgentSpawnConfig } from '../../../src/main/engines/types'
import type { ResolvedTools } from '../../../src/shared/engine-tools'
import { removeTempDir } from '../../tmpdir'

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../../prompts/', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function roots(): { readonly target: string; readonly home: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-tools-'))
  temps.push(base)
  const target = path.join(base, 'repo')
  const home = path.join(base, 'ephesus', TOOLS_DIR)
  fs.mkdirSync(path.join(target, '.claude', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(home, 'company-tools'), { recursive: true })
  return { target, home }
}

/**
 * ADR-0026 stopped the engine reading any settings source but the harness's,
 * which also stops a target repository handing an agent skills and subagents.
 * These are the rules that give them back without giving the repository the
 * decision: a directory reaches an agent because a bundle the Architect read
 * named it, and for no other reason.
 */
describe('the company grants tools by name (M8.7b, ADR-0026)', () => {
  it('resolves a grant under each named root', () => {
    const r = roots()
    const result = resolveToolGrants(
      [
        { root: 'target', path: '.claude' },
        { root: 'home', path: 'company-tools' }
      ],
      r
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.pluginDirs).toHaveLength(2)
    expect(result.tools.missing).toEqual([])
    // Declared order is preserved: the engine namespaces plugins by directory,
    // and a reordered list is a different set of skill names.
    expect(path.basename(result.tools.pluginDirs[0] ?? '')).toBe('.claude')
    expect(path.basename(result.tools.pluginDirs[1] ?? '')).toBe('company-tools')
  })

  it('refuses a path that escapes its root, naming it', () => {
    // The whole point of "by name" is that the Architect can read the list and
    // know what it reaches. A grant of `target:../..` would reach anything.
    const r = roots()
    const result = resolveToolGrants([{ root: 'target', path: path.join('..', '..') }], r)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.because).toContain('target:')
    expect(result.because).toMatch(/outside its root/)
  })

  it('refuses an escape hidden behind a directory that exists', () => {
    // `.claude/../..` resolves outside while every segment on the way is real,
    // which is the form a string-prefix check waves through.
    const r = roots()
    const result = resolveToolGrants(
      [{ root: 'target', path: path.join('.claude', '..', '..') }],
      r
    )
    expect(result.ok).toBe(false)
  })

  it('refuses an absolute path outright', () => {
    const r = roots()
    const absolute = process.platform === 'win32' ? 'C:\\Windows' : '/etc'
    const result = resolveToolGrants([{ root: 'target', path: absolute }], r)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.because).toMatch(/relative to its root/)
  })

  it('refuses the whole set, not the offending grant alone', () => {
    // Honouring the good grants and dropping the bad one would be a security
    // decision taken by a loop. A bundle asking for something it may not have
    // is a bundle to fix, not to partially obey.
    const r = roots()
    const result = resolveToolGrants(
      [
        { root: 'target', path: '.claude' },
        { root: 'target', path: path.join('..', '..') }
      ],
      r
    )
    expect(result.ok).toBe(false)
  })

  it('reports a directory that is not there, rather than refusing', () => {
    // The `envGrants` precedent (ADR-0010): a grant that cannot be supplied is
    // a visible degradation, not a refused spawn. An agent missing a skill is
    // diminished, not dangerous — but it must never be SILENTLY diminished,
    // because the symptom is an agent that does not use a tool and nobody can
    // say why.
    const r = roots()
    const result = resolveToolGrants(
      [
        { root: 'target', path: '.claude' },
        { root: 'home', path: 'not-installed' }
      ],
      r
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.pluginDirs).toHaveLength(1)
    expect(result.tools.missing).toEqual(['home:not-installed'])
  })

  it('refuses a grant that names a file', () => {
    const r = roots()
    fs.writeFileSync(path.join(r.home, 'notes.md'), 'not a tool directory', 'utf8')
    const result = resolveToolGrants([{ root: 'home', path: 'notes.md' }], r)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.because).toMatch(/not a directory/)
  })

  it('passes one directory once, however many grants name it', () => {
    const r = roots()
    const result = resolveToolGrants(
      [
        { root: 'target', path: '.claude' },
        { root: 'target', path: path.join('.claude', '..', '.claude') }
      ],
      r
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.tools.pluginDirs).toHaveLength(1)
  })

  it('grants nothing for an empty list', () => {
    const result = resolveToolGrants([], roots())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.tools).toEqual({ pluginDirs: [], missing: [] })
  })
})

describe('what a bundle may declare', () => {
  it('accepts a grant and rejects a free-form root', () => {
    expect(toolGrantsSchema.safeParse([{ root: 'target', path: '.claude' }]).success).toBe(true)
    expect(toolGrantsSchema.safeParse([{ root: 'anywhere', path: '.claude' }]).success).toBe(false)
    // Strict: an extra key is a bundle written against a shape this build does
    // not have, and silently ignoring it would grant less than it asked for.
    expect(
      toolGrantsSchema.safeParse([{ root: 'target', path: '.claude', recursive: true }]).success
    ).toBe(false)
  })

  it('is optional on a hire template, and omitting it grants nothing', () => {
    // Additive and optional: every hire template written before M8.7b must
    // still validate unchanged, which is why this costs no schemaVersion bump.
    const base = {
      schemaVersion: 1,
      name: 'oncall',
      version: 1,
      role: 'oncall',
      engine: 'claude',
      capabilities: [],
      envGrants: [],
      brief: 'You watch.'
    }
    const without = hireTemplateSchema.safeParse(base)
    expect(without.success).toBe(true)
    if (without.success) expect(without.data.tools).toBeUndefined()

    const withTools = hireTemplateSchema.safeParse({
      ...base,
      tools: [{ root: 'target', path: '.claude' }]
    })
    expect(withTools.success).toBe(true)
  })

  it('renders the declaration, not the resolved path, for the activation screen', () => {
    // The declaration is what the Architect is being asked to approve; the
    // absolute path is its consequence and means nothing on a screen.
    expect(describeToolGrants([{ root: 'target', path: '.claude' }])).toEqual(['target:.claude'])
  })
})

describe('the spawn plan carries the grants (ADR-0026)', () => {
  function cfgWith(tools: ResolvedTools): {
    readonly adapter: ClaudeAdapter
    readonly cfg: AgentSpawnConfig
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-toolplan-'))
    temps.push(root)
    const agora = path.join(root, 'agora', 'agents', 'agent.mason')
    fs.mkdirSync(path.join(root, 'repo'), { recursive: true })
    fs.mkdirSync(agora, { recursive: true })
    fs.writeFileSync(path.join(agora, 'identity.md'), '# Mason\nRole: oncall.\n', 'utf8')
    fs.writeFileSync(path.join(root, 'agora', 'PROTOCOL.md'), '# Protocol\nRules.\n', 'utf8')
    return {
      adapter: new ClaudeAdapter({
        prompts: new PromptStore(path.join(root, 'prompts'), BUNDLED_PROMPTS),
        hookShimPath: path.join(root, 'shims', 'eph-hook.mjs')
      }),
      cfg: {
        agentId: 'agent.mason',
        hookToken: 'tool-token',
        hookEndpoint: path.join(root, 'events.sock'),
        cwd: path.join(root, 'repo'),
        engineConfigDir: engineConfigDir(path.join(root, 'engines'), 'claude', 'agent.mason'),
        tools,
        commitIdentity: null,
        envGrants: {},
        identityPath: path.join(agora, 'identity.md'),
        protocolPath: path.join(root, 'agora', 'PROTOCOL.md'),
        memory: '',
        recallCommand: '',
        ghTokenCommand: '',
        autonomy: 'manual'
      }
    }
  }

  it('passes one --plugin-dir per granted directory, in order', () => {
    const { adapter, cfg } = cfgWith({ pluginDirs: ['/tools/a', '/tools/b'], missing: [] })
    const argv = adapter.spawnArgs(cfg).argv
    const granted = argv.filter((_, i) => argv[i - 1] === '--plugin-dir')

    expect(granted).toEqual(['/tools/a', '/tools/b'])
  })

  it('passes no flag at all when nothing was granted', () => {
    // The lockdown's default, not an exception to it: an agent on no profile
    // and a hire that declared no tools must produce the same command line.
    const { adapter, cfg } = cfgWith({ pluginDirs: [], missing: ['home:gone'] })
    expect(adapter.spawnArgs(cfg).argv).not.toContain('--plugin-dir')
  })

  it('keeps the lockdown flags alongside the grants', () => {
    // A granted directory must never be a reason the harness stopped being the
    // only hook author: `--plugin-dir` adds skills and subagents, and
    // `--setting-sources=` still refuses every settings file.
    const { adapter, cfg } = cfgWith({ pluginDirs: ['/tools/a'], missing: [] })
    const argv = adapter.spawnArgs(cfg).argv

    expect(argv).toContain('--setting-sources=')
    expect(argv).toContain('--plugin-dir')
    for (const argument of argv) expect(argument).not.toBe('')
  })
})
