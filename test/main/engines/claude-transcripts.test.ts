import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeTranscriptDir,
  claudeUsageFact,
  ClaudeAdapter
} from '../../../src/main/engines/claude'
import { PromptStore } from '../../../src/main/prompts'
import { removeTempDir } from '../../tmpdir'

/**
 * The Claude Code transcript reader (ADR-0009 `transcripts`, FR-11.2), against
 * fixtures in the engine's REAL line shape — captured from an actual
 * `~/.claude/projects/<slug>/<session>.jsonl`, not invented. The rule under
 * test is ADR-0009's: unrecognized lines yield fewer facts, never invented ones.
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-transcript-'))
  temps.push(dir)
  return dir
}

/** One assistant line, in the engine's real shape. */
function assistantLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    uuid: '653e5c42-3549-4418-8194-6ff5347d8987',
    requestId: 'req_011CeSL6HHsqcCf1TCx7opdU',
    sessionId: 'sess-77',
    timestamp: '2026-08-27T00:46:12.433Z',
    cwd: '/repo',
    gitBranch: 'main',
    version: '2.1.195',
    message: {
      type: 'message',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 59568,
        cache_read_input_tokens: 0,
        output_tokens: 183,
        output_tokens_details: { thinking_tokens: 0 },
        service_tier: 'standard'
      }
    },
    ...over
  })
}

describe('claudeUsageFact', () => {
  it('reads one assistant line into a fact', () => {
    expect(claudeUsageFact(JSON.parse(assistantLine()))).toEqual({
      sessionId: 'sess-77',
      model: 'claude-opus-5',
      // Cache reads and writes ARE input tokens the provider billed; leaving
      // them out would under-report, which is the bug ADR-0011 exists to close.
      inTokens: 59570,
      outTokens: 183,
      costUsd: null,
      // The engine's own timestamp, so the ledger bills the day of SPEND
      // rather than the day the harness happened to fold it.
      at: '2026-08-27T00:46:12.433Z'
    })
  })

  it('counts cache reads as input too', () => {
    const line = JSON.parse(
      assistantLine({
        message: {
          model: 'm',
          usage: { input_tokens: 1, cache_read_input_tokens: 40, output_tokens: 2 }
        }
      })
    )
    expect(claudeUsageFact(line)?.inTokens).toBe(41)
  })

  it('carries the engine timestamp through, and null when there is none', () => {
    expect(claudeUsageFact(JSON.parse(assistantLine()))?.at).toBe('2026-08-27T00:46:12.433Z')
    expect(claudeUsageFact(JSON.parse(assistantLine({ timestamp: undefined })))?.at).toBeNull()
    expect(claudeUsageFact(JSON.parse(assistantLine({ timestamp: 42 })))?.at).toBeNull()
  })

  it('reports no cost, because the engine reports none', () => {
    // A derived dollar figure would need a price table this milestone has no
    // source for, and a guessed price is worse than an honest "not reported".
    expect(claudeUsageFact(JSON.parse(assistantLine()))?.costUsd).toBeNull()
  })

  it.each([
    ['a user turn', { type: 'user' }],
    ['a queue operation', { type: 'queue-operation', message: undefined }],
    ['an assistant line with no usage', { message: { model: 'm' } }],
    ['an assistant line with no model', { message: { usage: { output_tokens: 3 } } }],
    ['an assistant line with no session', { sessionId: 42 }],
    ['a usage object with zero tokens', { message: { model: 'm', usage: { output_tokens: 0 } } }]
  ])('yields nothing for %s', (_name, over) => {
    expect(claudeUsageFact(JSON.parse(assistantLine(over)))).toBeNull()
  })

  it.each([
    ['a string', '"hi"'],
    ['null', 'null'],
    ['a number', '7'],
    ['an array', '[]']
  ])('yields nothing for %s', (_name, raw) => {
    expect(claudeUsageFact(JSON.parse(raw))).toBeNull()
  })

  it('treats a negative or non-numeric token count as zero, never as a fact it invented', () => {
    const line = JSON.parse(
      assistantLine({
        message: { model: 'm', usage: { input_tokens: -5, output_tokens: 'lots' } }
      })
    )
    expect(claudeUsageFact(line)).toBeNull()
  })
})

describe('the adapter’s reader', () => {
  const adapter = (): ClaudeAdapter =>
    new ClaudeAdapter({
      prompts: new PromptStore(tempDir(), path.join(process.cwd(), 'prompts')),
      hookShimPath: path.join(tempDir(), 'eph-hook.mjs')
    })

  it('reads a whole transcript, skipping the noise around it', async () => {
    const dir = tempDir()
    const file = path.join(dir, 'sess-77.jsonl')
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
        assistantLine(),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        assistantLine({ message: { model: 'claude-opus-5', usage: { output_tokens: 7 } } }),
        // A torn final line from a killed engine.
        '{"type":"assistant","mess'
      ].join('\n') + '\n'
    )
    const facts = await adapter().transcripts.read(file)
    expect(facts).toHaveLength(2)
    expect(facts[1]?.outTokens).toBe(7)
  })

  it('reads a file that is not there as no facts, not as an error', async () => {
    expect(await adapter().transcripts.read(path.join(tempDir(), 'nope.jsonl'))).toEqual([])
  })

  /**
   * The cwd -> directory slug, asserted against golden values COPIED FROM real
   * `~/.claude/projects` directory names rather than recomputed with the
   * implementation's own rule — a test that re-derives its expectation the way
   * the code does would pass for any rule, including a wrong one.
   *
   * The INPUT has to be per-platform because `path.resolve` is: the engine
   * slugs an absolute path, and `path.resolve('/home/user/x')` on Windows is
   * `C:\\home\\user\\x`, not `/home/user/x`. The slug RULE is the same on both.
   */
  const golden =
    process.platform === 'win32'
      ? {
          cwd: 'C:\\Users\\u\\OneDrive\\Masaüstü\\ephesus',
          slug: 'C--Users-u-OneDrive-Masa-st--ephesus'
        }
      : { cwd: '/home/user/ephesus', slug: '-home-user-ephesus' }

  it('points at the engine’s own project directory, inside the AGENT’s config dir', () => {
    // ADR-0026: `projects/` moves with `CLAUDE_CONFIG_DIR`. Asserting against
    // an isolated directory rather than `$HOME` is the point — a reader still
    // computing `$HOME/.claude/projects` finds nothing and folds a silent zero.
    const configDir = path.join(path.parse(process.cwd()).root, 'eph-engines', 'agent.mason')
    const dir = claudeTranscriptDir(configDir, golden.cwd)
    expect(path.isAbsolute(dir)).toBe(true)
    expect(dir).toBe(path.join(configDir, 'projects', golden.slug))
    expect(dir.startsWith(configDir)).toBe(true)
  })

  it('slugs every character the engine slugs, not just the separators', () => {
    // The regression this file was blind to: a rule covering only separators
    // left `ü` and ` ` intact, so on any machine with a non-ASCII or spaced
    // path the reader pointed at a directory that does not exist — and the
    // budget folded a permanent, silent zero rather than failing loudly.
    const root = path.parse(process.cwd()).root
    const slug = (cwd: string): string => path.basename(claudeTranscriptDir(root, cwd))
    expect(slug(path.join(root, 'Masaüstü', 'ephesus'))).toContain('Masa-st--ephesus')
    expect(slug(path.join(root, 'IBM Z Project'))).toContain('IBM-Z-Project')
    // Stated as an invariant too, so a later rule change cannot quietly let a
    // character through: nothing but ASCII alphanumerics and dashes survives.
    expect(slug(process.cwd())).toMatch(/^[A-Za-z0-9-]+$/)
  })
})
