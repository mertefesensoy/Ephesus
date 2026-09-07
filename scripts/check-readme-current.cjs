#!/usr/bin/env node
'use strict'

/**
 * The README's landed list keeps up with the register (M8.4 audit, 2026-09-07).
 *
 * ## Why this exists
 *
 * M8.4's own package line named the defect: "the README has no setup section and
 * its status is two milestones stale". It fixed both. By M8.9 the same section
 * was three packages stale again — M8.6, M8.7a/b and M8.8 had landed and the
 * front door still described a company without worktree isolation, without
 * engine isolation, and without a survivable restart. Nothing was watching, so
 * it came straight back.
 *
 * ## What it checks, and what it deliberately does not
 *
 * The README carries an HTML comment naming the packages its narrative covers.
 * This compares that set against the packages ticked in `docs/PROGRESS.md`.
 *
 * It does NOT read the prose. Deciding whether a paragraph "describes" a package
 * is not something a script can do, and a check that guessed would either block
 * good writing or pass bad writing — both worse than no check.
 *
 * So the marker is a CLAIM, and this verifies the claim is complete. It catches
 * the oversight — a package landing while nobody touched the README — which is
 * the failure that actually happened, twice. It cannot catch someone editing the
 * marker without writing the sentence; that is a deliberate lie rather than an
 * oversight, and a different problem.
 *
 * Exit 0 when the sets agree, 1 with the difference named otherwise.
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const README = path.join(root, 'README.md')
const PROGRESS = path.join(root, 'docs', 'PROGRESS.md')

/**
 * The packages ticked in the register for the milestone the README is about.
 *
 * Scoped to ONE milestone deliberately: "Landed so far" is the current
 * milestone's narrative, and everything before it lives under *the previous
 * milestone's story* or in `docs/PROGRESS.md`. Requiring the README to name
 * every package since M0 would be asking the front door to be the register.
 *
 * The milestone is the one holding the most recently ticked package — which is
 * what the README should be describing — rather than the first with unticked
 * work, so a milestone whose first package has not landed yet does not make
 * this demand a paragraph about nothing.
 */
function landedPackages(progress) {
  const ticked = []
  for (const line of progress.split('\n')) {
    const match = /^- \[x\] \*\*(M(\d+)(?:\.\d+)?[a-z]?)\b/.exec(line.trim())
    if (match && match[1] && match[2]) ticked.push({ id: match[1], milestone: match[2] })
  }
  const last = ticked[ticked.length - 1]
  if (last === undefined) return { milestone: null, ids: [] }
  const ids = []
  for (const entry of ticked) {
    // The milestone's own summary row (`M8`) is not a package; the packages are
    // the numbered ones under it.
    if (entry.milestone === last.milestone && entry.id !== `M${entry.milestone}`) ids.push(entry.id)
  }
  return { milestone: `M${last.milestone}`, ids }
}

/** The README's own claim about what its narrative covers. */
function claimedPackages(readme) {
  const marker = /<!--\s*landed:([^]*?)-->/.exec(readme)
  if (!marker || marker[1] === undefined) return null
  // Only the first line of the comment is the list; the rest explains it.
  const firstLine = marker[1].split('\n')[0] ?? ''
  return firstLine.trim().split(/\s+/).filter(Boolean)
}

function main() {
  const readme = fs.readFileSync(README, 'utf8')
  const progress = fs.readFileSync(PROGRESS, 'utf8')

  const claimed = claimedPackages(readme)
  if (claimed === null) {
    console.error(
      'README.md has no `<!-- landed: ... -->` marker, so nothing relates it to the register.\n' +
        'Add one naming the packages the "Landed so far" narrative covers.'
    )
    process.exit(1)
  }

  const { milestone, ids: landed } = landedPackages(progress)
  if (milestone === null || landed.length === 0) {
    console.log('no milestone has a ticked package yet — nothing for the README to claim.')
    return
  }

  const claimedSet = new Set(claimed)
  const landedSet = new Set(landed)
  const missing = landed.filter((id) => !claimedSet.has(id))
  const surplus = claimed.filter((id) => !landedSet.has(id))

  if (missing.length === 0 && surplus.length === 0) {
    console.log(
      `README landed list is current for ${milestone} (${String(landed.length)} package(s)).`
    )
    return
  }

  console.error("README.md's landed list disagrees with docs/PROGRESS.md:\n")
  if (missing.length > 0) {
    console.error(
      `  ticked in the register, absent from the README: ${missing.join(', ')}\n` +
        '    — write what it did into "Landed so far" and add it to the marker. The front\n' +
        '      door describing a company older than the tree is how somebody decides not to\n' +
        '      install this over a problem that was fixed two packages ago.'
    )
  }
  if (surplus.length > 0) {
    console.error(
      `  claimed by the README, not ticked in the register: ${surplus.join(', ')}\n` +
        '    — either the package is not done, or the marker names it too early.'
    )
  }
  process.exit(1)
}

main()
