// @ts-check
import http from 'node:http'

/**
 * The one hook client (M1.2). Every out-of-process thing that reports lifecycle
 * events to the harness — the `eph-hook` shim and the fake engine — posts
 * through this module, so the Unix-domain-socket path and the Windows
 * named-pipe path can never drift apart: Node's HTTP client accepts both
 * through the same `socketPath` option, and that is the whole platform
 * difference.
 *
 * Written as dependency-free ESM (not TypeScript) because it runs under
 * whatever bare `node` the engine hands its hook command, with no build step
 * and no `node_modules` guarantee. `@ts-check` keeps it type-checked anyway.
 *
 * **Fail-open** (SDD §10): if the harness is down, an agent must keep working.
 * Nothing here throws or rejects — callers get a delivery report and continue.
 */

/** Wire-format version; mirrors HOOK_ENVELOPE_SCHEMA_VERSION in src/shared/hooks.ts. */
export const HOOK_ENVELOPE_SCHEMA_VERSION = 1

/** The HTTP path the harness listens on; mirrors HOOK_ENDPOINT_PATH. */
export const HOOK_ENDPOINT_PATH = '/hook'

/**
 * @typedef {object} HookEnvelope
 * @property {number} schemaVersion
 * @property {string} token
 * @property {string} agentId
 * @property {string} event
 * @property {string | null} sessionId
 * @property {number} ts
 * @property {unknown} payload
 */

/**
 * @typedef {object} HookDelivery
 * @property {boolean} delivered   True only for a 2xx answer from the harness.
 * @property {number | null} status HTTP status, or null when nothing answered.
 * @property {string | null} error  One-line reason when `delivered` is false.
 * @property {string | null} body   The harness's answer, for hooks that act on it.
 */

/**
 * Builds an envelope from the ambient spawn environment. The harness sets
 * `EPH_AGENT_ID` and `EPH_HOOK_TOKEN` in the spawn plan (ADR-0009, SDD §3).
 *
 * @param {object} args
 * @param {string} args.agentId
 * @param {string} args.token
 * @param {string} args.event      Harness-normalized name, e.g. `pre-tool`.
 * @param {string | null} [args.sessionId]
 * @param {unknown} [args.payload]
 * @param {number} args.ts         Epoch ms; passed in so callers stay testable.
 * @returns {HookEnvelope}
 */
export function buildEnvelope({ agentId, token, event, sessionId = null, payload = {}, ts }) {
  return {
    schemaVersion: HOOK_ENVELOPE_SCHEMA_VERSION,
    token,
    agentId,
    event,
    sessionId,
    ts,
    payload
  }
}

/**
 * Contract: JSON or null. A circular payload is a shim bug, and the fail-open
 * rule says it must cost the agent a dropped event, not a crash.
 * @param {HookEnvelope} envelope
 * @returns {string | null}
 */
function serialize(envelope) {
  try {
    return JSON.stringify(envelope)
  } catch {
    return null
  }
}

/**
 * Posts one envelope to the harness endpoint.
 *
 * Contract: resolves — always. A refused connection, a missing socket, a
 * timeout, or a non-2xx answer all resolve with `delivered: false` and a reason.
 * The token travels in the body, never in a URL or a log line.
 *
 * @param {string} endpoint  UDS path, or `\\.\pipe\...` on Windows.
 * @param {HookEnvelope} envelope
 * @param {number} [timeoutMs]
 * @returns {Promise<HookDelivery>}
 */
export function postHookEvent(endpoint, envelope, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false
    /** @type {(result: HookDelivery) => void} */
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const body = serialize(envelope)
    if (body === null) {
      finish({ delivered: false, status: null, error: 'envelope is not serializable', body: null })
      return
    }

    const request = http.request(
      {
        socketPath: endpoint,
        path: HOOK_ENDPOINT_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body)
        }
      },
      (response) => {
        // The body carries the autonomy loop's decision (ADR-0013), so it is
        // collected rather than discarded — but always drained, or the socket
        // stays open and the agent's exit stalls.
        const status = response.statusCode ?? 0
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          const ok = status >= 200 && status < 300
          finish({
            delivered: ok,
            status,
            error: ok ? null : `harness answered ${status}`,
            body
          })
        })
      }
    )

    request.setTimeout(timeoutMs, () => {
      request.destroy()
      finish({ delivered: false, status: null, error: `timeout after ${timeoutMs}ms`, body: null })
    })

    request.on('error', (err) => {
      finish({ delivered: false, status: null, error: err.message, body: null })
    })

    request.end(body)
  })
}
