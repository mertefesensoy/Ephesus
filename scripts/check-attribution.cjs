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
 * Modes:
 *   (no args)            every commit reachable from HEAD — the CI backstop
 *   --pending [msgfile]  the identity git is about to commit with, plus the message file
 *                        when given — the `.githooks/` pre-commit + commit-msg pair
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

/** Matches `Claude`, `Claude Fable 5`, `claude[bot]` — not a subject line mentioning Claude. */
const CLAUDE_NAME = /^claude\b/i
const ANTHROPIC_EMAIL = /@anthropic\.com$/i
/** Only the two trailers that carry an identity; `Agent: mason` is the sanctioned one. */
const IDENTITY_TRAILER = /^[ \t]*(co-authored-by|claude-session)[ \t]*:(.*)$/i

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
  return { failures, checked: `${commits} commit(s) reachable from HEAD` }
}

function scanPending(messageFile) {
  const failures = []
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
  }
  if (messageFile !== undefined) {
    failures.push(...messageFaults(fs.readFileSync(messageFile, 'utf8')))
  }
  return { failures, checked: messageFile === undefined ? 'pending identity' : 'pending message' }
}

const { failures, checked } =
  process.argv[2] === '--pending' ? scanPending(process.argv[3]) : scanHistory()

if (failures.length > 0) {
  console.error('Attribution tripwire failures (ENGINEERING-STANDARDS §2):\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\n  Claude is never the git author, committer or co-author of an Ephesus commit.')
  console.error('')
  process.exit(1)
}
console.log(`attribution ok (${checked})`)
