#!/usr/bin/env node
/**
 * Attribution tripwire (ENGINEERING-STANDARDS §2). The Architect is the author of
 * record for every commit here; an agent identifies itself in an `Agent:` trailer and
 * never in the git identity.
 *
 * The failure this exists to prevent: GitHub resolves `noreply@anthropic.com` to a real
 * account, so one commit authored or co-authored as Claude puts that account on the
 * repository's contributor graph. Rewriting history afterwards unlinks the commit but
 * leaves the object on the remote and the credit in GitHub's cache — the cheap fix is
 * never letting one land.
 *
 * Two rules, and they are not the same rule:
 *
 *   1. NO VENDOR IDENTITY, ANYWHERE. Absolute, unqualified, every commit reachable
 *      from HEAD. Nothing below relaxes it.
 *   2. THE COMPANY AUTHORS ONLY ON `agent/*`. ADR-0020's carve-out, with ADR-0022's
 *      corrected address: the running company commits as its own GitHub App bot
 *      (`<slug>[bot]`, `<numeric id>+<slug>[bot]@users.noreply.github.com` — see
 *      `src/shared/github-app.ts` `botIdentity`), which is legal on `agent/*` branches
 *      and reaches `main` only through an Architect-merged PR.
 *
 * ## What rule 2 actually checks, and what it cannot
 *
 * A commit object records author, committer, message, tree and parents. It does NOT
 * record the branch it was made on — a branch is a moving pointer, and the name is
 * gone by the time CI reads the history. So in history mode the enforced proposition
 * is a structural proxy, not the literal rule:
 *
 *   IT CATCHES  a company identity on **`main`'s first-parent chain**. That chain
 *               holds exactly the commits made directly on `main` plus the merge
 *               commits; work merged from a branch hangs off the SECOND parent. A bot
 *               commit on the first-parent chain therefore did not arrive by a merge —
 *               it was put straight onto the trunk, which is the fault ADR-0020 names.
 *               A bot-authored merge commit fails the same test: the company merging
 *               its own PR.
 *   IT CATCHES  (pending mode only) the company committing on a branch that is not
 *               `agent/*`. Pending mode is the one moment a branch name exists, so it
 *               enforces the literal rule rather than the proxy. A detached HEAD has no
 *               branch to vouch for it and fails closed.
 *
 *   IT DOES NOT verify that a human reviewed the merge. Server-side branch protection
 *               is what enforces review (ENGINEERING-STANDARDS §2); this reads the
 *               SHAPE of the history, not the authority behind it.
 *   IT DOES NOT know the source branch of a merged commit. History mode cannot tell an
 *               `agent/*` branch from a `feature/*` one — only that the work arrived by
 *               a merge rather than on the trunk.
 *   IT DOES NOT survive a squash or rebase merge. Both replay the bot's authorship
 *               directly onto `main`'s first-parent chain, so a properly reviewed agent
 *               PR merged either way WOULD be flagged. This repository merges with
 *               merge commits, which is what makes the proxy exact here — change the
 *               merge policy and this clause must change with it.
 *   IT DOES NOT flag `Co-authored-by:` lines carrying the bot address. ADR-0022 makes
 *               that trailer the sanctioned per-agent signature; rule 1's co-author
 *               scan still rejects a Claude/Anthropic one.
 *   IT DOES NOT run at all when no `main` ref is resolvable (a shallow or
 *               single-branch checkout). The skip is printed, never silent.
 *
 * The bot identity is matched by FORM, not by name: the company's slug lives in
 * `<harness home>/github-app.json`, which this repository has no access to. So any
 * `[bot]` account on the trunk chain fails — a superset of the Ephesus company
 * account, and deliberately so, since no automated identity has business landing on
 * `main` outside review.
 *
 * Modes:
 *   (no args)            every commit reachable from HEAD, plus `main`'s first-parent
 *                        chain — the CI backstop
 *   --pending [msgfile]  the identity git is about to commit with, the branch it is
 *                        about to commit on, and the message file when given — the
 *                        `.githooks/` pre-commit + commit-msg pair
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

/** Matches `Claude`, `Claude Fable 5`, `claude[bot]` — not a subject line mentioning Claude. */
const CLAUDE_NAME = /^claude\b/i
const ANTHROPIC_EMAIL = /@anthropic\.com$/i
/** Only the two trailers that carry an identity; `Agent: mason` is the sanctioned one. */
const IDENTITY_TRAILER = /^[ \t]*(co-authored-by|claude-session)[ \t]*:(.*)$/i

/**
 * The company's identity as ADR-0022 mints it. The `[bot]` suffix is GitHub's own,
 * issued to a GitHub App's user and unavailable to an ordinary account; the address is
 * the only form GitHub resolves, `<numeric id>+<login>@users.noreply.github.com`.
 */
const BOT_NAME = /\[bot\]$/
const BOT_EMAIL = /^\d+\+[^@\s]+\[bot\]@users\.noreply\.github\.com$/i
/** ENGINEERING-STANDARDS §2's branch convention: `agent/<name>/<topic>`. */
const AGENT_BRANCH = /^agent\/.+/

/** Where `main` might live, in the order a checkout is likely to have it. */
const TRUNK_REFS = ['refs/heads/main', 'refs/remotes/origin/main']

/** ASCII unit/record separators: git log fields are free text, these are not. */
const UNIT = '\u001f'
const RECORD = '\u001e'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/** @returns {string|null} the fault, or null when the identity is clean. */
function identityFault(role, name, email) {
  if (CLAUDE_NAME.test(name.trim())) return `${role} name is a Claude identity: "${name}"`
  if (ANTHROPIC_EMAIL.test(email.trim())) {
    return `${role} email is an Anthropic identity: "${email}"`
  }
  return null
}

/**
 * Contract: pure. True when this identity is an automated GitHub App account — the
 * company's own, or any other bot. Matched on form because the company's slug is
 * harness configuration, not a fact this repository can read.
 */
function isCompanyIdentity(name, email) {
  return BOT_NAME.test(name.trim()) || BOT_EMAIL.test(email.trim())
}

/**
 * Contract: pure. @returns {string|null} the fault when a company identity is about to
 * commit somewhere it may not, else null. `branch` is null for a detached HEAD, which
 * cannot vouch for itself and so is refused.
 */
function companyBranchFault(role, name, email, branch) {
  if (!isCompanyIdentity(name, email)) return null
  if (branch !== null && AGENT_BRANCH.test(branch)) return null
  const where = branch === null ? 'a detached HEAD' : `branch "${branch}"`
  return `${role} is a company identity ("${name.trim()}") on ${where}`
}

function messageFaults(message) {
  const faults = []
  for (const line of message.split('\n')) {
    if (line.startsWith('#')) continue
    const match = IDENTITY_TRAILER.exec(line)
    if (match === null) continue
    const trailer = line.trim()
    if (match[1].toLowerCase() === 'claude-session') {
      faults.push(`Claude-Session trailer: \`${trailer}\``)
      continue
    }
    const value = match[2]
    const email = (/<([^>]*)>/.exec(value) || ['', ''])[1]
    const name = value.replace(/<[^>]*>/, '').trim()
    if (CLAUDE_NAME.test(name) || ANTHROPIC_EMAIL.test(email.trim())) {
      faults.push(`Claude co-author trailer: \`${trailer}\``)
    }
  }
  return faults
}

/** @returns {string|null} the first resolvable `main`, or null in a checkout without one. */
function trunkRef() {
  for (const ref of TRUNK_REFS) {
    try {
      git(['rev-parse', '--verify', '--quiet', ref])
      return ref
    } catch {
      // Absent in this checkout; try the next candidate.
    }
  }
  return null
}

/** @returns {string|null} the branch about to be committed on, or null when detached. */
function currentBranch() {
  try {
    const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']).trim()
    return branch === '' ? null : branch
  } catch {
    // Detached HEAD: git exits non-zero rather than naming a branch.
    return null
  }
}

/**
 * Rule 2's history half. Walks `main`'s first-parent chain — the commits put ON the
 * trunk rather than merged INTO it — and refuses a company identity there. Read the
 * header before widening this: the chain is a proxy for "did not arrive by a merge",
 * and it is only as exact as the repository's merge policy.
 */
function scanTrunk() {
  const ref = trunkRef()
  if (ref === null) {
    return {
      failures: [],
      checked: `no ${TRUNK_REFS.join(' or ')} in this checkout — company-on-main NOT checked`
    }
  }
  const format = ['%H', '%an', '%ae', '%cn', '%ce'].join(UNIT) + RECORD
  const log = git(['log', '--first-parent', `--format=${format}`, ref])
  const failures = []
  let commits = 0
  for (const record of log.split(RECORD)) {
    const fields = record.replace(/^\n/, '')
    if (fields.trim() === '') continue
    commits += 1
    const [sha, authorName, authorEmail, committerName, committerEmail] = fields.split(UNIT)
    for (const [role, name, email] of [
      ['author', authorName, authorEmail],
      ['committer', committerName, committerEmail]
    ]) {
      if (!isCompanyIdentity(name, email)) continue
      failures.push(
        `${sha.slice(0, 8)}  ${role} is a company identity ("${name.trim()}") on ` +
          `${ref}'s first-parent chain: committed to main, not merged into it`
      )
    }
  }
  return { failures, checked: `${commits} on ${ref}'s first-parent chain` }
}

function scanHistory() {
  const format = ['%H', '%an', '%ae', '%cn', '%ce', '%B'].join(UNIT) + RECORD
  const log = git(['log', `--format=${format}`])
  const failures = []
  let commits = 0
  for (const record of log.split(RECORD)) {
    const fields = record.replace(/^\n/, '')
    if (fields.trim() === '') continue
    commits += 1
    const [sha, authorName, authorEmail, committerName, committerEmail, message] =
      fields.split(UNIT)
    for (const fault of [
      identityFault('author', authorName, authorEmail),
      identityFault('committer', committerName, committerEmail),
      ...messageFaults(message)
    ]) {
      if (fault !== null) failures.push(`${sha.slice(0, 8)}  ${fault}`)
    }
  }
  const trunk = scanTrunk()
  return {
    failures: [...failures, ...trunk.failures],
    checked: `${commits} commit(s) reachable from HEAD; ${trunk.checked}`
  }
}

function scanPending(messageFile) {
  const failures = []
  const branch = currentBranch()
  for (const [role, variable] of [
    ['author', 'GIT_AUTHOR_IDENT'],
    ['committer', 'GIT_COMMITTER_IDENT']
  ]) {
    const parsed = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(git(['var', variable]).trim())
    if (parsed === null) continue
    const fault = identityFault(role, parsed[1], parsed[2])
    if (fault !== null) {
      failures.push(`${fault}\n    fix: set git config user.name / user.email, then re-commit`)
    }
    const branchFault = companyBranchFault(role, parsed[1], parsed[2], branch)
    if (branchFault !== null) {
      failures.push(
        `${branchFault}\n    fix: the company commits only on agent/<name>/<topic>, and` +
          ' reaches main through an Architect-merged PR (ADR-0020)'
      )
    }
  }
  if (messageFile !== undefined) {
    failures.push(...messageFaults(fs.readFileSync(messageFile, 'utf8')))
  }
  const where = branch === null ? 'detached HEAD' : `branch ${branch}`
  return {
    failures,
    checked: messageFile === undefined ? `pending identity on ${where}` : 'pending message'
  }
}

/** @returns {number} the process exit code, so a test can call this without exiting. */
function main(argv) {
  const { failures, checked } = argv[2] === '--pending' ? scanPending(argv[3]) : scanHistory()

  if (failures.length > 0) {
    console.error('Attribution tripwire failures (ENGINEERING-STANDARDS §2):\n')
    for (const failure of failures) console.error(`  ${failure}`)
    console.error(
      '\n  Claude is never the git author, committer or co-author of an Ephesus commit.'
    )
    console.error('  The company authors only on agent/* branches (ADR-0020, ADR-0022).')
    console.error('')
    return 1
  }
  console.log(`attribution ok (${checked})`)
  return 0
}

if (require.main === module) process.exit(main(process.argv))

module.exports = {
  identityFault,
  isCompanyIdentity,
  companyBranchFault,
  messageFaults,
  currentBranch,
  trunkRef,
  scanTrunk,
  scanHistory,
  scanPending,
  main
}
