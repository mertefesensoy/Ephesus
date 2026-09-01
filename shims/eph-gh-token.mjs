#!/usr/bin/env node
// @ts-check
import process from 'node:process'
import { postJson } from './hook-client.mjs'

/**
 * `eph-gh-token` — a running agent's way to get a fresh GitHub credential
 * (ADR-0022).
 *
 * Usage, from inside an agent's own session:
 *   node eph-gh-token.mjs            # prints the token, nothing else
 *   node eph-gh-token.mjs --json     # {"ok":true,"token":"…","expiresAt":"…"}
 *
 * Why it exists: a GitHub App installation token lives one hour. `GH_TOKEN` in
 * the environment is the token this process was *spawned* with, so an agent
 * still working after an hour pushes with a dead credential and gets a 401 that
 * reads like a permissions mistake. The harness refreshes its own copy at fifty
 * minutes; this asks for that one.
 *
 * Environment, from the spawn plan (SDD §3): EPH_AGENT_ID · EPH_HOOK_TOKEN ·
 * EPH_HOOK_ENDPOINT — the same 0600 socket and per-spawn token `eph-recall`
 * uses. A second channel for a second purpose would be a second thing to
 * secure.
 *
 * Dependency-free ESM, like the other two shims: it runs under whatever bare
 * `node` the agent has, with no build step and no `node_modules` guarantee.
 *
 * **Does not fail open.** A hook that cannot be delivered costs an agent
 * nothing, so `eph-hook` swallows it. A credential that silently printed
 * nothing would have the agent push with the stale one and misread the result,
 * so every failure here is printed to stderr and exits 1 — and a refusal is
 * printed as the reason the harness gave, never as an empty token.
 */

/** Mirrors GH_TOKEN_SCHEMA_VERSION in src/shared/gh-token.ts. */
const GH_TOKEN_SCHEMA_VERSION = 1
/** Mirrors GH_TOKEN_ENDPOINT_PATH. */
const GH_TOKEN_ENDPOINT_PATH = '/gh-token'

/**
 * @param {string} endpoint
 * @param {object} request
 * @param {number} [timeoutMs]
 */
export function postGhToken(endpoint, request, timeoutMs = 10_000) {
  return postJson(endpoint, GH_TOKEN_ENDPOINT_PATH, request, timeoutMs)
}

async function main() {
  const json = process.argv.slice(2).includes('--json')
  const agentId = process.env['EPH_AGENT_ID']
  const token = process.env['EPH_HOOK_TOKEN']
  const endpoint = process.env['EPH_HOOK_ENDPOINT']

  if (!agentId || !token || !endpoint) {
    process.stderr.write(
      'gh-token unavailable: this process was not started by the harness ' +
        '(EPH_AGENT_ID / EPH_HOOK_TOKEN / EPH_HOOK_ENDPOINT missing)\n'
    )
    process.exit(1)
  }

  const answer = await postGhToken(endpoint, {
    schemaVersion: GH_TOKEN_SCHEMA_VERSION,
    token,
    agentId
  })

  if (answer.error !== null || answer.status === null) {
    process.stderr.write(`gh-token unavailable: ${answer.error ?? 'no answer from the harness'}\n`)
    process.exit(1)
  }

  let parsed
  try {
    parsed = JSON.parse(answer.body)
  } catch {
    process.stderr.write(`gh-token: unreadable answer (HTTP ${String(answer.status)})\n`)
    process.exit(1)
    return
  }

  if (parsed.ok !== true || typeof parsed.token !== 'string') {
    // The harness's own words: "your role does not declare GH_TOKEN" is
    // something an agent can stop doing, where "forbidden" is not.
    const because = typeof parsed.because === 'string' ? parsed.because : parsed.reason
    process.stderr.write(`gh-token refused: ${String(because ?? 'no reason given')}\n`)
    process.exit(1)
    return
  }

  // The token on stdout ALONE, so `$(node eph-gh-token.mjs)` is a credential
  // and not a credential with a sentence attached to it.
  process.stdout.write(json ? `${JSON.stringify(parsed)}\n` : `${parsed.token}\n`)
}

// Only run when invoked directly, so the pure parts stay importable by tests.
if (process.argv[1] && process.argv[1].endsWith('eph-gh-token.mjs')) {
  void main()
}
