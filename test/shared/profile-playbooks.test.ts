import { describe, expect, it } from 'vitest'
import {
  comparePlaybooks,
  instanceDirName,
  playbooksAgree,
  playbooksMissingDetail
} from '../../src/shared/profile-playbooks'
import { instanceIdFor, instanceIdSchema } from '../../src/shared/profile-activation'

/**
 * The pure half of M8b.1 — where an instance's runbooks go, and whether they
 * are all there.
 *
 * Separated from `test/main/playbooks.test.ts` on TEST-STRATEGY §2's split:
 * this module has no filesystem and every claim below is a claim about a
 * string, so it is asserted where it can be asserted exhaustively rather than
 * through a `mkdtemp`.
 */

describe('an instance id becomes a directory name', () => {
  it('removes the colon a Windows path cannot carry', () => {
    // `instanceIdSchema` admits this and `:` is the alternate-data-stream
    // separator on Windows — `mkdir` either fails or writes somewhere nobody
    // meant. This is the reason the function exists at all.
    expect(instanceDirName('skeleton-crew@repo:aftershock')).toBe('skeleton-crew@repo-aftershock')
    expect(instanceDirName('skeleton-crew@repo:aftershock')).not.toContain(':')
  })

  it('is injective across the id grammar, so two instances never share a directory', () => {
    // Exhaustive over the grammar's shape rather than over a handful of
    // examples: the property the whole scheme rests on is that no two legal
    // ids collide, and a spot check cannot say that.
    const profiles = ['crew', 'skeleton-crew', 'a', 'a-b-c', 'crew-repo-x']
    const kinds = ['repo', 'app'] as const
    const targets = ['app', 'aftershock', 'a-b', 'x']
    const ids = profiles.flatMap((profile) =>
      kinds.flatMap((kind) => targets.map((id) => instanceIdFor(profile, { kind, id })))
    )
    for (const id of ids) expect(instanceIdSchema.safeParse(id).success).toBe(true)
    expect(new Set(ids.map(instanceDirName)).size).toBe(ids.length)
  })

  it('folds anything outside the safe set rather than throwing', () => {
    // It runs on a path where the id has already validated, so a throw here
    // would turn a naming problem into a failed activation.
    expect(instanceDirName('a/../../b')).toBe('a-------b')
    expect(instanceDirName('a\\b')).toBe('a-b')
  })

  it('never folds to a name the filesystem reads as an instruction', () => {
    // Found by writing this test, not by review: `.` was in the safe set, so
    // `..` folded to ITSELF and would have named the parent of `instances/`.
    // Unreachable through `instanceIdSchema` — and being total over strings
    // that never reach it is this function's entire claim.
    for (const hostile of ['..', '.', '', './..', '../..']) {
      const folded = instanceDirName(hostile)
      expect(folded).not.toBe('')
      expect(folded).not.toBe('.')
      expect(folded).not.toBe('..')
      expect(folded.split(/[/\\]/)).toHaveLength(1)
    }
  })

  it('leaves an already-safe name untouched', () => {
    expect(instanceDirName('crew@repo-app')).toBe('crew@repo-app')
  })
})

describe('the declared set against the on-disk set', () => {
  it('is empty both ways when they agree, whatever the order', () => {
    const same = comparePlaybooks(['b.md', 'a.md'], ['a.md', 'b.md'])
    expect(same).toEqual({ missing: [], extra: [] })
    expect(playbooksAgree(same)).toBe(true)
  })

  it('names what is declared and absent — the 2026-09-09 state exactly', () => {
    const run = comparePlaybooks(['dependency-update.md', 'health-check.md', 'incident.md'], [])
    expect(run.missing).toEqual(['dependency-update.md', 'health-check.md', 'incident.md'])
    expect(run.extra).toEqual([])
    expect(playbooksAgree(run)).toBe(false)
  })

  it('names what is present and undeclared', () => {
    // Two-way, because the acceptance is that the sets are EQUAL. A leftover
    // runbook still opens when an agent is pointed at it, and nobody approved
    // it.
    const drift = comparePlaybooks(['incident.md'], ['incident.md', 'stray.md'])
    expect(drift).toEqual({ missing: [], extra: ['stray.md'] })
    expect(playbooksAgree(drift)).toBe(false)
  })

  it('sorts both sides, so a degradation message is stable across readdir order', () => {
    const out = comparePlaybooks(['z.md', 'a.md'], ['y.md', 'b.md'])
    expect(out.missing).toEqual(['a.md', 'z.md'])
    expect(out.extra).toEqual(['b.md', 'y.md'])
  })
})

describe('the sentence a missing runbook earns', () => {
  it('is null when there is nothing wrong', () => {
    expect(
      playbooksMissingDetail('crew@repo:app', { missing: [], extra: [] }, '/home/instances/x')
    ).toBeNull()
  })

  it('names the instance, the files, the directory and the fix', () => {
    const detail = playbooksMissingDetail(
      'skeleton-crew@repo:aftershock',
      { missing: ['incident.md'], extra: [] },
      '/home/instances/skeleton-crew@repo-aftershock/playbooks'
    )
    expect(detail).toContain('skeleton-crew@repo:aftershock')
    expect(detail).toContain('incident.md')
    expect(detail).toContain('/home/instances/skeleton-crew@repo-aftershock/playbooks')
    // The Architect has to know what to DO. A condition reported without its
    // remedy is one that gets read once and scrolled past.
    expect(detail).toContain('Reactivate')
  })

  it('says both halves when a runbook is missing AND another is undeclared', () => {
    const detail = playbooksMissingDetail(
      'crew@repo:app',
      { missing: ['incident.md'], extra: ['stray.md'] },
      '/home/instances/crew@repo-app/playbooks'
    )
    expect(detail).toContain('incident.md')
    expect(detail).toContain('stray.md')
    // One sentence carrying both, rather than the first one that matched: a
    // per-file condition deduplicated down to one surviving message is
    // Finding 2 of the same run, and this is the shape that reproduces it.
    expect(detail).toContain('; and ')
  })
})
