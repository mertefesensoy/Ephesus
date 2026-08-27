#!/usr/bin/env node
// @ts-check
import process from 'node:process'
import { postJson } from './hook-client.mjs'

/**
 * `eph-recall` — the agent-facing recall CLI (ADR-0006 layer 2: "exposed to
 * agents as a CLI").
 *
 * Usage, from inside an agent's own session:
 *   node eph-recall.mjs "<query>" [--scope <agentId|memory|archive|knowledge>]
 *                                 [--limit <1..25>] [--json]
 *
 * Environment, from the spawn plan (SDD §3): EPH_AGENT_ID · EPH_HOOK_TOKEN ·
 * EPH_HOOK_ENDPOINT. The harness answers on the same socket the hook shim posts
 * to — one 0600 socket, one per-spawn token (ENGINEERING-STANDARDS §5).
 *
 * Dependency-free ESM for the same reason `eph-hook` is: it runs under whatever
 * bare `node` the agent happens to have, with no build step and no
 * `node_modules` guarantee. `@ts-check` keeps it type-checked anyway.
 *
 * **This shim does NOT fail open, and that is deliberate.** A hook that cannot
 * be delivered costs the agent nothing, so `eph-hook` swallows it. A recall that
 * printed nothing when the harness was down would have the agent conclude the
 * company knows nothing and act on it — the silent fallback invariant §7 calls
 * the one unforgivable failure. Every failure here is printed and exits 1.
 */

/** Mirrors RECALL_SCHEMA_VERSION in src/shared/recall.ts. */
const RECALL_SCHEMA_VERSION = 1
/** Mirrors RECALL_ENDPOINT_PATH. */
const RECALL_ENDPOINT_PATH = '/recall'
const DEFAULT_LIMIT = 5

/**
 * @typedef {{ query: string, scope: string | null, limit: number, json: boolean }} Args
 */

/**
 * @param {readonly string[]} argv
 * @returns {Args}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const words = []
  let scope = null
  let limit = DEFAULT_LIMIT
  let json = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--scope') {
      scope = argv[i + 1] ?? null
      i += 1
    } else if (arg === '--limit') {
      const parsed = Number.parseInt(argv[i + 1] ?? '', 10)
      // An unreadable --limit takes the default rather than searching for zero:
      // a typo must not look like "nothing is known".
      limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 25) : DEFAULT_LIMIT
      i += 1
    } else if (arg === '--json') {
      json = true
    } else if (arg !== undefined && !arg.startsWith('--')) {
      words.push(arg)
    }
  }
  return { query: words.join(' ').trim(), scope, limit, json }
}

/**
 * Renders one answer for a reader who is an agent, not a terminal user.
 * @param {any} response
 * @returns {string}
 */
export function renderAnswer(response) {
  const lines = []
  const rung = String(response.rung ?? 'unknown')
  const hits = Array.isArray(response.hits) ? response.hits : []
  lines.push(`recall: ${hits.length} result(s) for "${String(response.query ?? '')}" [${rung}]`)
  // The rung and the reason it is not a higher one travel with every answer:
  // an agent that got the keyword answer must know it is not the semantic one.
  if (response.degraded) lines.push(`recall degraded: ${String(response.degraded)}`)
  if (hits.length === 0) {
    lines.push('(nothing matched — this is an answer, not a failure)')
  }
  for (const hit of hits) {
    lines.push('')
    lines.push(`--- ${String(hit.scope)} · ${String(hit.title)} (${String(hit.source)})`)
    lines.push(`    ${String(hit.ref)}`)
    lines.push(String(hit.snippet))
  }
  return lines.join('\n')
}

/**
 * @param {string} endpoint
 * @param {object} request
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: number | null, body: string, error: string | null }>}
 */
export function postRecall(endpoint, request, timeoutMs = 10_000) {
  return postJson(endpoint, RECALL_ENDPOINT_PATH, request, timeoutMs)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const agentId = process.env['EPH_AGENT_ID']
  const token = process.env['EPH_HOOK_TOKEN']
  const endpoint = process.env['EPH_HOOK_ENDPOINT']

  if (args.query.length === 0) {
    process.stderr.write('recall: nothing to search for — pass a query\n')
    process.exit(1)
  }
  if (!agentId || !token || !endpoint) {
    process.stderr.write(
      'recall unavailable: this process was not started by the harness ' +
        '(EPH_AGENT_ID / EPH_HOOK_TOKEN / EPH_HOOK_ENDPOINT missing)\n'
    )
    process.exit(1)
  }

  const answer = await postRecall(endpoint, {
    schemaVersion: RECALL_SCHEMA_VERSION,
    token,
    agentId,
    query: args.query,
    scope: args.scope,
    limit: args.limit
  })

  if (
    answer.error !== null ||
    answer.status === null ||
    answer.status < 200 ||
    answer.status >= 300
  ) {
    let reason = answer.error ?? `harness answered ${String(answer.status)}`
    try {
      const parsed = JSON.parse(answer.body)
      if (parsed && typeof parsed.reason === 'string') reason = parsed.reason
    } catch {
      // Keep the transport-level reason; a body we cannot read adds nothing.
    }
    process.stderr.write(`recall unavailable: ${reason}\n`)
    process.exit(1)
  }

  let response
  try {
    response = JSON.parse(answer.body)
  } catch {
    process.stderr.write('recall unavailable: the harness answer was not JSON\n')
    process.exit(1)
    return
  }

  process.stdout.write(
    `${args.json ? JSON.stringify(response, null, 2) : renderAnswer(response)}\n`
  )
}

// Only run when invoked as a program; the test imports the helpers above.
if (process.argv[1] && process.argv[1].endsWith('eph-recall.mjs')) {
  main().catch((err) => {
    process.stderr.write(
      `recall unavailable: ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
  })
}
