import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { HOOK_ENDPOINT_PATH } from '../../src/shared/hooks'

/**
 * A throwaway hook endpoint for tests: the same UDS / named-pipe listener shape
 * the real hook server takes in M1.3, with none of its policy. It exists so a
 * test can assert *what a spawned engine actually posted* rather than trusting
 * the engine's own stdout — the fake engine's hook steps are only believable if
 * something independent received them.
 *
 * Platform note: on Windows the "socket" is a named pipe. Node's net/http stack
 * takes both through the same `socketPath`/listen path, which is why the client
 * (`shims/hook-client.mjs`) and this server are each one code path.
 */

export interface StubHookPost {
  /** Raw body as posted; parsed separately so malformed posts stay observable. */
  readonly body: string
  readonly parsed: unknown
  readonly url: string
}

export interface HookStubServer {
  /** Pass to a spawned process as `EPH_HOOK_ENDPOINT`. */
  readonly endpoint: string
  /** Posts received so far, in arrival order. */
  readonly posts: readonly StubHookPost[]
  /** Answer sent to subsequent posts; lets a test drive the fail-open path. */
  respondWith(status: number): void
  /** Resolves once at least `n` posts have arrived, or rejects on timeout. */
  waitForPosts(n: number, timeoutMs?: number): Promise<readonly StubHookPost[]>
  close(): Promise<void>
}

/** Windows pipes live in a namespace, not the filesystem; everything else is a path. */
export function tempEndpoint(label: string): string {
  const unique = `${label}-${process.pid}-${randomBytes(4).toString('hex')}`
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${unique}`
    : path.join(os.tmpdir(), `${unique}.sock`)
}

/** Malformed bodies stay observable as `parsed: null` beside their raw `body`. */
function parseOrNull(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

export async function startHookStubServer(label = 'eph-hook-stub'): Promise<HookStubServer> {
  const posts: StubHookPost[] = []
  const waiters: { need: number; resolve: () => void }[] = []
  let status = 200

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      posts.push({ body, parsed: parseOrNull(body), url: req.url ?? '' })
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i]
        if (waiter && posts.length >= waiter.need) {
          waiters.splice(i, 1)
          waiter.resolve()
        }
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: status >= 200 && status < 300, path: HOOK_ENDPOINT_PATH }))
    })
  })

  const endpoint = tempEndpoint(label)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  return {
    endpoint,
    get posts() {
      return posts
    },
    respondWith(next: number) {
      status = next
    },
    waitForPosts(n, timeoutMs = 5000) {
      if (posts.length >= n) return Promise.resolve(posts)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`hook stub: expected ${n} posts, saw ${posts.length} in ${timeoutMs}ms`))
        }, timeoutMs)
        waiters.push({
          need: n,
          resolve: () => {
            clearTimeout(timer)
            resolve(posts)
          }
        })
      })
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
  }
}
