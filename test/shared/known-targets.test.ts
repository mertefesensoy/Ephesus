import { describe, expect, it } from 'vitest'
import {
  KNOWN_TARGETS_SCHEMA_VERSION,
  knownTargetsFileSchema,
  knownTargetsFor,
  rememberTarget,
  type KnownTarget
} from '../../src/shared/known-targets'

function row(
  profile: string,
  id: string,
  dir: string,
  at = '2026-09-01T06:00:00.000Z'
): KnownTarget {
  return { profile, target: { kind: 'repo', id, path: dir }, lastUsedAt: at }
}

describe('remembering what has already been activated', () => {
  it('puts the most recently used target first', () => {
    const a = row('skeleton-crew', 'musahit', 'C:/repos/musahit')
    const b = row('skeleton-crew', 'ephesus', 'C:/repos/ephesus')
    expect(rememberTarget(rememberTarget([], a), b).map((r) => r.target.id)).toEqual([
      'ephesus',
      'musahit'
    ])
  })

  it('keeps one row per (profile, target), not one per activation', () => {
    const first = row('skeleton-crew', 'musahit', 'C:/repos/musahit', '2026-08-30T00:00:00.000Z')
    const again = row('skeleton-crew', 'musahit', 'C:/repos/musahit', '2026-09-01T00:00:00.000Z')
    const known = rememberTarget(rememberTarget([], first), again)
    expect(known).toHaveLength(1)
    expect(known[0]?.lastUsedAt).toBe('2026-09-01T00:00:00.000Z')
  })

  it('updates the path when the same target moves, rather than listing it twice', () => {
    // Two rows differing only in a path the Architect cannot see on a chip is
    // the failure this upsert key exists to prevent.
    const before = row('skeleton-crew', 'musahit', 'C:/old/musahit')
    const after = row('skeleton-crew', 'musahit', 'C:/new/musahit')
    const known = rememberTarget(rememberTarget([], before), after)
    expect(known).toHaveLength(1)
    expect(known[0]?.target.path).toBe('C:/new/musahit')
  })

  it('keeps the same target separately for each profile that used it', () => {
    const crew = row('skeleton-crew', 'musahit', 'C:/repos/musahit')
    const office = row('front-office', 'musahit', 'C:/repos/musahit')
    const known = rememberTarget(rememberTarget([], crew), office)
    expect(known).toHaveLength(2)
    expect(knownTargetsFor(known, 'skeleton-crew')).toHaveLength(1)
    expect(knownTargetsFor(known, 'front-office')).toHaveLength(1)
  })

  it('never grows past the limit', () => {
    let known: readonly KnownTarget[] = []
    for (let i = 0; i < 10; i += 1)
      known = rememberTarget(known, row('skeleton-crew', `r${i}`, `C:/r${i}`), 3)
    expect(known).toHaveLength(3)
    expect(known.map((r) => r.target.id)).toEqual(['r9', 'r8', 'r7'])
  })

  it('refuses a file that is not the shape it claims', () => {
    expect(
      knownTargetsFileSchema.safeParse({
        schemaVersion: KNOWN_TARGETS_SCHEMA_VERSION,
        targets: [row('skeleton-crew', 'musahit', 'C:/repos/musahit')]
      }).success
    ).toBe(true)
    // An unknown key is a refusal, not a silently ignored field (.strict()).
    expect(
      knownTargetsFileSchema.safeParse({
        schemaVersion: KNOWN_TARGETS_SCHEMA_VERSION,
        targets: [],
        autoActivate: true
      }).success
    ).toBe(false)
    // A target id that could not be an agent directory name is refused here,
    // not discovered at spawn.
    expect(
      knownTargetsFileSchema.safeParse({
        schemaVersion: KNOWN_TARGETS_SCHEMA_VERSION,
        targets: [row('skeleton-crew', 'Not A Slug', 'C:/x')]
      }).success
    ).toBe(false)
  })
})
