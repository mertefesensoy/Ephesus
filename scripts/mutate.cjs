#!/usr/bin/env node
/**
 * One mutation round, run from one checked-in spec (GYM-008, TEST-STRATEGY §10).
 *
 *   node scripts/mutate.cjs test/mutation/<package>.json [--check]
 *       [--retries <n>] [--retry-wait <seconds>] [--timeout <seconds>]
 *
 * A round plants one hand-aimed change at a time in the code a package claims
 * to defend, runs the package's test files against each, and puts the file
 * back. A mutant the tests fail is KILLED; one they pass is a SURVIVOR, and a
 * survivor is a question, not a score. Exit status: 0 the round is OK, 1 it
 * has survivors, 2 it is INVALID — it could not be scored, and saying so is
 * the point.
 *
 * This was a scratch script for three milestones and it was rebuilt from
 * memory each time; every requirement below is a way an earlier round lied.
 *
 * 1. A planted no-op CONTROL must survive, and a spec that declares none is
 *    refused: a round that cannot tell an unearned kill from a real one has
 *    no certificate.
 * 2. The suite runs once before the first mutant, and the round stops unless
 *    it is green — a red baseline makes every mutant, the control included,
 *    look killed (M8b.3).
 * 3. A run is read from vitest's JSON report, never from its exit code alone:
 *    the suite's free-memory gate refuses to start and exits 1
 *    (`test/global-setup.ts`), and a harness scoring by exit code reported
 *    those refusals as clean sweeps (2026-09-09, 2026-10-02). A run in which no
 *    file ran, or a listed file did not run, or an unlisted one did, is
 *    INVALID; a refusal to start is retried after a wait.
 * 4. Every file in the round — the mutated files, the test files and the spec
 *    — is hashed when the round starts, after every run and after every
 *    restore, and every mutant is built from the bytes the round started with.
 *    OneDrive put a restored file back with a mutant in it, twice, seconds
 *    after its check had passed (2026-09-09, 2026-10-02).
 * 5. Files are read and written as bytes, so a restore is exact and a CRLF
 *    never appears in an LF file.
 * 6. The round's files must be committed, clean and plainly tracked:
 *    `git checkout --` is the restore and `git status` a second check. That is
 *    why this file is in `GIT_ALLOWLIST` (`scripts/check-invariants.cjs`) and
 *    `GIT_DOORS` (`test/temp-hygiene.test.ts`): it runs git on the development
 *    repository and never on a harness home (DECISIONS-LOG 2026-10-03).
 * 7. Every run prints the test files it actually ran. A score is scoped to
 *    them, and M8b.3's 6 of 6 kills were followed by two scenario failures the
 *    round never loaded.
 * 8. Every anchor matches its file exactly once, checked before the baseline:
 *    an anchor matching nothing makes a mutant a no-op that "survives", and one
 *    matching twice is an edit nobody chose.
 * 9. A survivor exits 1 and prints the triage question, so it stops the round
 *    instead of decorating a table.
 *
 * And what an adversarial pass then broke, every case reproduced before it
 * was closed (DECISIONS-LOG 2026-10-03): a run is scored over the tests that
 * PASSED at the baseline, so a skipped file defends nothing and a worker that
 * dies is not a survival; a report with no failure from a vitest that exited
 * non-zero (an unhandled error, a dead worker) is INVALID; the whole working
 * tree is guarded, not only the round's files; a round file must sit inside
 * the repository by its real path, have one hard link, hold the bytes git
 * indexed and carry no flag that hides it from git; a timed-out run is
 * INVALID and not retried; and a spec cannot name a path vitest would read as
 * an option, or an anchor in malformed Unicode.
 */
const { Buffer } = require('node:buffer')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCHEMA_VERSION = 1
const EXIT = { ok: 0, survivors: 1, invalid: 2 }
const SPEC_KEYS = new Set(['schemaVersion', 'package', 'about', 'tests', 'mutants'])
const MUTANT_KEYS = new Set(['id', 'file', 'find', 'replace', 'why', 'control'])
const DEFAULTS = { retries: 2, retryWaitSeconds: 30, timeoutSeconds: 900 }

/** What a survivor obliges its author to answer (requirement 9). */
const TRIAGE = [
  'Is this state reachable from outside the module, and can any listed test file read the line you changed?',
  '  yes -> a test is missing: write it, commit, and run the round again;',
  '  no  -> the mutant is equivalent, which is a design smell: two things that cannot disagree. Remove the duplicate, or record why it stays.'
]

/** The round cannot be scored. Carries the reason a reader acts on. */
class Invalid extends Error {}

/**
 * Contract: pure. Whether `text` survives UTF-8 unchanged. A lone surrogate
 * does not: it is encoded as U+FFFD, so an anchor holding one would match text
 * its author never wrote.
 */
const wellFormed = (text) => Buffer.from(text, 'utf8').toString('utf8') === text

/**
 * Contract: pure. Every problem with a parsed spec, as sentences; empty when it
 * is usable. Unknown keys are refused, so a misspelt `control` is a refusal
 * rather than a spec that quietly has no control.
 */
function specProblems(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['the spec is not a JSON object']
  }
  const problems = []
  for (const key of Object.keys(doc)) {
    if (!SPEC_KEYS.has(key)) problems.push(`unknown key "${key}"`)
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    problems.push(
      `schemaVersion is ${String(doc.schemaVersion)}; this tool reads ${SCHEMA_VERSION}`
    )
  }
  for (const key of ['package', 'about']) {
    if (typeof doc[key] !== 'string' || doc[key].trim() === '') {
      problems.push(`"${key}" must be a non-empty string`)
    }
  }
  if (!Array.isArray(doc.tests) || doc.tests.length === 0) {
    problems.push('"tests" must list at least one test file')
  } else {
    doc.tests.forEach((test, i) => problems.push(...pathProblems(test, `tests[${i}]`)))
    if (new Set(doc.tests).size !== doc.tests.length) problems.push('"tests" lists a file twice')
  }
  if (!Array.isArray(doc.mutants) || doc.mutants.length === 0) {
    problems.push('"mutants" must list at least one mutant')
    return problems
  }
  const ids = new Set()
  doc.mutants.forEach((mutant, i) => {
    const at = `mutants[${i}]`
    if (mutant === null || typeof mutant !== 'object' || Array.isArray(mutant)) {
      problems.push(`${at} is not an object`)
      return
    }
    for (const key of Object.keys(mutant)) {
      if (!MUTANT_KEYS.has(key)) problems.push(`${at} has unknown key "${key}"`)
    }
    if (typeof mutant.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(mutant.id)) {
      problems.push(`${at}.id must be letters, digits, ".", "_" or "-"`)
    } else if (ids.has(mutant.id)) {
      problems.push(`${at}.id "${mutant.id}" is used twice`)
    } else {
      ids.add(mutant.id)
    }
    problems.push(...pathProblems(mutant.file, `${at}.file`))
    if (typeof mutant.find !== 'string' || mutant.find === '') {
      problems.push(`${at}.find must be a non-empty string`)
    } else if (!wellFormed(mutant.find)) {
      problems.push(`${at}.find is not well-formed Unicode, so it would match text nobody wrote`)
    }
    if (typeof mutant.replace !== 'string') problems.push(`${at}.replace must be a string`)
    else if (mutant.replace === mutant.find) {
      problems.push(`${at}.replace equals its find, so applying it changes nothing`)
    } else if (!wellFormed(mutant.replace)) {
      problems.push(`${at}.replace is not well-formed Unicode`)
    }
    if (typeof mutant.why !== 'string' || mutant.why.trim() === '') {
      problems.push(`${at}.why must say which sentence the mutant attacks`)
    }
    if (mutant.control !== undefined && typeof mutant.control !== 'boolean') {
      problems.push(`${at}.control must be true or false`)
    }
  })
  if (!doc.mutants.some((mutant) => mutant && mutant.control === true)) {
    problems.push(
      'no mutant is a control: plant a no-op ("control": true) whose survival certifies the round, or a kill cannot be told from a harness that scores everything as killed'
    )
  }
  return problems
}

/**
 * Contract: pure. A spec path is relative, forward-slashed, stays inside the
 * repository, and has no part vitest's command line would read as an option.
 */
function pathProblems(value, at) {
  if (typeof value !== 'string' || value === '') return [`${at} must be a non-empty path`]
  if (value.includes('\\')) return [`${at} "${value}" must use forward slashes`]
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return [`${at} "${value}" must be relative to the repository root`]
  }
  const parts = value.split('/')
  if (parts.some((part) => part === '..' || part === '.' || part === '')) {
    return [`${at} "${value}" must name a file inside the repository, without "." or ".." steps`]
  }
  if (parts.some((part) => part.startsWith('-'))) {
    return [`${at} "${value}" has a part beginning with "-", which vitest would read as an option`]
  }
  return []
}

/** Contract: pure. How many times `needle` occurs in `haystack`, overlapping occurrences included. */
function occurrences(haystack, needle) {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count++
  return count
}

/** Contract: pure. `bytes` with its single occurrence of `find` replaced; throws unless there is exactly one. */
function mutate(bytes, find, replace) {
  const needle = Buffer.from(find, 'utf8')
  const count = occurrences(bytes, needle)
  if (count !== 1)
    throw new Invalid(`the anchor matches ${count} times; it must match exactly once`)
  const at = bytes.indexOf(needle)
  return Buffer.concat([
    bytes.subarray(0, at),
    Buffer.from(replace, 'utf8'),
    bytes.subarray(at + needle.length)
  ])
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

/** Every round file's hash, keyed by its spec path. */
function hashes(root, files) {
  return new Map(files.map((file) => [file, sha256(fs.readFileSync(path.join(root, file)))]))
}

/** The files whose bytes no longer hash to what `expected` recorded. */
function drift(root, expected) {
  const now = hashes(root, [...expected.keys()])
  return [...expected].filter(([file, hash]) => now.get(file) !== hash).map(([file]) => file)
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error) throw new Invalid(`git ${args[0]} could not start: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Invalid(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout
}

/**
 * The working tree's changes outside the round's own files, as `git status`
 * prints them, untracked files one by one; ignored files are not shown. The
 * round's files are left to their hashes, which see what `status` can miss —
 * so each check guards ground the other does not, and neither can hide behind
 * the other.
 */
function treeChanges(root, files) {
  return git(root, ['status', '--porcelain', '-z', '--untracked-files=all'])
    .split('\0')
    .filter(Boolean)
    .filter((entry) => !files.includes(entry.slice(3)))
}

/**
 * Every reason a round file is not what git holds, where git holds it
 * (requirement 6). Each refusal is a way the restore would have lied: a file
 * reached through a link outside the repository is written there; a second
 * hard link keeps the mutant after the restore replaces this one; bytes that
 * differ from the index are an edit `git checkout --` would destroy; and a file
 * git is told not to look at is one it will neither report nor restore.
 */
function fileProblems(root, files) {
  const problems = []
  const realRoot = fs.realpathSync.native(root)
  const plain = []
  for (const file of files) {
    const full = path.join(root, file)
    const stat = fs.lstatSync(full, { throwIfNoEntry: false })
    if (stat === undefined || !stat.isFile()) {
      problems.push(`${file} is not a regular file in ${root}`)
      continue
    }
    const real = fs.realpathSync.native(full)
    const inside = path.relative(realRoot, real)
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
      problems.push(`${file} resolves to ${real}, outside the repository: a link on its path`)
    } else if (stat.nlink > 1) {
      problems.push(
        `${file} has ${stat.nlink} hard links: a mutant written to it lands in every one, and the restore puts back only this one`
      )
    } else {
      plain.push(file)
    }
  }
  if (plain.length === 0) return problems
  const tags = new Map(
    git(root, ['ls-files', '-v', '-z', '--', ...plain])
      .split('\0')
      .filter(Boolean)
      .map((entry) => [entry.slice(2), entry[0]])
  )
  const indexed = new Map(
    git(root, ['ls-files', '-s', '-z', '--', ...plain])
      .split('\0')
      .filter(Boolean)
      .map((entry) => [entry.split('\t')[1], entry.split(' ')[1]])
  )
  const tracked = plain.filter((file) => tags.has(file))
  for (const file of plain) {
    if (!tags.has(file)) problems.push(`not tracked by git: ${file}`)
  }
  if (tracked.length === 0) return problems
  const bytes = git(root, ['hash-object', '--', ...tracked])
    .trim()
    .split('\n')
  tracked.forEach((file, i) => {
    if (bytes[i] !== indexed.get(file)) {
      problems.push(
        `${file} does not hold the bytes git has indexed: an edit \`git status\` is not showing, which the restore would destroy`
      )
    }
    if (tags.get(file) !== 'H') {
      problems.push(
        `git is told not to look at ${file} (ls-files -v "${tags.get(file)}": assume-unchanged or skip-worktree), so it would neither report nor restore it`
      )
    }
  })
  return problems
}

/**
 * Contract: pure. vitest's report as the round reads it: per file, its path in
 * the repository, its status, its message and its tests, sorted by path.
 * `null` when no report was written.
 */
function filesOf(report, root) {
  if (report === null) return null
  return (report.testResults ?? [])
    .map((file) => ({
      file: path.relative(root, file.name).split(path.sep).join('/'),
      status: file.status,
      message: file.message ?? '',
      tests: (file.assertionResults ?? []).map((test) => ({
        name: test.fullName,
        status: test.status
      }))
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/** Contract: pure. The tests with `status`, each named by its file, its full name and its place among same-named tests. */
function testsWith(files, status) {
  const keys = []
  for (const file of files) {
    const seen = new Map()
    for (const test of file.tests) {
      const n = (seen.get(test.name) ?? 0) + 1
      seen.set(test.name, n)
      if (test.status === status) keys.push(`${file.file} › ${test.name} #${n}`)
    }
  }
  return keys
}

/**
 * Contract: pure. What one vitest run means for the round. `run` is the report
 * (`null` when none was written), its files as `filesOf` reads them, vitest's
 * exit status and whether `--timeout` ended it; `listed` are the spec's test
 * files; `expected` is the set of tests that passed at the baseline, or `null`
 * when this run IS the baseline. `kind` is `pass`, `fail` or `invalid`. A
 * failure is a `test` failure (an assertion) or a `file` failure (a file that
 * could not load, or a hook that threw), and the second is still a kill, named
 * so it is triaged. A pass carries the tests that passed and the count skipped.
 */
function classify(run, listed, expected) {
  const { report, files, exit, timedOut } = run
  if (timedOut) {
    return { kind: 'invalid', retry: false, reason: 'the run did not finish within --timeout' }
  }
  // Measured on vitest 4.1.11: a global setup that THROWS — the suite's
  // free-memory gate does — writes a report holding no file at all, and one
  // that exits writes none. Either way nothing ran, and waiting may fix it.
  if (report === null || files.length === 0) {
    return {
      kind: 'invalid',
      retry: true,
      reason:
        'no test file ran: vitest wrote no report, or one holding no file — the suite refused to start (the free-memory gate does this), its setup failed, or it was killed'
    }
  }
  const ran = files.map((file) => file.file)
  const missing = listed.filter((file) => !ran.includes(file))
  if (missing.length > 0) {
    return {
      kind: 'invalid',
      retry: false,
      reason: `listed test files did not run: ${missing.join(', ')}`
    }
  }
  const extra = ran.filter((file) => !listed.includes(file))
  if (extra.length > 0) {
    return {
      kind: 'invalid',
      retry: false,
      reason: `vitest also ran files the spec does not list: ${extra.join(', ')} — a file argument is a filter, so list them or name a narrower path`
    }
  }
  const failedFiles = files.filter((file) => file.status === 'failed')
  if ((report.numFailedTests ?? 0) > 0) return { kind: 'fail', how: 'test', failedFiles }
  if (failedFiles.length > 0) return { kind: 'fail', how: 'file', failedFiles }
  // The report says nothing failed. vitest's exit says otherwise when an
  // error escaped every test or a worker died: its report keeps
  // `success: true` through both. Neither is a pass, and neither is a kill.
  if (exit !== 0) {
    return {
      kind: 'invalid',
      retry: false,
      reason: `vitest exited ${String(exit)} though its report holds no failure: an error outside any test, or a worker that died`
    }
  }
  if (report.success !== true) {
    return {
      kind: 'invalid',
      retry: false,
      reason: 'vitest reported failure without a failing test or file'
    }
  }
  const passed = new Set(testsWith(files, 'passed'))
  if (expected === null) {
    const idle = files
      .filter((file) => !file.tests.some((test) => test.status === 'passed'))
      .map((file) => file.file)
    if (idle.length > 0) {
      return {
        kind: 'invalid',
        retry: false,
        reason: `${idle.join(', ')} holds no test that passed: a file whose tests are all skipped, todo or filtered defends nothing`
      }
    }
  } else {
    const unfinished = [...expected].filter((test) => !passed.has(test))
    if (unfinished.length > 0) {
      return {
        kind: 'invalid',
        retry: false,
        reason: `${unfinished.length} test(s) that passed at the baseline did not pass or fail here, first ${unfinished[0]}: a worker died, or the mutant made them skip`
      }
    }
  }
  const skipped = files.reduce(
    (sum, file) => sum + file.tests.filter((test) => test.status !== 'passed').length,
    0
  )
  return { kind: 'pass', passed, skipped }
}

/** The vitest this repository runs: the round's own first, then this tool's. */
function vitestBin(root) {
  const manifest = require.resolve('vitest/package.json', { paths: [root, __dirname] })
  return path.join(path.dirname(manifest), 'vitest.mjs')
}

/**
 * One vitest run over the listed files, read back as a report and scored
 * against `expected` (see `classify`). Blocks until it ends or times out.
 */
function runSuite(root, tests, options, expected) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-mutate-'))
  try {
    // Absolute, because vitest resolves a relative `--outputFile` against its
    // own root and the report would land inside the repository.
    const out = path.join(scratch, 'report.json')
    const child = spawnSync(
      process.execPath,
      [vitestBin(root), 'run', ...tests, '--reporter=json', `--outputFile=${out}`],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutSeconds * 1000
      }
    )
    let report = null
    if (fs.existsSync(out)) {
      try {
        report = JSON.parse(fs.readFileSync(out, 'utf8'))
      } catch {
        report = null
      }
    }
    const files = filesOf(report, root)
    const run = {
      report,
      files,
      exit: child.status ?? child.signal,
      timedOut: child.error?.code === 'ETIMEDOUT'
    }
    const log = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim().split('\n').slice(-6)
    return {
      verdict: classify(run, tests, expected),
      report,
      ran: (files ?? []).map((file) => file.file),
      log
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/** A run, retried while its result is a refusal to start rather than an answer. */
function runAnswered(root, tests, options, label, expected) {
  for (let attempt = 0; ; attempt++) {
    const run = runSuite(root, tests, options, expected)
    const { verdict } = run
    if (verdict.kind !== 'invalid' || !verdict.retry || attempt >= options.retries) return run
    console.log(
      `  ${label}: ${verdict.reason} — waiting ${options.retryWaitSeconds}s, then retrying (${attempt + 1} of ${options.retries})`
    )
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.retryWaitSeconds * 1000)
  }
}

const counted = (run) => {
  const files = `${run.ran.length} file${run.ran.length === 1 ? '' : 's'}`
  if (run.verdict.kind !== 'pass') return files
  const skipped = run.verdict.skipped > 0 ? `, ${run.verdict.skipped} not run` : ''
  return `${files}, ${run.verdict.passed.size} passed${skipped}`
}

const firstLine = (failedFiles) =>
  failedFiles.map((file) => file.message.split('\n')[0]).find(Boolean) ?? 'no message'

/** A fault as the sentence the reader gets: a refusal's own words, or a crash's stack. */
const described = (err) =>
  err instanceof Invalid ? err.message : `the harness failed: ${err.stack ?? String(err)}`

/**
 * Puts one mutant's file back from git and proves it: every round file hashes
 * as it did before the round, and git sees nothing changed. Returns the
 * refusal when the restore did not hold, or null.
 */
function restore(root, mutant, files, clean) {
  try {
    git(root, ['checkout', '--', mutant.file])
    const after = drift(root, clean)
    const status = git(root, ['status', '--porcelain', '--', ...files]).trim()
    if (after.length === 0 && status === '') return null
    return new Invalid(
      `${mutant.id}: the restore did not hold (${[...after, status].filter(Boolean).join('; ')}); inspect the tree before anything else`
    )
  } catch (err) {
    return new Invalid(`${mutant.id}: the restore failed: ${err.message}; inspect the tree`)
  }
}

/**
 * The round: validate, check, baseline, then each mutant in spec order.
 * Returns the exit status. Every mutant is put back before the next starts,
 * and before this returns or throws.
 */
function runRound(specArg, options) {
  const specPath = path.resolve(specArg)
  if (!fs.existsSync(specPath)) throw new Invalid(`no spec at ${specArg}`)
  let spec
  try {
    spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
  } catch (err) {
    throw new Invalid(`the spec does not parse: ${err.message}`)
  }
  const problems = specProblems(spec)
  if (problems.length > 0) throw new Invalid(`the spec is refused:\n  ${problems.join('\n  ')}`)

  const root = git(path.dirname(specPath), ['rev-parse', '--show-toplevel']).trim()
  const specFile = path.relative(root, specPath).split(path.sep).join('/')
  if (specFile.startsWith('..')) throw new Invalid(`the spec is outside the repository ${root}`)
  const files = [...new Set([specFile, ...spec.tests, ...spec.mutants.map((m) => m.file)])]

  // Requirement 6, and the tree around it: the round starts from a tree that is
  // exactly what was committed, so anything it finds changed later, it changed.
  const unclean = treeChanges(root, [])
  if (unclean.length > 0) {
    throw new Invalid(
      `the working tree must be clean before a round, untracked files included — commit, stash or remove:\n  ${unclean.join('\n  ')}`
    )
  }
  const refused = fileProblems(root, files)
  if (refused.length > 0) {
    throw new Invalid(
      `every round file must be committed, plainly tracked and inside the repository, so git can restore it:\n  ${refused.join('\n  ')}`
    )
  }
  // Requirement 8, before anything runs.
  const anchorProblems = spec.mutants
    .map((m) => [m, occurrences(fs.readFileSync(path.join(root, m.file)), Buffer.from(m.find))])
    .filter(([, count]) => count !== 1)
    .map(([m, count]) => `${m.id}: its anchor matches ${m.file} ${count} times`)
  if (anchorProblems.length > 0) {
    throw new Invalid(`every anchor must match exactly once:\n  ${anchorProblems.join('\n  ')}`)
  }

  console.log(`mutation round: ${spec.package} — ${spec.about}`)
  console.log(`root ${root} · ${files.length} round files hashed · tests: ${spec.tests.join(', ')}`)
  console.log(`anchors: ${spec.mutants.length} of ${spec.mutants.length} match exactly once`)
  if (options.check) {
    console.log('CHECKED — the spec and its anchors are sound; nothing was run')
    return EXIT.ok
  }

  // Each mutant is built from these bytes, never from the file as it stands
  // later: a write that lands before a mutant is written is overwritten by it,
  // and one that lands after is caught when the run ends.
  const cleanBytes = new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file))]))
  const clean = new Map([...cleanBytes].map(([file, bytes]) => [file, sha256(bytes)]))
  const baseline = runAnswered(root, spec.tests, options, 'baseline', null)
  if (baseline.verdict.kind !== 'pass') {
    const why =
      baseline.verdict.kind === 'fail'
        ? 'the suite is red before any mutant is applied, so every mutant would look killed'
        : baseline.verdict.reason
    throw new Invalid(`baseline: ${why}\n  ${baseline.log.join('\n  ')}`)
  }
  const changed = [...drift(root, clean), ...treeChanges(root, files)]
  if (changed.length > 0) throw new Invalid(`the baseline run changed ${changed.join(', ')}`)
  console.log(`baseline: PASS — ${counted(baseline)}: ${baseline.ran.join(', ')}`)
  const expected = baseline.verdict.passed

  console.log(
    'an interrupted round leaves its mutant in the file: `git status` shows it, `git checkout -- <file>` restores it, and the next round refuses to start until then'
  )
  const survivors = []
  for (const mutant of spec.mutants) {
    const target = path.join(root, mutant.file)
    const mutated = mutate(cleanBytes.get(mutant.file), mutant.find, mutant.replace)
    fs.writeFileSync(target, mutated)
    let run = null
    let fault = null
    try {
      run = runAnswered(root, spec.tests, options, mutant.id, expected)
      const during = drift(root, clean).filter((file) => file !== mutant.file)
      if (sha256(fs.readFileSync(target)) !== sha256(mutated)) during.unshift(mutant.file)
      const wrote = treeChanges(root, files)
      if (during.length > 0 || wrote.length > 0) {
        throw new Invalid(
          `${mutant.id}: ${[...during, ...wrote].join(', ')} changed while the suite ran — the suite, the mutant or a sync client wrote it, so the verdict cannot be trusted`
        )
      }
    } catch (err) {
      fault = err
    }
    // The restore runs whatever happened above. When both fail, both are
    // reported: the fault says why, and the restore says the tree is no longer
    // what was committed.
    const unrestored = restore(root, mutant, files, clean)
    if (fault !== null && unrestored !== null) {
      throw new Invalid(`${described(fault)}\n  and then ${unrestored.message}`)
    }
    if (unrestored !== null) throw unrestored
    if (fault !== null) throw fault

    const { verdict } = run
    const where = `[${counted(run)}]`
    if (verdict.kind === 'invalid') {
      throw new Invalid(`${mutant.id}: ${verdict.reason}\n  ${run.log.join('\n  ')}`)
    }
    if (mutant.control) {
      if (verdict.kind === 'fail') {
        throw new Invalid(
          `${mutant.id}: the control was KILLED. It changes nothing a test can see, so the suite or this harness cannot be trusted; no verdict in this round stands`
        )
      }
      console.log(`  ${mutant.id}  control  SURVIVED — certifies the round  ${where}`)
    } else if (verdict.kind === 'fail') {
      const how =
        verdict.how === 'test'
          ? `${run.report.numFailedTests} tests failed`
          : `a test file failed without a failing test: ${firstLine(verdict.failedFiles)}`
      console.log(`  ${mutant.id}  killed — ${how}  ${where}`)
    } else {
      survivors.push(mutant)
      console.log(`  ${mutant.id}  SURVIVED  ${where}`)
    }
  }

  const real = spec.mutants.filter((m) => !m.control).length
  if (survivors.length > 0) {
    for (const mutant of survivors) {
      console.log(`\nSURVIVOR ${mutant.id} (${mutant.file}): ${mutant.why}`)
      for (const line of TRIAGE) console.log(`  ${line}`)
    }
    console.log(
      `\nROUND HAS SURVIVORS — ${survivors.length} of ${real} real mutants survived; the control survived. Tests run: ${baseline.ran.join(', ')}`
    )
    return EXIT.survivors
  }
  console.log(
    `ROUND OK — ${real} of ${real} real mutants killed; the control survived. Tests run: ${baseline.ran.join(', ')}`
  )
  return EXIT.ok
}

/** Contract: pure. The command line as options; throws `Invalid` on anything it does not know. */
function parseArgs(argv) {
  const options = { ...DEFAULTS, check: false, spec: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const number = (name) => {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 0) throw new Invalid(`${name} takes a whole number`)
      return value
    }
    if (arg === '--check') options.check = true
    else if (arg === '--retries') options.retries = number(arg)
    else if (arg === '--retry-wait') options.retryWaitSeconds = number(arg)
    else if (arg === '--timeout') options.timeoutSeconds = number(arg)
    else if (arg.startsWith('--')) throw new Invalid(`unknown option ${arg}`)
    else if (options.spec === null) options.spec = arg
    else throw new Invalid(`one spec per round; also given ${arg}`)
  }
  if (options.spec === null) {
    throw new Invalid(
      'usage: node scripts/mutate.cjs <spec.json> [--check] [--retries n] [--retry-wait s] [--timeout s]'
    )
  }
  return options
}

/**
 * What the command line runs. Returns the exit status, and never 1 for a
 * crash: 1 means survivors, so a harness fault must read as INVALID. `round`
 * is the round itself; a test passes one that crashes, since no input to the
 * real round is meant to.
 */
function main(argv, round = runRound) {
  try {
    const options = parseArgs(argv)
    return round(options.spec, options)
  } catch (err) {
    console.log(`ROUND INVALID — ${described(err)}`)
    return EXIT.invalid
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)))

module.exports = {
  EXIT,
  SCHEMA_VERSION,
  Invalid,
  classify,
  filesOf,
  main,
  mutate,
  occurrences,
  parseArgs,
  specProblems
}
