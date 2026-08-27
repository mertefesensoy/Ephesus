import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  HOOK_ENDPOINT_PATH,
  checkHookPayload,
  parseHookEnvelope,
  type HookEnvelope
} from '../shared/hooks'
import {
  RECALL_ENDPOINT_PATH,
  recallRequestSchema,
  type RecallRequest,
  type RecallResponse
} from '../shared/recall'

/**
 * The hook endpoint (SDD §1.1 `hooks.ts`, FR-2.1–2.3). Engine shims POST
 * lifecycle envelopes here; this is the entire event plane's front door
 * (ADR-0002), so it is also the entire attack surface an agent's own process
 * can reach. Three rules govern it:
 *
 *  1. **Authenticate every payload.** A per-spawn token is registered when the
 *     agent is spawned and checked on every post — not once at connect
 *     (ENGINEERING-STANDARDS §5). An unregistered agent or a wrong token is
 *     rejected and reported; it never reaches the event plane.
 *  2. **Never drop an event silently.** A malformed envelope is rejected *and
 *     reported*; a drifted one is accepted *with a visible warning* (FR-2.3).
 *     The one thing that must never happen is an event vanishing quietly.
 *  3. **Never take an agent down.** The server answers every request; the shim
 *     side fails open (SDD §10) so a dead harness costs the agent nothing.
 */

/** Access mode for the socket file: owner only (ENGINEERING-STANDARDS §5). */
export const HOOK_SOCKET_MODE = 0o600

/**
 * Where the endpoint lives for a given harness home.
 *
 * POSIX: `<home>/events.sock`, chmod 0600 (SDD §2).
 *
 * Windows has no filesystem socket and no `chmod`: the equivalent is the local
 * named-pipe namespace, which libuv opens with remote clients rejected, so only
 * processes on this machine can connect. The per-home hash keeps two harness
 * homes (and every test running against its own `EPH_HOME`) from colliding on a
 * single global pipe name — Windows pipe names are a machine-wide namespace,
 * unlike socket paths.
 */
export function hookEndpointFor(homeRoot: string): string {
  if (process.platform !== 'win32') return path.join(homeRoot, 'events.sock')
  const discriminator = createHash('sha256')
    .update(path.resolve(homeRoot))
    .digest('hex')
    .slice(0, 16)
  return `\\\\.\\pipe\\ephesus-events-${discriminator}`
}

/** One accepted post, ready for the event plane. */
export interface HookEventRecord {
  readonly envelope: HookEnvelope
  /** True when the event name is one the harness knows. */
  readonly known: boolean
  /** Non-null when the post was accepted despite drift — must be surfaced (FR-2.3). */
  readonly warning: string | null
  /** Milliseconds since epoch, stamped by the server on receipt. */
  readonly receivedAt: number
}

/** One refused post. Carries refs so it can be found later (ENGINEERING-STANDARDS §4). */
export interface HookRejection {
  readonly reason: string
  /** `agentId` when the envelope parsed far enough to name one; null otherwise. */
  readonly agentId: string | null
  readonly status: number
}

/**
 * What the harness may tell the engine to do in reply to a hook. Today only the
 * Stop hook uses it (ADR-0013): `block` hands the reason back as new input and
 * the agent keeps working.
 */
export interface HookReply {
  readonly decision: 'block'
  readonly reason: string
}

export interface HookServerOptions {
  /**
   * Called for every accepted post, drifted or not. A returned reply is passed
   * back to the engine; returning nothing lets the turn end normally. May be
   * async — the Stop decision consumes the inbox before replying (ADR-0013).
   */
  onEvent(record: HookEventRecord): HookReply | void | Promise<HookReply | void>
  /** Called for every refused post. Wired to `log.jsonl` when the Agora lands (M2). */
  onRejected(rejection: HookRejection): void
  /**
   * Raised when `onEvent` itself throws or rejects. The engine still gets a
   * plain `{ok:true}` (fail-open, SDD §10) — the failure is reported here so it
   * is a visible degradation, never an unhandledRejection in main.
   */
  onEventError?(err: unknown): void
  /**
   * Answers an agent's `eph-recall` query (ADR-0006 layer 2). Optional: a
   * harness with no Library configured answers 503 and the shim says so, rather
   * than returning an empty result an agent would read as "nothing known".
   *
   * It lives on this server because it needs exactly what this server already
   * owns: the one 0600 socket and the per-spawn token registry.
   */
  onRecall?(request: RecallRequest): RecallResponse | Promise<RecallResponse>
  /** Largest body the endpoint will read; anything larger is refused. */
  maxBodyBytes?: number
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024

export class HookServer {
  private server: http.Server | null = null
  private endpointPath: string | null = null
  /** agentId → per-spawn token. One live token per agent; a respawn replaces it. */
  private readonly tokens = new Map<string, string>()
  private readonly warnings: string[] = []

  constructor(private readonly options: HookServerOptions) {}

  /**
   * Registers the token a spawn will present. Called with the same value the
   * spawn plan puts in `EPH_HOOK_TOKEN` (ADR-0009, SDD §3).
   */
  registerSpawn(agentId: string, token: string): void {
    if (token.length === 0) throw new Error(`hooks: empty spawn token for agent "${agentId}"`)
    this.tokens.set(agentId, token)
  }

  /** Revokes an agent's token — posts from a dead spawn stop being accepted. */
  unregisterSpawn(agentId: string): void {
    this.tokens.delete(agentId)
  }

  /**
   * Distinct drift warnings seen this run, in first-seen order. The UI shows
   * these; an empty list is the only "no degradation" state (FR-2.3).
   */
  driftWarnings(): readonly string[] {
    return this.warnings
  }

  /** The endpoint currently listening, or null before `start()`. */
  endpoint(): string | null {
    return this.endpointPath
  }

  /**
   * Binds the endpoint for `homeRoot`. A socket file left behind by a crashed
   * run is removed first (SDD §10 "stale locks from crashes cleaned at
   * startup"); Windows pipes disappear with their process, so there is nothing
   * to clean there.
   */
  async start(homeRoot: string): Promise<string> {
    if (this.server) throw new Error('hooks: server already started')
    const endpoint = hookEndpointFor(homeRoot)

    if (process.platform !== 'win32' && fs.existsSync(endpoint))
      fs.rmSync(endpoint, { force: true })

    const server = http.createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      server.once('error', onError)
      server.listen(endpoint, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })

    // Owner-only on POSIX. On Windows the pipe's local-namespace ACL plus the
    // per-payload token is the equivalent — see hookEndpointFor().
    if (process.platform !== 'win32') fs.chmodSync(endpoint, HOOK_SOCKET_MODE)

    this.server = server
    this.endpointPath = endpoint
    return endpoint
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    const endpoint = this.endpointPath
    this.endpointPath = null
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    if (endpoint && process.platform !== 'win32') fs.rmSync(endpoint, { force: true })
  }

  private reject(res: http.ServerResponse, rejection: HookRejection): void {
    this.options.onRejected(rejection)
    res.writeHead(rejection.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, reason: rejection.reason }))
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const recall = req.method === 'POST' && req.url === RECALL_ENDPOINT_PATH
    if (!recall && (req.method !== 'POST' || req.url !== HOOK_ENDPOINT_PATH)) {
      this.reject(res, {
        reason: `unexpected ${req.method ?? 'request'} ${req.url ?? ''}`,
        agentId: null,
        status: 404
      })
      req.resume()
      return
    }

    const limit = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false

    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > limit) {
        aborted = true
        this.reject(res, { reason: `payload exceeds ${limit} bytes`, agentId: null, status: 413 })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (aborted) return
      // Nobody awaits this handler; its failure must be a reported degradation,
      // never an unhandledRejection in the main process.
      const body = Buffer.concat(chunks).toString('utf8')
      const done = recall ? this.answerRecall(body, res) : this.accept(body, res)
      done.catch((err: unknown) => this.options.onEventError?.(err))
    })
  }

  private async accept(body: string, res: http.ServerResponse): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      this.reject(res, { reason: 'body is not valid JSON', agentId: null, status: 400 })
      return
    }

    const parsed = parseHookEnvelope(raw)
    if (!parsed.ok) {
      const agentId =
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as { agentId?: unknown }).agentId === 'string'
          ? (raw as { agentId: string }).agentId
          : null
      this.reject(res, { reason: `malformed envelope — ${parsed.reason}`, agentId, status: 400 })
      return
    }

    const envelope = parsed.envelope
    const expected = this.tokens.get(envelope.agentId)
    // The reason never repeats the presented token: it is a credential, and
    // credentials do not go in logs (BUILD-PROMPT §3.6).
    if (expected === undefined) {
      this.reject(res, {
        reason: `no live spawn registered for agent "${envelope.agentId}"`,
        agentId: envelope.agentId,
        status: 401
      })
      return
    }
    if (expected !== envelope.token) {
      this.reject(res, {
        reason: `hook token mismatch for agent "${envelope.agentId}"`,
        agentId: envelope.agentId,
        status: 401
      })
      return
    }

    const check = checkHookPayload(envelope.event, envelope.payload)
    if (check.warning && !this.warnings.includes(check.warning)) this.warnings.push(check.warning)

    let reply: HookReply | void = undefined
    try {
      reply = await this.options.onEvent({
        envelope,
        known: check.known,
        warning: check.warning,
        receivedAt: Date.now()
      })
    } catch (err) {
      // Fail-open toward the agent (SDD §10): its turn ends normally. The
      // harness-side failure is reported, never silently swallowed.
      this.options.onEventError?.(err)
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, warning: check.warning, ...(reply ?? {}) }))
  }

  /**
   * `POST /recall` — the agent-facing recall query (ADR-0006 layer 2).
   *
   * Authenticated exactly like a hook post: the per-spawn token, checked on
   * every request. Unlike a hook, this one does **not** fail open. A hook that
   * cannot be delivered costs the agent nothing; a recall that quietly answers
   * "nothing found" when the Library is down would have the agent conclude the
   * company knows nothing (invariant §7). So every failure here answers with a
   * reason the shim prints.
   */
  private async answerRecall(body: string, res: http.ServerResponse): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      this.reject(res, { reason: 'body is not valid JSON', agentId: null, status: 400 })
      return
    }

    const parsed = recallRequestSchema.safeParse(raw)
    if (!parsed.success) {
      this.reject(res, {
        reason: `malformed recall request — ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        agentId: null,
        status: 400
      })
      return
    }

    const request = parsed.data
    const expected = this.tokens.get(request.agentId)
    if (expected === undefined || expected !== request.token) {
      this.reject(res, {
        reason: `recall refused for agent "${request.agentId}"`,
        agentId: request.agentId,
        status: 401
      })
      return
    }

    const answer = this.options.onRecall
    if (!answer) {
      this.reject(res, { reason: 'no library configured', agentId: request.agentId, status: 503 })
      return
    }

    let response: RecallResponse
    try {
      response = await answer(request)
    } catch (err) {
      this.options.onEventError?.(err)
      this.reject(res, {
        reason: `recall failed: ${err instanceof Error ? err.message : String(err)}`,
        agentId: request.agentId,
        status: 500
      })
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(response))
  }
}
