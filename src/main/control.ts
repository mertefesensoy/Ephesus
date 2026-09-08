import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  CONTROL_ADDRESS_FILE,
  CONTROL_ENDPOINT_PATH,
  CONTROL_SCHEMA_VERSION,
  activationRequestFromArgs,
  controlRequestSchema,
  renderHelp,
  renderRefusal,
  renderUnknownVerb,
  resolveControlVerb,
  type ControlAnswer,
  type ControlVerb
} from '../shared/control'
import { everyPhrase, type ConsentDisclosure } from '../shared/consent'
import { diagnose, renderDiagnosis, type DiagnosisInput } from '../shared/diagnosis'
import type { ActivationRequest } from '../shared/profile-activation'
import type { IpcDeps } from './ipc'
import { writeFileAtomic } from './fsx'
import { isListening } from './home-lock'

/**
 * Access mode for the socket file: owner only, exactly as the hook endpoint
 * (ENGINEERING-STANDARDS §5). The surface trusts what `~/.ephesus`, the engine
 * credentials and the hook endpoint already trust — every process running as
 * the Architect — and nothing more.
 */
export const CONTROL_SOCKET_MODE = 0o600

/**
 * Where the control endpoint lives for a given harness home.
 *
 * Mirrors `hookEndpointFor` (`src/main/hooks.ts`) deliberately and exactly,
 * because that transport is already solved and a second scheme would be a
 * second thing to get wrong:
 *
 * POSIX: `<home>/control.sock`, chmod 0600.
 *
 * Windows has no filesystem socket and no `chmod`: the equivalent is the LOCAL
 * named-pipe namespace, which libuv opens with remote clients rejected, so only
 * processes on this machine can connect. The per-home hash keeps two harness
 * homes — and every test running against its own `EPH_HOME` — from colliding on
 * a single global pipe name, because Windows pipe names are a machine-wide
 * namespace where socket paths are not.
 *
 * A separate address from the hook endpoint, not a second path on the same
 * server: the hook endpoint authenticates a per-spawn token belonging to an
 * agent, and hanging the Architect's controls off an address every agent's own
 * process already knows would put them one forged envelope away from an agent.
 */
export function controlEndpointFor(homeRoot: string): string {
  if (process.platform !== 'win32') return path.join(homeRoot, 'control.sock')
  const discriminator = createHash('sha256')
    .update(path.resolve(homeRoot))
    .digest('hex')
    .slice(0, 16)
  return `\\\\.\\pipe\\ephesus-control-${discriminator}`
}

/**
 * What the endpoint needs, taken from `IpcDeps` rather than restated.
 *
 * `import type` only: the type is erased at compile time, so this module never
 * pulls `electron` into a test process. The `Pick` is the whole point — it is
 * not possible to satisfy `ControlDeps` with anything but the object the window
 * is already served from.
 */
export type ControlDeps = Pick<
  IpcDeps,
  | 'consent'
  | 'agents'
  | 'agora'
  | 'profilesList'
  | 'profilesActivate'
  | 'profilesDeactivate'
  | 'profilesInstances'
  | 'convene'
> & {
  /**
   * The writer itself, not a second closure over the same fields.
   *
   * `status` and `diagnosis` are readings of the fold `DIAGNOSIS.md` is written
   * from, and M8.13's whole point is that the report ADDS no state. Handing the
   * control surface its own snapshot builder would be a second opinion about
   * the same machine, and the two would disagree the first time one of them
   * forgot a field.
   */
  readonly diagnosis: { snapshot(): DiagnosisInput }
}

export interface ControlServerOptions {
  readonly deps: ControlDeps
  /**
   * Reported when the endpoint could not be bound or its address file could not
   * be written. A control surface that failed silently would leave a runner
   * typing at nothing, which is invariant §7's forbidden direction.
   */
  onDegraded(detail: string): void
  now?(): Date
  /** Largest body the endpoint will read; anything larger is refused. */
  maxBodyBytes?: number
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024

/**
 * The one condition this surface reports (`src/shared/degradation.ts`). Stable,
 * so a later clear finds it again.
 */
export const CONTROL_FAILED = 'control/failed' as const

/** How the answer names the channel it arrived on (`src/shared/gates.ts`). */
const REMOTE_CHANNEL = 'remote'

/**
 * The control endpoint (M8.14) — the Architect's authority reaching the company
 * without the window.
 *
 * ## What it is, and what it deliberately is not
 *
 * It is a second front door onto the SAME actions the window reaches. It is not
 * a second implementation of them: {@link ControlDeps} is a `Pick` of `IpcDeps`,
 * so a signature that changes on one side stops the other side compiling. The
 * window and the CLI cannot drift into disagreeing about what an action does,
 * which is this repository's most-repeated defect wearing a new hat.
 *
 * It is also not an authority. The four things a script may not do are refused
 * in `src/shared/control.ts`, by name, with a reason — see that module for why.
 *
 * ## Trust
 *
 * Owner-only, local-only, no token, mirroring the hook endpoint exactly
 * (`src/main/hooks.ts`): a `0600` socket in the home on POSIX, and on Windows
 * the LOCAL named-pipe namespace with a per-home discriminator. It trusts what
 * `~/.ephesus`, the engine credentials and the hook endpoint already trust —
 * every process running as the Architect. A token would be a new secret to
 * manage against ADR-0010's write-only rule for a threat this design does not
 * otherwise face; what the surface adds instead is AUDIT.
 *
 * ## Audit
 *
 * Every act that changes something lands in the book of record as
 * `kind: 'remote'`, `event: 'control'`, `channel: 'remote'` — the tag FR-10.3
 * names and the `SourceChannel` vocabulary `src/shared/gates.ts` already uses.
 * So the log can always answer "did the window do that, or did a script?".
 * Every refusal is logged too, always: an attempt to approve a gate from a
 * script is exactly what an audit wants to see, whether or not it succeeded.
 *
 * ## Why the class, and not four handlers in `index.ts`
 *
 * `index.ts` boot wiring has produced three dead-code findings here, every one
 * behind a green suite, because nothing but the real Electron boot could reach
 * the code. So every effect is injected, the class is driven directly by
 * `test/main/control-server.test.ts` over a real socket, and `index.ts` keeps
 * the construction and one `start()` call.
 */
export class ControlServer {
  private server: http.Server | null = null
  private endpointPath: string | null = null
  private addressPath: string | null = null
  private readonly now: () => Date

  constructor(private readonly options: ControlServerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  /** The endpoint currently listening, or null before `start()`. */
  endpoint(): string | null {
    return this.endpointPath
  }

  /**
   * Binds the endpoint for `homeRoot` and writes the address file.
   *
   * A socket left behind by a crashed run is removed first (SDD §10 "stale
   * locks from crashes cleaned at startup"); Windows pipes disappear with their
   * process, so there is nothing to clean there.
   */
  async start(homeRoot: string): Promise<string> {
    if (this.server) throw new Error('control: server already started')
    const endpoint = controlEndpointFor(homeRoot)

    // Two rules, in this order, and the order is the fix.
    //
    // 1. If something is ALREADY SERVING this address, refuse. Two harness
    //    instances on one home share a book of record and a single committer
    //    (EXIT-M8 §4 names it), and a control surface silently transferred to
    //    the second one would answer `ephctl` for a company the caller did not
    //    mean. Asked on BOTH platforms deliberately: Windows would refuse the
    //    duplicate pipe name anyway, but with `EADDRINUSE` instead of a
    //    sentence — and a rule that only runs on one platform is a rule only
    //    one platform's tests can check.
    // 2. Only then clear a leftover. A crashed harness leaves its socket file
    //    behind on POSIX and removing it is how the next boot binds (SDD §10);
    //    Windows pipes die with their process, so there is nothing to clear.
    //
    // The first rule was missing until CI found it: `rmSync` ran
    // unconditionally, so on POSIX the second instance DELETED the first one's
    // live socket and bound over it. On win32 the bind failed on its own, which
    // is why the test asserting the degradation was green here and red there.
    if (await isListening(endpoint))
      throw new Error(
        `another harness is already listening on ${endpoint} — two instances on one ` +
          'home share a book of record and a single committer; stop the first one'
      )
    if (process.platform !== 'win32' && fs.existsSync(endpoint))
      fs.rmSync(endpoint, { force: true })

    const server = http.createServer((req, res) => {
      this.handle(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(err)
      }
      server.once('error', onError)
      server.listen(endpoint, () => {
        server.removeListener('error', onError)
        resolve()
      })
    })

    // Owner-only on POSIX. On Windows the pipe's local-namespace ACL is the
    // equivalent — see controlEndpointFor().
    if (process.platform !== 'win32') fs.chmodSync(endpoint, CONTROL_SOCKET_MODE)

    this.server = server
    this.endpointPath = endpoint
    this.writeAddress(homeRoot, endpoint)
    return endpoint
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    const endpoint = this.endpointPath
    const address = this.addressPath
    this.endpointPath = null
    this.addressPath = null
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
      server.closeAllConnections?.()
    })
    if (endpoint && process.platform !== 'win32') fs.rmSync(endpoint, { force: true })
    // Removed on the way out so a CLI run after a clean quit says "no harness is
    // running" rather than "nothing is listening at the address I found".
    if (address) {
      try {
        fs.rmSync(address, { force: true })
      } catch {
        /* a home we cannot tidy is not worth failing the quit path over */
      }
    }
  }

  /**
   * Contract: never throws. A harness that could not advertise its endpoint
   * still serves it — the CLI can be pointed at the address by hand — so this
   * reports and continues rather than taking the boot down.
   */
  private writeAddress(homeRoot: string, endpoint: string): void {
    const target = path.join(homeRoot, CONTROL_ADDRESS_FILE)
    try {
      // Atomic: `scripts/ephctl.cjs` reads this file from another process, and a
      // half-written address is an address that lies (invariant §3).
      writeFileAtomic(
        target,
        `${JSON.stringify(
          {
            schemaVersion: CONTROL_SCHEMA_VERSION,
            endpoint,
            path: CONTROL_ENDPOINT_PATH,
            pid: process.pid,
            startedAt: this.now().toISOString()
          },
          null,
          2
        )}\n`
      )
      this.addressPath = target
    } catch (err) {
      this.options.onDegraded(
        `the control surface is listening but could not write ${CONTROL_ADDRESS_FILE}, so ` +
          `ephctl cannot find it: ${describe(err)}`
      )
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== CONTROL_ENDPOINT_PATH) {
      this.answer(
        res,
        404,
        this.refusal(
          'unknown',
          // `String(...)` rather than a nullish fallback: node always sets both
          // on a received request, so the fallback was a branch nothing could
          // ever take — and an untakeable branch is a claim nobody can check.
          `unexpected ${String(req.method)} ${String(req.url)} — the control surface ` +
            `accepts POST ${CONTROL_ENDPOINT_PATH} and nothing else`
        )
      )
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
        this.answer(res, 413, this.refusal('unknown', `payload exceeds ${String(limit)} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (aborted) return
      // Nobody awaits this handler; a failure inside it must be a reported
      // degradation, never an unhandledRejection in the main process.
      this.dispatch(Buffer.concat(chunks).toString('utf8'), res).catch((err: unknown) => {
        this.options.onDegraded(`the control surface failed to answer: ${describe(err)}`)
        try {
          this.answer(res, 500, this.refusal('unknown', `the harness failed: ${describe(err)}`))
        } catch {
          /* the socket is already gone; the degradation above is the record */
        }
      })
    })
  }

  /**
   * Parses, validates IN MAIN, and performs one verb.
   *
   * Invariant §2's rule is about who is trusted, not about which bridge a
   * payload crossed: the control surface is untrusted exactly like the renderer,
   * so every field is validated here and nothing arrives typed.
   */
  private async dispatch(body: string, res: http.ServerResponse): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      this.answer(res, 400, this.refusal('unknown', 'body is not valid JSON'))
      return
    }

    const envelope = controlRequestSchema.safeParse(raw)
    if (!envelope.success) {
      this.answer(
        res,
        400,
        this.refusal('unknown', `malformed request — ${issues(envelope.error)}`)
      )
      return
    }

    const resolved = resolveControlVerb(envelope.data.verb)

    // Refused FIRST, and logged whether or not the caller could have known.
    // An attempt to approve a gate from a script is precisely what an audit
    // wants to find later, and a refusal that left no trace would hide it.
    if (resolved.kind === 'refused') {
      this.log({
        verb: resolved.refusal.name,
        ok: false,
        because: 'deliberately not scriptable'
      })
      this.answer(res, 403, {
        schemaVersion: CONTROL_SCHEMA_VERSION,
        ok: false,
        verb: resolved.refusal.name,
        text: renderRefusal(resolved.refusal),
        data: { refused: resolved.refusal.name, instead: resolved.refusal.instead }
      })
      return
    }

    if (resolved.kind === 'unknown') {
      this.answer(res, 404, {
        schemaVersion: CONTROL_SCHEMA_VERSION,
        ok: false,
        verb: envelope.data.verb,
        text: renderUnknownVerb(envelope.data.verb),
        data: null
      })
      return
    }

    const verb = resolved.verb
    const args = verb.args.safeParse(envelope.data.args)
    if (!args.success) {
      this.answer(res, 400, {
        schemaVersion: CONTROL_SCHEMA_VERSION,
        ok: false,
        verb: verb.name,
        text: `refused: ${issues(args.error)}\n\nUsage: ${verb.usage}`,
        data: null
      })
      return
    }

    const answer = await performVerb(this.options.deps, verb, args.data)
    // Only the verbs the table marks `writes` reach the book of record. A read
    // changes nothing, and `log.jsonl` is append-only — a polled `status` would
    // push real events out of a reader's view for good.
    if (verb.writes)
      this.log({ verb: verb.name, ok: answer.ok, because: answer.ok ? null : answer.text })
    this.answer(res, answer.ok ? 200 : 409, answer)
  }

  /**
   * One row in the book of record, tagged the way FR-10.3 tags every
   * remote-originated directive.
   *
   * Contract: never throws. The Agora may be unwritable; an audit row that took
   * the control surface down with it would be a worse failure than a missing
   * row, and the degradation channel is the one that promises it cannot fail.
   */
  private log(entry: { verb: string; ok: boolean; because: string | null }): void {
    try {
      this.options.deps.agora.appendLog({
        kind: 'remote',
        event: 'control',
        channel: REMOTE_CHANNEL,
        verb: entry.verb,
        ok: entry.ok,
        because: entry.because
      })
    } catch (err) {
      this.options.onDegraded(
        `a control act (${entry.verb}) could not be written to the book of record: ${describe(err)}`
      )
    }
  }

  private refusal(verb: string, text: string): ControlAnswer {
    return { schemaVersion: CONTROL_SCHEMA_VERSION, ok: false, verb, text, data: null }
  }

  private answer(res: http.ServerResponse, status: number, answer: ControlAnswer): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer))
  }
}

/**
 * Contract: performs one already-validated verb against the deps.
 *
 * A module-level function rather than a method, and exported, for the reason
 * ENGINEERING-STANDARDS §6.7 gives: this is where every verb's behaviour lives,
 * and a method reachable only through an HTTP round trip would be a seam whose
 * branches nobody could drive cheaply. `test/main/control-verbs.test.ts` calls
 * it directly — including with a verb the table does not implement, which is
 * how the last branch below is anything but a comment.
 */
export async function performVerb(
  deps: ControlDeps,
  verb: ControlVerb,
  args: unknown
): Promise<ControlAnswer> {
  switch (verb.name) {
    case 'help':
      return ok(verb, renderHelp(), {
        verbs: verb.name
      })
    case 'status': {
      const fold = diagnose(deps.diagnosis.snapshot())
      return ok(
        verb,
        [
          `Ephesus ${fold.version} — ${fold.home}`,
          `consent: ${fold.consented ? 'granted' : 'NOT granted'} · crew: ${String(
            fold.crew.length
          )} · armed schedules: ${String(fold.armed.length)} · log rows: ${String(fold.events)}`,
          '',
          ...fold.rows.map((row) => `  ${row.verdict.toUpperCase().padEnd(14)} ${row.area}`),
          ...(fold.live.length === 0
            ? []
            : ['', 'Live conditions:', ...fold.live.map((c) => `  ${c.cause} — ${c.detail}`)])
        ].join('\n'),
        fold
      )
    }
    case 'diagnosis': {
      const input = deps.diagnosis.snapshot()
      // Rendered against the SAME instant the snapshot was taken, exactly as
      // `DiagnosisWriter` does — one fold, two renderings, never two folds.
      return ok(verb, renderDiagnosis(diagnose(input), input.at), null)
    }
    case 'consent:status': {
      const view = deps.consent.view()
      return ok(
        verb,
        [
          `consent: ${view.state}${view.mayStartWork ? '' : ` — ${view.because}`}`,
          `terms: ${String(view.terms)}${view.grantedAt === null ? '' : ` · granted ${view.grantedAt}`}`,
          '',
          'What granting it would do:',
          ...disclosureLines(view.disclosure)
        ].join('\n'),
        view
      )
    }
    case 'consent:grant': {
      const outcome = deps.consent.grant()
      return outcome.ok
        ? ok(
            verb,
            `consent granted — the company is starting. ${
              outcome.view.grantedAt === null ? '' : `on file since ${outcome.view.grantedAt}`
            }`.trim(),
            outcome.view
          )
        : fail(verb, `consent was NOT granted: ${outcome.reason ?? 'unknown reason'}`, outcome)
    }
    case 'profile:list': {
      const list = deps.profilesList()
      return ok(
        verb,
        list.length === 0
          ? 'no mission profiles are installed'
          : list
              .map(
                (p) =>
                  `  ${p.name.padEnd(20)} ${p.source.padEnd(8)} ${
                    p.valid ? `v${String(p.version ?? 0)}` : 'INVALID — inspect it in PROFILES'
                  }`
              )
              .join('\n'),
        list
      )
    }
    case 'profile:instances': {
      const live = deps.profilesInstances()
      return ok(
        verb,
        live.length === 0
          ? 'nothing is activated'
          : live
              .map(
                (i) =>
                  `  ${i.instanceId}\n      target ${i.plan.targetRef} at ${i.plan.targetPath}` +
                  `\n      repos ${i.plan.repos.join(', ') || '(none)'}` +
                  `\n      agents ${i.agentIds.join(', ') || '(none)'}` +
                  `\n      armed ${i.armed.join(', ') || '(none)'}`
              )
              .join('\n'),
        live
      )
    }
    case 'profile:activate': {
      const built = activationRequestFromArgs(
        args as Parameters<typeof activationRequestFromArgs>[0]
      )
      if (!built.ok) return fail(verb, `refused: ${built.reason}\n\nUsage: ${verb.usage}`, null)
      const result = await deps.profilesActivate(built.request as ActivationRequest)
      if (!result.ok)
        return fail(
          verb,
          ['activation refused:', ...result.reasons.map((r) => `  ${r}`)].join('\n'),
          result
        )
      const plan = result.instance.plan
      return ok(
        verb,
        [
          `activated ${result.instance.instanceId}`,
          `  target      ${plan.targetRef} at ${plan.targetPath}`,
          `  repositories ${plan.repos.join(', ') || '(none)'} — ${plan.reposBecause}`,
          `  agents      ${result.instance.agentIds.join(', ') || '(none)'}`,
          `  armed       ${result.instance.armed.join(', ') || '(none)'}`
        ].join('\n'),
        result.instance
      )
    }
    case 'profile:deactivate': {
      const { instance } = args as { instance: string }
      const result = deps.profilesDeactivate(instance)
      return result.ok
        ? ok(verb, `deactivated ${instance}`, result)
        : fail(verb, `not deactivated: ${result.reason ?? 'unknown reason'}`, result)
    }
    case 'odeon:convene': {
      const { attendee, agenda } = args as { attendee: readonly string[]; agenda: string }
      const outcome = await deps.convene(attendee, agenda)
      return outcome.ok
        ? ok(verb, `convened ${outcome.id} with ${attendee.join(', ')}`, outcome)
        : fail(verb, `not convened: ${outcome.reason}`, outcome)
    }
    case 'agents:list': {
      const cards = deps.agents.list()
      return ok(
        verb,
        cards.length === 0
          ? 'nobody is hired'
          : cards
              .map(
                (card) =>
                  `  ${card.agentId.padEnd(24)} ${String(card.lifecycle).padEnd(12)} ${card.role} on ${card.engine}`
              )
              .join('\n'),
        cards
      )
    }
    case 'log:tail': {
      const { limit } = args as { limit: number }
      const rows = deps.agora.tailLog(limit)
      return ok(
        verb,
        rows.length === 0
          ? 'the book of record is empty'
          : rows
              .map(
                (row) =>
                  `  ${String(row.seq).padStart(6)} ${new Date(row.ts).toISOString()} ${String(
                    row.kind
                  ).padEnd(14)} ${row['event'] === undefined ? '' : String(row['event'])}`
              )
              .join('\n'),
        rows
      )
    }
    default:
      // Unreachable in production: `resolveControlVerb` only ever returns a
      // member of CONTROL_VERBS, and `control-verbs.test.ts` asserts that every
      // member has a case above. It is here because a verb ADDED to the table
      // and not to this switch must say so plainly rather than answer "no such
      // verb" — which would send the caller hunting for a spelling that is,
      // in fact, correct.
      return fail(verb, `"${verb.name}" is listed but not implemented`, null)
  }
}

/**
 * Contract: constructs the control surface, starts it, and reports rather than
 * throwing when it cannot bind.
 *
 * It exists so `index.ts` holds ONE statement for the whole surface. The boot
 * row of `scripts/coverage-floors.json` measures how true "index.ts holds no
 * logic of its own" is (ENGINEERING-STANDARDS §6.7), and a try/catch spelled
 * out there would be a decision no test could reach — the exact shape that has
 * produced three dead-code findings in this repository.
 *
 * Never throws. A harness whose control surface would not bind still runs: the
 * window works, the condition is visible, and the CLI says nothing is listening.
 */
export async function startControlSurface(options: {
  readonly deps: ControlDeps
  readonly home: string
  /**
   * The degradation channel itself, taking the cause as well as the detail, so
   * `index.ts` passes `reportDegradation` by name rather than wrapping it in a
   * closure only this call site would ever read.
   */
  report(cause: 'control/failed', detail: string): void
  /** Overridable so a test does not write to the console. */
  announce?(line: string): void
}): Promise<ControlServer> {
  const server = new ControlServer({
    deps: options.deps,
    onDegraded: (detail) => options.report(CONTROL_FAILED, detail)
  })
  try {
    const endpoint = await server.start(options.home)
    ;(options.announce ?? ((line) => console.info(line)))(
      `control endpoint listening on ${endpoint}`
    )
  } catch (err) {
    options.report(
      CONTROL_FAILED,
      `the control surface is not listening, so ephctl cannot reach this harness: ${describe(err)}`
    )
  }
  return server
}

function ok(verb: ControlVerb, text: string, data: unknown): ControlAnswer {
  return { schemaVersion: CONTROL_SCHEMA_VERSION, ok: true, verb: verb.name, text, data }
}

function fail(verb: ControlVerb, text: string, data: unknown): ControlAnswer {
  return { schemaVersion: CONTROL_SCHEMA_VERSION, ok: false, verb: verb.name, text, data }
}

/** One line per issue, so a caller learns which flag was wrong rather than that one was. */
function issues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || 'request'}: ${issue.message}`)
    .join('; ')
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.message.split('\n')[0] ?? err.message) : String(err)
}

/**
 * The consent disclosure, in the shape the banner shows it. The CLI must state
 * what granting would do BEFORE it is granted, for the same reason the banner
 * does (ADR-0032): a consent nobody could read is not consent.
 */
function disclosureLines(disclosure: ConsentDisclosure): readonly string[] {
  return [
    `  hire     ${
      disclosure.hire === null
        ? 'nobody — no engine adapter is registered'
        : `${disclosure.hire.agentId} on ${disclosure.hire.engine}`
    }`,
    `  budget   ${
      disclosure.dailyCeiling === null
        ? 'no company-wide daily ceiling (unbudgeted)'
        : `${String(disclosure.dailyCeiling)} tokens/day`
    }`,
    ...disclosure.triggers.map(
      (trigger) => `  cadence  ${trigger.id} ${everyPhrase(trigger.everyMs)}`
    )
  ]
}
