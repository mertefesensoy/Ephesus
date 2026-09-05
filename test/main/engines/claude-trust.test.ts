import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_CONFIG_REL,
  ClaudeAdapter,
  claudeProjectKey
} from '../../../src/main/engines/claude'
import { CodexAdapter } from '../../../src/main/engines/codex'
import { GeminiAdapter } from '../../../src/main/engines/gemini'
import { PromptStore } from '../../../src/main/prompts'
import type { EngineAdapter } from '../../../src/main/engines/types'
import { removeTempDir } from '../../tmpdir'

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../../prompts/', import.meta.url))
const temps: string[] = []
const savedHome = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] }

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
  process.env['HOME'] = savedHome.HOME
  process.env['USERPROFILE'] = savedHome.USERPROFILE
})

/** A fake home the adapter will write `.claude.json` into. Never the real one. */
function fakeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-trust-'))
  temps.push(dir)
  process.env['HOME'] = dir
  process.env['USERPROFILE'] = dir
  return dir
}

function adapter(root: string): ClaudeAdapter {
  return new ClaudeAdapter({
    prompts: new PromptStore(path.join(root, 'prompts'), BUNDLED_PROMPTS),
    hookShimPath: path.join(root, 'shims', 'eph-hook.mjs')
  })
}

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-ws-'))
  temps.push(dir)
  return dir
}

function configAt(home: string): Record<string, Record<string, Record<string, unknown>>> {
  return JSON.parse(fs.readFileSync(path.join(home, CLAUDE_CONFIG_REL), 'utf8')) as Record<
    string,
    Record<string, Record<string, unknown>>
  >
}

/**
 * The engine asks once per working directory whether a human trusts it, defaults
 * the highlighted answer to "No, exit", and remembers what it is told. It asks
 * BEFORE a session exists, so no engine hook can fire for it and nothing in the
 * harness can see it: on the live MUSAHIT run all three crew agents parked on
 * that screen for their entire lives while the floor showed them as spawned.
 *
 * ADR-0021 makes the Architect's activation the answer. These tests pin the two
 * things that decide whether that works at all — the key the engine matches on,
 * and the promise not to touch anything else in its file.
 */
describe('recording the Architect’s approval where the engine looks for it (ADR-0021)', () => {
  it('writes the key with forward slashes, which is the only form the engine reads', () => {
    // Established by experiment, not assumed: a backslash key — the form Windows
    // hands you and the form this harness spawns with — sits in the file being
    // ignored, and the dialog appears anyway.
    const home = fakeHome()
    const dir = workspace()
    const result = adapter(home).trustWorkspace(dir)
    expect(result.ok).toBe(true)
    const key = claudeProjectKey(fs.realpathSync.native(dir))
    expect(key).not.toContain('\\')
    expect(configAt(home)['projects']?.[key]?.['hasTrustDialogAccepted']).toBe(true)
  })

  it('reports a directory the Architect had already approved, rather than claiming the grant', () => {
    const home = fakeHome()
    const dir = workspace()
    const first = adapter(home).trustWorkspace(dir)
    const second = adapter(home).trustWorkspace(dir)
    expect(first).toEqual({ ok: true, path: expect.any(String), alreadyTrusted: false })
    expect(second).toEqual({ ok: true, path: expect.any(String), alreadyTrusted: true })
  })

  it('touches one key and one field, leaving every other setting alone', () => {
    const home = fakeHome()
    const dir = workspace()
    const other = { hasTrustDialogAccepted: true, allowedTools: ['Bash'], lastCost: 12 }
    fs.writeFileSync(
      path.join(home, CLAUDE_CONFIG_REL),
      JSON.stringify({
        numStartups: 128,
        oauthAccount: { id: 'x' },
        projects: { 'C:/other': other }
      }),
      'utf8'
    )
    adapter(home).trustWorkspace(dir)
    const after = configAt(home)
    expect(after['numStartups']).toBe(128)
    expect(after['oauthAccount']).toEqual({ id: 'x' })
    expect(after['projects']?.['C:/other']).toEqual(other)
  })

  it('refuses rather than repairs when the engine’s own file is unreadable', () => {
    // Rewriting it from a guess would cost the Architect every project setting
    // in it — a far worse outcome than a crew that does not start.
    const home = fakeHome()
    fs.writeFileSync(path.join(home, CLAUDE_CONFIG_REL), '{ not json', 'utf8')
    const result = adapter(home).trustWorkspace(workspace())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.because).toMatch(/unreadable/)
    // The file it refused to parse is still exactly as it found it.
    expect(fs.readFileSync(path.join(home, CLAUDE_CONFIG_REL), 'utf8')).toBe('{ not json')
  })

  it('refuses a target that does not resolve', () => {
    const home = fakeHome()
    const result = adapter(home).trustWorkspace(path.join(home, 'no', 'such', 'place'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.because).toMatch(/does not resolve/)
  })

  /**
   * The standing verdict this ADR had to argue with: codex and gemini were
   * pinned at `pty-heuristic` rather than passing `--dangerously-bypass-hook-trust`
   * or `--skip-trust` (DECISIONS-LOG 2026-08). Their route past a trust prompt is
   * a bypass flag, not a record of a human decision, and this hook does not
   * reopen it — so they must not have it.
   */
  it('is offered by no engine whose only route past its prompt is a bypass flag', () => {
    const prompts = new PromptStore(path.join(fakeHome(), 'prompts'), BUNDLED_PROMPTS)
    // Read through the interface, where the capability is optional: the
    // concrete classes not declaring it at all is the stronger guarantee, and
    // is what makes this assertion pass.
    const codex: EngineAdapter = new CodexAdapter({ prompts })
    const gemini: EngineAdapter = new GeminiAdapter({ prompts })
    expect(codex.trustWorkspace).toBeUndefined()
    expect(gemini.trustWorkspace).toBeUndefined()
  })
})
/**
 * M8.7 — the worktree half of ADR-0021.
 *
 * M8.6 made isolation the default, which moved every profile hire out of the
 * target and into `<home>/worktrees/<agentId>`. The engine keys its trust
 * record on the EXACT directory, so an activation that trusted only the target
 * left every isolated hire meeting the first-run dialog — before any session,
 * so no hook could report it — and parking for ever. That is the MUSAHIT
 * failure ADR-0021 was written to close, re-opened from the other side.
 *
 * The leaf cannot be resolved before git makes it, so `will-be-created`
 * resolves the parent and appends the leaf. These tests pin that the key it
 * produces is the key the engine will look for once the directory exists —
 * anything else and the record is written where nothing reads it, silently.
 */
describe('trusting a workspace that does not exist yet (M8.7)', () => {
  it('writes a key for a directory git has not made yet', () => {
    const home = fakeHome()
    const root = workspace()
    const planned = path.join(root, 'agent.mason')
    expect(fs.existsSync(planned)).toBe(false)

    const result = adapter(home).trustWorkspace(planned, 'will-be-created')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(configAt(home)['projects']?.[result.path]?.['hasTrustDialogAccepted']).toBe(true)
  })

  it('produces exactly the key the engine will match once the directory exists', () => {
    // The property the whole fix rests on. A key that differs by one character
    // from the one the engine looks up is a record nothing reads, and the only
    // symptom is an agent that parks — with no session, so no hook, so no
    // report. Asserted by resolving the same path BOTH ways.
    const home = fakeHome()
    const root = workspace()
    const planned = path.join(root, 'agent.mason')

    const ahead = adapter(home).trustWorkspace(planned, 'will-be-created')
    fs.mkdirSync(planned, { recursive: true })
    const behind = adapter(home).trustWorkspace(planned, 'must-exist')

    expect(ahead.ok && behind.ok).toBe(true)
    if (!ahead.ok || !behind.ok) return
    expect(ahead.path).toBe(behind.path)
    // …and the second call found the first one's grant already there, rather
    // than writing a second key beside it.
    expect(behind.alreadyTrusted).toBe(true)
    expect(Object.keys(configAt(home)['projects'] ?? {})).toHaveLength(1)
  })

  it('still resolves the parent through realpath, so a junction cannot aim it elsewhere', () => {
    // ADR-0021's guard survives where it matters. The leaf is a name the
    // harness derives from an agent id; the PARENT is a real directory that
    // could be a link, and it is resolved.
    const home = fakeHome()
    const real = workspace()
    const link = path.join(workspace(), 'link')
    try {
      fs.symlinkSync(real, link, 'junction')
    } catch {
      return // unprivileged Windows cannot make one; the must-exist test covers the guard
    }
    const result = adapter(home).trustWorkspace(path.join(link, 'agent.mason'), 'will-be-created')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).toBe(
      claudeProjectKey(path.join(fs.realpathSync.native(real), 'agent.mason'))
    )
    expect(result.path).not.toContain('link')
  })

  it('refuses when even the parent does not exist, rather than inventing a key', () => {
    const home = fakeHome()
    const result = adapter(home).trustWorkspace(
      path.join(workspace(), 'no', 'such', 'root', 'agent.mason'),
      'will-be-created'
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.because).toMatch(/parent does not resolve/)
  })

  it('defaults to must-exist, so every caller written before M8.7 is unchanged', () => {
    // ADR-0021's original contract: a target the Architect named is on the disk
    // in front of them, and a path that does not resolve is a refusal.
    const home = fakeHome()
    const result = adapter(home).trustWorkspace(path.join(workspace(), 'nope'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.because).toMatch(/target does not resolve/)
  })
})
