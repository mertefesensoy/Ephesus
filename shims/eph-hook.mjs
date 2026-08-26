#!/usr/bin/env node
// @ts-check
import process from 'node:process'
import { buildEnvelope, postHookEvent } from './hook-client.mjs'

/**
 * `eph-hook` — the hook shim engines run (SDD §1, FR-2.1). One engine hook
 * invocation in, one normalized envelope out.
 *
 * The shim is deliberately **engine-agnostic**: it knows how to read a JSON
 * payload on stdin, rename a few fields, and post. Everything engine-specific —
 * which hook maps to which harness event, which payload key holds the tool name,
 * which key holds the session id — arrives as arguments written by the engine's
 * adapter when it installs the settings file. That is what keeps Claude-isms out
 * of core (NFR-12, ADR-0009) without needing a shim per engine.
 *
 * Usage (as written into an engine's settings by its adapter):
 *   node eph-hook.mjs --event <harness-event>
 *                     [--field <harnessKey>=<engineKey>]...
 *                     [--session-field <engineKey>]
 *
 * Environment, from the spawn plan (SDD §3):
 *   EPH_AGENT_ID · EPH_HOOK_TOKEN · EPH_HOOK_ENDPOINT
 *
 * **Fail-open, always** (SDD §10): the harness being down, misconfigured, or
 * slow must never cost the agent its turn. Every path here exits 0, and nothing
 * is written to stdout — an engine treats hook stdout as instructions, so the
 * shim stays silent and reports trouble on stderr only.
 */

/** @typedef {{ event: string, fields: Array<[string, string]>, sessionField: string | null }} ShimArgs */

/**
 * @param {readonly string[]} argv
 * @returns {ShimArgs}
 */
export function parseArgs(argv) {
  let event = ''
  let sessionField = null
  /** @type {Array<[string, string]>} */
  const fields = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--event') {
      event = argv[i + 1] ?? ''
      i += 1
    } else if (arg === '--field') {
      const pair = argv[i + 1] ?? ''
      const split = pair.indexOf('=')
      if (split > 0) fields.push([pair.slice(0, split), pair.slice(split + 1)])
      i += 1
    } else if (arg === '--session-field') {
      sessionField = argv[i + 1] ?? null
      i += 1
    }
  }
  return { event, fields, sessionField }
}

/**
 * Renames engine payload keys onto the harness's names, keeping everything the
 * engine sent. Nothing is dropped: the harness's payload schemas are loose, and
 * an unmapped field may be exactly what a later milestone needs.
 *
 * @param {unknown} raw
 * @param {ShimArgs} args
 * @returns {Record<string, unknown>}
 */
export function normalizePayload(raw, args) {
  /** @type {Record<string, unknown>} */
  const payload =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { .../** @type {Record<string, unknown>} */ (raw) }
      : {}
  for (const [harnessKey, engineKey] of args.fields) {
    if (engineKey in payload && !(harnessKey in payload)) payload[harnessKey] = payload[engineKey]
  }
  return payload
}

/**
 * @param {unknown} raw
 * @param {ShimArgs} args
 * @returns {string | null}
 */
export function sessionIdOf(raw, args) {
  if (!args.sessionField) return null
  if (typeof raw !== 'object' || raw === null) return null
  const value = /** @type {Record<string, unknown>} */ (raw)[args.sessionField]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Reads all of stdin. Resolves to '' when nothing is piped in. */
function readStdin() {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = []
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    // A hook invoked with no stdin must not hang the engine's turn.
    const guard = setTimeout(finish, 2000)
    guard.unref?.()
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    process.stdin.on('end', () => {
      clearTimeout(guard)
      finish()
    })
    process.stdin.on('error', () => {
      clearTimeout(guard)
      finish()
    })
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const endpoint = process.env['EPH_HOOK_ENDPOINT'] ?? ''
  const agentId = process.env['EPH_AGENT_ID'] ?? ''
  const token = process.env['EPH_HOOK_TOKEN'] ?? ''

  if (!args.event || !endpoint || !agentId || !token) {
    // Misconfiguration is the harness's fault, not the agent's: say so on
    // stderr and let the turn continue.
    process.stderr.write('eph-hook: not wired (missing --event or EPH_* environment)\n')
    return
  }

  const body = await readStdin()
  /** @type {unknown} */
  let raw = {}
  if (body.trim().length > 0) {
    try {
      raw = JSON.parse(body)
    } catch {
      process.stderr.write('eph-hook: engine payload was not JSON; posting event without it\n')
    }
  }

  const delivery = await postHookEvent(
    endpoint,
    buildEnvelope({
      agentId,
      token,
      event: args.event,
      sessionId: sessionIdOf(raw, args),
      payload: normalizePayload(raw, args),
      ts: Date.now()
    })
  )
  if (!delivery.delivered) {
    process.stderr.write(`eph-hook: ${args.event} not delivered (${delivery.error ?? 'unknown'})\n`)
  }
}

// Only run when executed as a program; importing it for tests must not post.
if (process.argv[1] && process.argv[1].endsWith('eph-hook.mjs')) {
  main().catch((err) => {
    process.stderr.write(`eph-hook: ${err instanceof Error ? err.message : String(err)}\n`)
  })
}
