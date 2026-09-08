import fs from 'node:fs'
import net from 'node:net'
import { controlAddressSchema } from '../shared/control'

/**
 * One harness per home (ADR-0034) — the module that answers "is somebody else
 * already working here?".
 *
 * ## Why this exists
 *
 * A harness home holds one book of record and one single committer (invariant
 * §4/§5, ADR-0004). Two instances pointed at one home share both, and the
 * damage is not hypothetical: the duplicate `seq` in the Architect's own
 * `log.jsonl` came from exactly that, on 2026-09-07.
 *
 * M8.14 closed half of it by accident. Its CI run found that the control
 * endpoint's stale-socket cleanup ran unconditionally, so on POSIX a second
 * instance DELETED the first one's live socket and bound over it. Both
 * endpoints now refuse an address somebody is serving — but a refused endpoint
 * only stops that plane being stolen. The second instance still boots, still
 * hires, and still commits. This module is the part that stops it working at
 * all.
 *
 * ## Why there is no lockfile
 *
 * A pidfile would need a schema and a validator (invariant §9), a stale-lock
 * policy, and a release on every exit route — including the ones that do not
 * run, which is how stale locks are born. Liveness is instead proven by
 * **probing what a live harness is already serving**: its endpoints, and the
 * `control-endpoint.json` M8.14 already writes, whose `pid` lets the refusal
 * name the owner. Nothing is created, so nothing can be left behind by a crash.
 *
 * **The residual, stated rather than hidden:** a first harness whose endpoints
 * BOTH failed to bind is invisible here, and a second one would find the home
 * free. That first harness is already crippled and says so through its own
 * degradations; buying this last case would cost the stale-lock problem the
 * whole design avoids.
 */

/** How long to wait for an address to answer before calling it abandoned. */
export const SOCKET_PROBE_MS = 250

/**
 * Contract: is anything answering on this endpoint right now?
 *
 * Never throws, and never waits long. An address nobody answers within the
 * budget is treated as abandoned, which is the same conclusion an unconditional
 * `rmSync` reached — only now it is a conclusion rather than an assumption.
 *
 * It lives here rather than beside either endpoint because three callers need
 * it and none of them should import another subsystem for a socket probe.
 */
export async function isListening(endpoint: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ path: endpoint })
    const settle = (answer: boolean): void => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(SOCKET_PROBE_MS, () => settle(false))
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

/** What `occupiedBy` was asked to look at. Every effect injected. */
export interface HomeOccupancyQuery {
  /** `<home>/control-endpoint.json` — read for the owner's pid, if it is there. */
  readonly addressFile: string
  /**
   * Addresses a live harness on this home would be serving. Passed in rather
   * than derived, so this module never imports the two endpoint modules that
   * import IT — and so a test can ask about an address it controls.
   */
  readonly endpoints: readonly string[]
  /** Overridable for tests; defaults to reading the file from disk. */
  readFile?(path: string): string
  /** Overridable for tests; defaults to the real socket probe. */
  probe?(endpoint: string): Promise<boolean>
}

export type HomeOccupancy =
  { readonly occupied: false } | { readonly occupied: true; readonly because: string }

/** The condition a busy home reports. Stable, so a later clear finds it again. */
export const HOME_OCCUPIED = 'agora/home-occupied' as const

/**
 * Contract: never throws. Answers whether another harness is working on this
 * home, and — when it can — says which process.
 *
 * An unreadable or unparseable address file is NOT occupancy: it is a file we
 * could not read, and refusing to start the company over one would turn a
 * cosmetic fault into an outage. The endpoints are the authority; the file only
 * supplies a name for the answer they give.
 */
export async function occupiedBy(query: HomeOccupancyQuery): Promise<HomeOccupancy> {
  const probe = query.probe ?? isListening
  const owner = readOwner(query)

  for (const endpoint of query.endpoints) {
    if (!(await probe(endpoint))) continue
    return {
      occupied: true,
      because:
        `another Ephesus harness is already working on this home${owner} — it is answering on ` +
        `${endpoint}. Two instances on one home share a book of record and a single committer, ` +
        'so this one will hire nobody and arm no schedule. Stop the other one and restart.'
    }
  }
  return { occupied: false }
}

/**
 * Contract: pure apart from one read. The owning pid as a phrase, or an empty
 * string when there is nothing trustworthy to say.
 */
function readOwner(query: HomeOccupancyQuery): string {
  const read = query.readFile ?? ((path: string): string => fs.readFileSync(path, 'utf8'))
  try {
    const parsed = controlAddressSchema.safeParse(JSON.parse(read(query.addressFile)))
    // Deliberately silent on a malformed file: this is a courtesy name on an
    // answer the endpoints already decided, not a second opinion about it.
    return parsed.success ? ` (process ${String(parsed.data.pid)})` : ''
  } catch {
    return ''
  }
}
