#!/usr/bin/env node
/**
 * `ephctl` — the Ephesus control surface's client (M8.14).
 *
 * Usage:
 *   node scripts/ephctl.cjs <verb> [--flag value ...] [--json]
 *   node scripts/ephctl.cjs help
 *
 * Environment: `EPH_HOME` selects the harness home, exactly as it does for the
 * app itself. Unset means `~/.ephesus`.
 *
 * ## Why this file holds no policy
 *
 * It has no verb table, no validators and no prose. Every one of those lives in
 * `src/shared/control.ts`, where a unit test can assert over them exhaustively —
 * above all over the four verbs that are deliberately refused, whose set is the
 * whole point of the surface. A client that knew which verbs existed would be a
 * second copy of that policy, and the first thing to drift from it.
 *
 * So this program does exactly four things: resolve the home, read the address
 * the running harness advertised, POST one verb, and print what came back. It
 * exits 0 when the harness said `ok`, and non-zero otherwise — including for a
 * refusal, so a script that tries to approve a gate FAILS rather than continuing
 * on a message nobody read.
 *
 * ## Why plain CommonJS in `scripts/`
 *
 * The exit run (`docs/EXIT-M8.md`) starts from a clean clone and `npm install`.
 * This has to work in the terminal beside `npm run dev` with no build step, no
 * bundler and no `node_modules` guarantee beyond what is already there — the
 * same constraint the engine shims are written under. It lives in `scripts/`
 * rather than `shims/` because `shims/` is what the harness hands an AGENT
 * process through its spawn plan; this is what a person runs at the repo root.
 */
const { Buffer } = require('node:buffer')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

/** Mirrors CONTROL_SCHEMA_VERSION in src/shared/control.ts. */
const CONTROL_SCHEMA_VERSION = 1
/** Mirrors CONTROL_ADDRESS_FILE. The harness writes it; we only read it. */
const CONTROL_ADDRESS_FILE = 'control-endpoint.json'
/** How long to wait for the harness to answer before giving up, in ms. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Contract: the harness home this invocation talks to.
 *
 * Pinned against `harnessHomeRoot()` in `src/main/config.ts` by
 * `test/scripts/ephctl.test.ts` — the two must agree, and the test is what makes
 * that true rather than the comment.
 */
function resolveHome(env) {
  const override = env['EPH_HOME']
  return override === undefined || override === '' ? path.join(os.homedir(), '.ephesus') : override
}

/**
 * Contract: pure. Turns `verb --flag value --flag other --json` into a request.
 *
 * A repeated flag becomes an array, because that is how `--repo a --repo b`
 * reads to anyone typing it; a bare `--flag` at the end is an error rather than
 * a silent `true`, since every flag this surface takes carries a value.
 * Everything stays a STRING: the coercion belongs in the verb's own schema on
 * the harness side, not here.
 */
function parseArgs(argv) {
  // The verb is argv[0], not "the first word that is not a flag": a flag's
  // VALUE is also not a flag, so `--limit 7 log:tail` would otherwise be read
  // as the verb `7` and answered with a puzzle rather than a usage line.
  const verb = argv[0]
  if (verb === undefined || verb.startsWith('--')) return { ok: false, reason: 'no verb given' }

  const args = {}
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const name = arg.slice(2)
    if (name === 'json') {
      json = true
      continue
    }
    if (name === '') return { ok: false, reason: 'a bare "--" is not a flag' }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--'))
      return { ok: false, reason: `--${name} needs a value` }
    const held = args[name]
    if (held === undefined) args[name] = value
    else if (Array.isArray(held)) held.push(value)
    else args[name] = [held, value]
    i += 1
  }
  return { ok: true, verb, args, json }
}

/**
 * Contract: reads the address a running harness advertised.
 *
 * Returns `{ ok: false, reason }` with a sentence somebody can act on. This is
 * the most common failure of all — no app is running — and "ECONNREFUSED" is
 * not an answer to it.
 */
function readAddress(home) {
  const file = path.join(home, CONTROL_ADDRESS_FILE)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT')
      return {
        ok: false,
        reason:
          `no Ephesus harness is running against ${home} — there is no ${CONTROL_ADDRESS_FILE} ` +
          `in that home.\n\nStart it with \`npm run dev\` (set EPH_HOME first if you meant a ` +
          `different home), wait for the window, and try again.`
      }
    return { ok: false, reason: `could not read ${file}: ${describe(err)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: `${file} is not valid JSON — delete it and restart the harness` }
  }
  if (!parsed || typeof parsed.endpoint !== 'string' || typeof parsed.path !== 'string')
    return { ok: false, reason: `${file} does not name an endpoint — restart the harness` }
  return { ok: true, address: parsed, file }
}

/** Contract: POSTs one request. Never throws; every failure comes back as a reason. */
function post(address, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        socketPath: address.endpoint,
        path: address.path,
        method: 'POST',
        timeout: REQUEST_TIMEOUT_MS,
        // Byte length, not string length: an agenda with an accent in it would
        // otherwise declare fewer bytes than it sends and hang the request.
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => {
          resolve({ ok: true, status: res.statusCode ?? 0, body: text })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error(`the harness did not answer within ${REQUEST_TIMEOUT_MS}ms`))
    })
    req.on('error', (err) => {
      resolve({ ok: false, reason: describe(err) })
    })
    req.end(payload)
  })
}

function describe(err) {
  if (!err) return 'unknown error'
  return typeof err.message === 'string' ? err.message.split('\n')[0] : String(err)
}

/**
 * Contract: runs one invocation and returns the process exit code.
 *
 * Separated from the module's own entry so a test can drive it with a captured
 * `out`/`err` instead of the real streams — the seam that makes every branch
 * below reachable without spawning a process for each one.
 */
async function run(argv, env, out, err) {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    err(`ephctl: ${parsed.reason}\n\nUsage: node scripts/ephctl.cjs <verb> [--flag value ...]`)
    return 2
  }

  const home = resolveHome(env)
  const found = readAddress(home)
  if (!found.ok) {
    err(`ephctl: ${found.reason}`)
    return 3
  }

  const sent = await post(found.address, {
    schemaVersion: CONTROL_SCHEMA_VERSION,
    verb: parsed.verb,
    args: parsed.args
  })
  if (!sent.ok) {
    err(
      `ephctl: ${found.file} points at ${found.address.endpoint}, but nothing is listening ` +
        `there (${sent.reason}).\n\nThe harness may have stopped without tidying up. Start it ` +
        `with \`npm run dev\` and try again.`
    )
    return 3
  }

  let answer
  try {
    answer = JSON.parse(sent.body)
  } catch {
    err(`ephctl: the harness answered ${sent.status} with something that is not JSON`)
    return 4
  }

  // The harness renders; this prints. There is deliberately nothing here that
  // knows what any verb means.
  out(parsed.json ? JSON.stringify(answer.data ?? null, null, 2) : String(answer.text ?? ''))
  return answer.ok === true ? 0 : 1
}

module.exports = { parseArgs, resolveHome, readAddress, run, CONTROL_ADDRESS_FILE }

if (require.main === module) {
  run(
    process.argv.slice(2),
    process.env,
    (line) => {
      process.stdout.write(`${line}\n`)
    },
    (line) => {
      process.stderr.write(`${line}\n`)
    }
  ).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`ephctl: ${describe(error)}\n`)
      process.exitCode = 4
    }
  )
}
