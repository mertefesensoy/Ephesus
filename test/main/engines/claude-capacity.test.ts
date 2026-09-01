import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ClaudeAdapter, claudeCapacityLimit } from '../../../src/main/engines/claude'
import { PromptStore } from '../../../src/main/prompts'

/**
 * The usage-limit detector (`src/main/engines/claude.ts`).
 *
 * This file is the audit trail for a claim that is otherwise unfalsifiable from
 * the code alone: *that Ephesus can tell a provider refusal from a crash.* The
 * fixture beside it is not invented — it is the shape of records recorded on a
 * real machine by a real engine, including the two `server_error` records that
 * sat in the SAME transcript and must not be mistaken for a limit.
 *
 * The detector's rule, and both sources for it:
 *
 *   `type === 'assistant' && isApiErrorMessage === true && error === 'rate_limit'`
 *
 *  1. Observed: three such records in `~/.claude/projects/…/39ba11ac-….jsonl`
 *     (engine 2.1.237), the first at 2026-08-30T21:58:55.766Z, each carrying
 *     those three fields plus `apiErrorStatus: 429`.
 *  2. The engine's own guard, in the shipped 2.1.252 binary, tests exactly the
 *     same three fields before it reads `quotaLimits`.
 *
 * If this file goes green while the detector is broken, the whole feature is a
 * decoration — so every assertion here is about a record the engine actually
 * writes, not about a record we wish it wrote.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'claude-limit',
  'transcript.jsonl'
)

function records(): readonly unknown[] {
  return fs
    .readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
}

function recordNamed(uuid: string): unknown {
  const found = records().find((row) => (row as Record<string, unknown>)['uuid'] === uuid)
  if (found === undefined) throw new Error(`fixture has no record "${uuid}"`)
  return found
}

describe('claudeCapacityLimit', () => {
  it('recognises the refusal record the engine actually writes', () => {
    const limit = claudeCapacityLimit(recordNamed('u-limit-1'))
    expect(limit).not.toBeNull()
    expect(limit?.kind).toBe('rate-limit')
    expect(limit?.recordId).toBe('u-limit-1')
    expect(limit?.sessionId).toBe('sess-a')
    expect(limit?.at).toBe('2026-08-30T21:58:55.766Z')
    // The provider's own sentence, verbatim — "out of usage credits" and "rate
    // limited" want different things from a human.
    expect(limit?.detail).toContain("You're out of usage credits")
  })

  it('finds exactly one refusal in a transcript that also holds two API errors', () => {
    const found = records()
      .map((row) => claudeCapacityLimit(row))
      .filter((row) => row !== null)
    expect(found).toHaveLength(1)
    expect(found[0]?.recordId).toBe('u-limit-1')
  })

  // The negative controls are real records from the same real transcript, not
  // constructed straw men. A detector that fired on either of these would park
  // the company on a DNS blip or a transient 529 and wait out a ladder for
  // nothing.
  it.each([
    ['a DNS failure', 'u-dns-1'],
    ['a 529 Overloaded', 'u-529-1'],
    ['an ordinary completed turn', 'u-normal-1']
  ])('does not fire on %s', (_label, uuid) => {
    expect(claudeCapacityLimit(recordNamed(uuid))).toBeNull()
  })

  it('does not fire on a billing failure, which waiting cannot fix', () => {
    // The engine's own gloss for `billing_error` is "usage limit reached —
    // check plan". It reads like a limit and is not one: no amount of waiting
    // clears it, so parking on it would strand the company until a human
    // noticed. Shaped like the refusal record in every respect but `error`.
    const billing = {
      type: 'assistant',
      uuid: 'u-billing-1',
      sessionId: 'sess-a',
      timestamp: '2026-08-30T22:00:00.000Z',
      isApiErrorMessage: true,
      error: 'billing_error',
      apiErrorStatus: 429,
      message: { content: [{ type: 'text', text: "You've hit your monthly spend limit." }] }
    }
    expect(claudeCapacityLimit(billing)).toBeNull()
  })

  it('reads the provider reset time when it is given, as unix seconds', () => {
    // `quotaLimits` is built from the `anthropic-ratelimit-unified-*` response
    // headers, and `resetsAt` is the raw `…-reset` header value — seconds, as
    // the engine's own `resetsAt * 1000 <= Date.now()` comparison shows.
    const withQuota = {
      ...(recordNamed('u-limit-1') as Record<string, unknown>),
      quotaLimits: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_788_000_000 }
    }
    expect(claudeCapacityLimit(withQuota)?.resetsAt).toBe(
      new Date(1_788_000_000 * 1000).toISOString()
    )
  })

  it.each([
    ['absent', undefined],
    ['zero', 0],
    ['not a number', 'soon'],
    ['not an object', 7]
  ])('reports no reset time when the engine gives one that is %s', (_label, resetsAt) => {
    // Null means "the provider did not say", and the wait falls back to a
    // ladder. A coerced zero would mean "reset in 1970", which is to say never
    // waiting at all — a fabricated deadline is worse than an honest absence.
    const row = {
      ...(recordNamed('u-limit-1') as Record<string, unknown>),
      quotaLimits: resetsAt === 7 ? 7 : { resetsAt }
    }
    expect(claudeCapacityLimit(row)?.resetsAt).toBeNull()
  })

  it('skips a refusal it cannot name, rather than re-parking on it forever', () => {
    const anonymous = { ...(recordNamed('u-limit-1') as Record<string, unknown>), uuid: '' }
    expect(claudeCapacityLimit(anonymous)).toBeNull()
  })

  it.each([
    ['null', null],
    ['a string', 'rate_limit'],
    ['a number', 429]
  ])('survives %s where a record was expected', (_label, raw) => {
    expect(claudeCapacityLimit(raw)).toBeNull()
  })

  it('is wired onto the adapter, not merely exported', () => {
    // The M6 lesson, made a test: a detector nothing calls is decoration. The
    // Watch reaches this function through the adapter's transcript reader and
    // nowhere else, so that edge is the one worth pinning.
    const adapter = new ClaudeAdapter({
      prompts: new PromptStore(
        path.join(os.tmpdir(), 'eph-capacity-prompts'),
        path.join(process.cwd(), 'prompts')
      ),
      hookShimPath: path.join(os.tmpdir(), 'eph-hook.mjs')
    })
    expect(adapter.transcripts?.limitOf).toBe(claudeCapacityLimit)
    expect(adapter.transcripts?.limitOf?.(recordNamed('u-limit-1'))).not.toBeNull()
  })
})
