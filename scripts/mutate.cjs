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
 * 3. A run that wrote no report, ran no tests, or did not run every listed
 *    file is INVALID, never a kill. That is read from vitest's JSON report,
 *    not from the exit code or the console: the suite's free-memory gate
 *    refuses to start and exits 1 (`test/global-setup.ts`), and a harness
 *    scoring by exit code reported those refusals as clean sweeps
 *    (2026-09-09, 2026-10-02). A refused run is retried after a wait.
 * 4. Every file in the round — the mutated files, the test files and the spec
 *    — is hashed when the round starts, after every run and after every
 *    restore, and every mutant is built from the bytes the round started with.
 *    OneDrive put a restored file back with a mutant in it, twice, seconds
 *    after its check had passed (2026-09-09, 2026-10-02).
 * 5. Files are read and written as bytes, so a restore is exact and a CRLF
 *    never appears in an LF file.
 * 6. The round's files must be committed and clean: `git checkout --` is the
 *    restore and `git status` is a second check. That is why this file is in
 *    `GIT_ALLOWLIST` (`scripts/check-invariants.cjs`) and `GIT_DOORS`
 *    (`test/temp-hygiene.test.ts`): it runs git on the development repository
 *    and never on a harness home (DECISIONS-LOG 2026-10-03).
 * 7. Every run prints the test files it actually ran. A score is scoped to
 *    them, and M8b.3's 6 of 6 kills were followed by two scenario failures the
 *    round never loaded.
 * 8. Every anchor matches its file exactly once, checked before the baseline:
 *    an anchor matching nothing makes a mutant a no-op that "survives", and one
 *    matching twice is an edit nobody chose.
 * 9. A survivor exits 1 and prints the triage question, so it stops the round
 *    instead of decorating a table.
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
    }
    if (typeof mutant.replace !== 'string') problems.push(`${at}.replace must be a string`)
    else if (mutant.replace === mutant.find) {
      problems.push(`${at}.replace equals its find, so applying it changes nothing`)
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

/** Contract: pure. A spec path is relative, forward-slashed and stays inside the repository. */
function pathProblems(value, at) {
  if (typeof value !== 'string' || value === '') return [`${at} must be a non-empty path`]
  if (value.includes('\\')) return [`${at} "${value}" must use forward slashes`]
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    return [`${at} "${value}" must be relative to the repository root`]
  }
  if (value.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    return [`${at} "${value}" must name a file inside the repository, without "." or ".." steps`]
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
 * Contract: pure. What one vitest run means for the round, from its JSON
 * report alone. `report` is the parsed report, or null when none was written;
 * `listed` are the spec's test files and `ran` the report's files, both as
 * repository paths. `kind` is `pass`, `fail` or `invalid`; a failure is a
 * `test` failure (an assertion) or a `file` failure (the file could not load,
 * or a hook threw), and the second is still a kill, named so it is triaged.
 */
function classify(report, listed, ran) {
  // Measured on vitest 4.1.11: a global setup that THROWS — the suite's
  // free-memory gate does — writes a report holding no file at all, and one
  // that exits writes none. Either way nothing ran, and waiting may fix it.
  if (report === null || ran.length === 0) {
    return {
      kind: 'invalid',
      retry: true,
      reason:
        'no test file ran: the suite refused to start (the free-memory gate), its setup failed, or it was killed'
    }
  }
  const missing = listed.filter((file) => !ran.includes(file))
  if (missing.length > 0) {
    return {
      kind: 'invalid',
      retry: false,
      reason: `listed test files did not run: ${missing.join(', ')}`
    }
  }
  const failedFiles = (report.testResults ?? []).filter((file) => file.status === 'failed')
  if ((report.numFailedTests ?? 0) > 0) return { kind: 'fail', how: 'test', failedFiles }
  if (failedFiles.length > 0) return { kind: 'fail', how: 'file', failedFiles }
  if ((report.numTotalTests ?? 0) === 0) {
    return { kind: 'invalid', retry: false, reason: 'the listed test files hold no test that ran' }
  }
  if (report.success !== true) {
    return {
      kind: 'invalid',
      retry: false,
      reason: 'vitest reported failure without a failing test or file'
    }
  }
  return { kind: 'pass' }
}

/** The vitest this repository runs: the round's own first, then this tool's. */
function vitestBin(root) {
  const manifest = require.resolve('vitest/package.json', { paths: [root, __dirname] })
  return path.join(path.dirname(manifest), 'vitest.mjs')
}

/** One vitest run over the listed files, read back as a report. Blocks until it ends. */
function runSuite(root, tests, options) {
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
    const ran = (report?.testResults ?? [])
      .map((file) => path.relative(root, file.name).split(path.sep).join('/'))
      .sort()
    const log = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim().split('\n').slice(-6)
    return { verdict: classify(report, tests, ran), report, ran, log }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/** A run, retried while its result is a refusal to start rather than an answer. */
function runAnswered(root, tests, options, label) {
  for (let attempt = 0; ; attempt++) {
    const run = runSuite(root, tests, options)
    const { verdict } = run
    if (verdict.kind !== 'invalid' || !verdict.retry || attempt >= options.retries) return run
    console.log(
      `  ${label}: ${verdict.reason} — waiting ${options.retryWaitSeconds}s, then retrying (${attempt + 1} of ${options.retries})`
    )
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.retryWaitSeconds * 1000)
  }
}

const counted = (run) =>
  `${run.ran.length} file${run.ran.length === 1 ? '' : 's'}, ${run.report?.numTotalTests ?? 0} tests`

const firstLine = (failedFiles) =>
  failedFiles.map((file) => (file.message ?? '').split('\n')[0]).find(Boolean) ?? 'no message'

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

  for (const file of files) {
    const stat = fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })
    if (stat === undefined || !stat.isFile()) {
      throw new Invalid(`${file} is not a file in ${root} (a link is refused too)`)
    }
  }
  // Requirement 6: `git checkout --` can only restore what git holds. Both
  // questions are asked because each is blind where the other sees: `status`
  // never shows a file `.gitignore` hides, and `ls-files` never shows an edit.
  const tracked = git(root, ['ls-files', '-z', '--', ...files])
    .split('\0')
    .filter(Boolean)
  const untracked = files.filter((file) => !tracked.includes(file))
  const dirty = git(root, ['status', '--porcelain', '--', ...files]).trim()
  if (untracked.length > 0 || dirty !== '') {
    throw new Invalid(
      `commit the round's files first, so git can restore them and check the restore:\n  ${[...untracked.map((file) => `not tracked by git: ${file}`), ...dirty.split('\n').filter(Boolean)].join('\n  ')}`
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
  const baseline = runAnswered(root, spec.tests, options, 'baseline')
  if (baseline.verdict.kind !== 'pass') {
    const why =
      baseline.verdict.kind === 'fail'
        ? 'the suite is red before any mutant is applied, so every mutant would look killed'
        : baseline.verdict.reason
    throw new Invalid(`baseline: ${why}\n  ${baseline.log.join('\n  ')}`)
  }
  const changed = drift(root, clean)
  if (changed.length > 0) throw new Invalid(`the baseline run changed ${changed.join(', ')}`)
  console.log(`baseline: PASS — ${counted(baseline)}: ${baseline.ran.join(', ')}`)

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
      run = runAnswered(root, spec.tests, options, mutant.id)
      const during = drift(root, clean).filter((file) => file !== mutant.file)
      if (sha256(fs.readFileSync(target)) !== sha256(mutated)) during.unshift(mutant.file)
      if (during.length > 0) {
        throw new Invalid(
          `${mutant.id}: ${during.join(', ')} changed while the suite ran — a sync client or the suite wrote it, so the verdict cannot be trusted`
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
    if (run.ran.join() !== baseline.ran.join()) {
      console.log(`    ran a different file set from the baseline: ${run.ran.join(', ')}`)
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
  main,
  mutate,
  occurrences,
  parseArgs,
  specProblems
}
