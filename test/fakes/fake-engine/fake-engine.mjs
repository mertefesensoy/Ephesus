#!/usr/bin/env node
// @ts-check
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { buildEnvelope, postHookEvent } from '../../../shims/hook-client.mjs'

/**
 * The fake engine (TEST-STRATEGY §1.2) — a *real* CLI, not a mock. It spawns in
 * a PTY like any engine, emits hook events, reads its inbox, writes its outbox,
 * answers what the Architect types, and exits on cue. Every deterministic test
 * from M1 onward is a script for this program, which is why it is built before
 * the real adapter's tests and maintained forever (IMPLEMENTATION dependency
 * order).
 *
 * Dependency-free ESM under system `node`: after `electron-rebuild` the repo's
 * native modules are Electron-ABI and cannot load under the Node test runner
 * (DECISIONS-LOG), so this program imports nothing but `node:` builtins and the
 * shared hook client.
 *
 * Usage:
 *   node fake-engine.mjs --script <path>        (or EPH_FAKE_SCRIPT=<path>)
 *
 * Environment (the harness sets the first three in its spawn plan, SDD §3):
 *   EPH_AGENT_ID       agent id put in every hook envelope
 *   EPH_HOOK_TOKEN     per-spawn hook token
 *   EPH_HOOK_ENDPOINT  UDS path or Windows pipe name
 *   EPH_AGENT_DIR      agora/agents/<id>/ — root for inbox/ and outbox/
 *   EPH_FAKE_SESSION   session id echoed in envelopes (default: null)
 *
 * Script file (JSON, versioned — a drifted script is refused, never guessed at):
 *   {
 *     "schemaVersion": 1,
 *     "steps":       [ <step>, ... ],   // run once at startup, in order
 *     "onPrompt":    [ <step>, ... ],   // run when the Architect types a line
 *     "onInterrupt": [ <step>, ... ]    // run when the interrupt key arrives
 *   }
 *
 * Steps:
 *   { "kind": "stdout",       "text": "..." }          verbatim bytes to stdout
 *   { "kind": "hook",         "event": "pre-tool", "payload": {...} }
 *   { "kind": "wait",         "ms": 25 }
 *   { "kind": "read-inbox",   "consume": false }       echo inbox message ids
 *   { "kind": "write-outbox", "message": {...} }       atomic temp+rename write
 *   { "kind": "echo-env",     "name": "EPH_IDENTITY" }  prints an env var
 *   { "kind": "exit",         "code": 0 }
 *
 * Machine-readable lines are prefixed `[fake-engine]`; `stdout` steps are
 * verbatim so a test can assert exact scripted output.
 */

const SCRIPT_SCHEMA_VERSION = 1
const MARKER = '[fake-engine]'
/** The interrupt key every engine in the roster uses (ADR-0009 `interrupt()`). */
const ESCAPE = String.fromCharCode(0x1b)

const STEP_KINDS = [
  'stdout',
  'hook',
  'wait',
  'read-inbox',
  'write-outbox',
  'write-transcript',
  'echo-env',
  'exit'
]

/**
 * @typedef {{ kind: string, text?: unknown, event?: unknown, payload?: unknown,
 *             ms?: unknown, consume?: unknown, message?: unknown, name?: unknown,
 *             code?: unknown, model?: unknown, inTokens?: unknown,
 *             outTokens?: unknown, costUsd?: unknown, at?: unknown }} Step
 * @typedef {{ steps: Step[], onPrompt: Step[], onInterrupt: Step[] }} Script
 */

/** Prints a machine-readable marker line. */
function say(/** @type {string} */ line) {
  process.stdout.write(`${MARKER} ${line}\n`)
}

/** Fails loud: a broken script is a broken test, not something to work around. */
function die(/** @type {string} */ reason) {
  process.stderr.write(`${MARKER} fatal: ${reason}\n`)
  process.exit(2)
}

function scriptPath() {
  const flag = process.argv.indexOf('--script')
  const fromFlag = flag >= 0 ? process.argv[flag + 1] : undefined
  const resolved = fromFlag ?? process.env['EPH_FAKE_SCRIPT']
  if (!resolved) die('no script: pass --script <path> or set EPH_FAKE_SCRIPT')
  return /** @type {string} */ (resolved)
}

/**
 * Validates the script by hand — this program has no validator dependency, and
 * the harness's zod validators live on the other side of the ABI wall.
 * @param {unknown} raw
 * @returns {Script}
 */
function parseScript(raw) {
  if (typeof raw !== 'object' || raw === null) die('script is not an object')
  const obj = /** @type {Record<string, unknown>} */ (raw)
  if (obj['schemaVersion'] !== SCRIPT_SCHEMA_VERSION) {
    die(
      `script schemaVersion must be ${SCRIPT_SCHEMA_VERSION}, got ${String(obj['schemaVersion'])}`
    )
  }
  /** @param {string} key @returns {Step[]} */
  const steps = (key) => {
    const value = obj[key]
    if (value === undefined) return []
    if (!Array.isArray(value)) die(`script.${key} must be an array`)
    const list = /** @type {unknown[]} */ (value)
    return list.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null) die(`script.${key}[${i}] is not an object`)
      const step = /** @type {Step} */ (entry)
      if (typeof step.kind !== 'string' || !STEP_KINDS.includes(step.kind)) {
        die(`script.${key}[${i}].kind must be one of ${STEP_KINDS.join('|')}`)
      }
      return step
    })
  }
  return { steps: steps('steps'), onPrompt: steps('onPrompt'), onInterrupt: steps('onInterrupt') }
}

/** Atomic write (temp + rename): the router reads the outbox live (ADR-0003). */
function writeFileAtomic(/** @type {string} */ filePath, /** @type {string} */ data) {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`
  )
  fs.writeFileSync(tmp, data, 'utf8')
  try {
    fs.renameSync(tmp, filePath)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

const agentId = process.env['EPH_AGENT_ID'] ?? 'agent.fake'
const hookToken = process.env['EPH_HOOK_TOKEN'] ?? ''
const hookEndpoint = process.env['EPH_HOOK_ENDPOINT'] ?? ''
const agentDir = process.env['EPH_AGENT_DIR'] ?? ''
const sessionId = process.env['EPH_FAKE_SESSION'] ?? null

/** @param {Step} step */
async function runStep(step) {
  switch (step.kind) {
    case 'stdout': {
      process.stdout.write(String(step.text ?? ''))
      return
    }

    case 'wait': {
      const ms = typeof step.ms === 'number' ? step.ms : 0
      await new Promise((resolve) => setTimeout(resolve, ms))
      return
    }

    case 'hook': {
      const event = String(step.event ?? '')
      if (!hookEndpoint) {
        // Fail-open, loudly: no endpoint is a test-rig mistake, not agent trouble.
        say(`hook-skipped ${event} (no EPH_HOOK_ENDPOINT)`)
        return
      }
      const envelope = buildEnvelope({
        agentId,
        token: hookToken,
        event,
        sessionId,
        payload: step.payload ?? {},
        ts: Date.now()
      })
      const delivery = await postHookEvent(hookEndpoint, envelope)
      say(
        delivery.delivered
          ? `hook-sent ${event}`
          : `hook-failed ${event} ${delivery.error ?? 'unknown'}`
      )
      return
    }

    case 'read-inbox': {
      if (!agentDir) {
        say('inbox-skipped (no EPH_AGENT_DIR)')
        return
      }
      const inbox = path.join(agentDir, 'inbox')
      const names = fs.existsSync(inbox)
        ? fs
            .readdirSync(inbox)
            .filter((name) => name.endsWith('.json'))
            .sort()
        : []
      say(`inbox-count ${names.length}`)
      for (const name of names) {
        say(`inbox-message ${name}`)
        if (step.consume === true) {
          const done = path.join(inbox, '.done')
          fs.mkdirSync(done, { recursive: true })
          fs.renameSync(path.join(inbox, name), path.join(done, name))
        }
      }
      return
    }

    case 'write-outbox': {
      if (!agentDir) {
        say('outbox-skipped (no EPH_AGENT_DIR)')
        return
      }
      const outbox = path.join(agentDir, 'outbox')
      fs.mkdirSync(outbox, { recursive: true })
      const message = /** @type {Record<string, unknown>} */ (step.message ?? {})
      const id = typeof message['id'] === 'string' ? message['id'] : randomBytes(8).toString('hex')
      const file = path.join(outbox, `${id}.json`)
      writeFileAtomic(file, `${JSON.stringify(message, null, 2)}\n`)
      say(`outbox-wrote ${id}.json`)
      return
    }

    case 'write-transcript': {
      // A real engine records what a turn cost, in its own format, in its own
      // place. The fake's format is one JSON usage fact per line under
      // `.fake-engine/transcripts/<sessionId>.jsonl` — which is exactly what
      // `makeFakeAdapter`'s TranscriptReader reads, so S-LEDGER folds a file an
      // engine actually wrote rather than one the test hand-placed.
      const dir = path.join(process.cwd(), '.fake-engine', 'transcripts')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${sessionId}.jsonl`)
      const fact = {
        sessionId,
        model: String(step.model ?? 'fake-1'),
        inTokens: Number(step.inTokens ?? 0),
        outTokens: Number(step.outTokens ?? 0),
        costUsd: step.costUsd === undefined ? null : Number(step.costUsd),
        at: typeof step.at === 'string' ? step.at : new Date().toISOString()
      }
      fs.appendFileSync(file, `${JSON.stringify(fact)}\n`)
      say(`transcript-wrote ${path.basename(file)} in=${fact.inTokens} out=${fact.outTokens}`)
      return
    }

    case 'echo-env': {
      // How the conformance suite observes identity injection *in session*: the
      // agent itself reports what the harness put in its environment.
      const name = String(step.name ?? '')
      const value = process.env[name]
      say(value === undefined ? `env-missing ${name}` : `env ${name}=${value}`)
      return
    }

    case 'exit': {
      const code = typeof step.code === 'number' ? step.code : 0
      say(`exit ${code}`)
      process.exit(code)
      return
    }

    default:
      die(`unreachable step kind ${step.kind}`)
  }
}

/** @param {Step[]} steps */
async function runSteps(steps) {
  for (const step of steps) await runStep(step)
}

async function main() {
  const file = scriptPath()
  if (!fs.existsSync(file)) die(`script not found: ${file}`)
  /** @type {unknown} */
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    die(`script is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const script = parseScript(raw)

  say(`ready ${agentId}`)

  // Serialize reactions behind the startup steps so a prompt arriving mid-script
  // cannot interleave its output with the scripted output.
  let queue = runSteps(script.steps).then(() => {
    say('idle')
  })

  // Line-oriented, like the CLIs this stands in for: Enter submits the pending
  // line, Escape cancels it and interrupts. Parsed character by character rather
  // than per chunk, because a PTY may hand over "prompt\n" and the interrupt key
  // in a single read — a per-chunk test would silently swallow one of them.
  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    for (const ch of String(chunk)) {
      if (ch === ESCAPE) {
        pending = ''
        queue = queue.then(async () => {
          say('interrupted')
          await runSteps(script.onInterrupt)
          say('idle')
        })
      } else if (ch === '\n' || ch === '\r') {
        const line = pending.trim()
        pending = ''
        if (line.length === 0) continue
        queue = queue.then(async () => {
          say(`prompt ${line}`)
          await runSteps(script.onPrompt)
          say('idle')
        })
      } else {
        pending += ch
      }
    }
  })
  process.stdin.on('end', () => {
    queue.then(() => process.exit(0))
  })

  await queue
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)))
