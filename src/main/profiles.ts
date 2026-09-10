import fs from 'node:fs'
import path from 'node:path'
import {
  parseProfile,
  profileNameSchema,
  type ProfileBundle,
  type ProfileFiles
} from '../shared/profile'
import {
  activationPlan,
  instanceIdFor,
  type ActivationPlan,
  type ActivationPlanResult,
  type ActivationRequest,
  type ActivationTarget,
  type PlannedHire
} from '../shared/profile-activation'
import { knownTargetsFor, type KnownTarget } from '../shared/known-targets'
import type { ProfileLoad, ProfileSummary } from '../shared/profile-view'
import type { AutonomyLevel, GateKind } from '../shared/gates'
import { describeToolGrants, type ToolGrant } from '../shared/engine-tools'
import { describeUnattendedGrants } from '../shared/engine-permissions'
import type { SpawnRequest } from '../shared/agents'
import type { RepoDerivation } from '../shared/repo-remote'
import type { Trigger } from './scheduler'
import { composeMessage, makeMessageId, type Message } from '../shared/message'
import { PROFILE_ENDPOINT } from '../shared/reserved'

/**
 * The profile store (SDD §1.1 `profiles.ts`, SDD §2 `~/.ephesus/profiles/<name>/`,
 * ADR-0012).
 *
 * M7.1 is the load/validate half; activate/instantiate is M7.2. The halves are
 * separated on purpose and the separation is testable: **loading is pure.**
 * Nothing here spawns, writes, commits, schedules or registers. A `list()` on a
 * broken bundle must leave the disk exactly as it found it, because the
 * Architect's first act with a new profile is to read it, and a reader with
 * side effects is not a reader.
 *
 * Two roots, home first:
 *
 *  - `<harness home>/profiles/<name>/` — what the Architect edits (SDD §2);
 *  - the app's bundled `profiles/` — the built-ins that ship with Ephesus
 *    (ENGINEERING-STANDARDS §2), Skeleton Crew and Front Office among them
 *    from M7.4/M7.5.
 *
 * Unlike `PromptStore`, this store does **not** seed the home copy on read.
 * Seeding is a write, and a write is a side effect; more to the point, a
 * silently seeded copy would shadow the built-in forever, so the next Ephesus
 * that shipped a corrected Skeleton Crew would not be the one running. When the
 * Architect wants to edit a built-in, copying the directory is the explicit act
 * that makes the override visible in `list()` as `source: "home"`.
 */
export class ProfileStore {
  /**
   * @param homeProfilesDir `<harness home>/profiles` — the Architect's copies.
   * @param builtinProfilesDir the app's bundled `profiles/` — the built-ins.
   */
  constructor(
    private readonly homeProfilesDir: string,
    private readonly builtinProfilesDir: string,
    /**
     * What the Architect has activated this profile against before, so the
     * panel can offer a target instead of asking for one to be retyped. A store
     * built without it lists profiles with no remembered targets, which is
     * exactly what an Ephesus that has never activated anything should show.
     */
    private readonly knownTargets: () => readonly KnownTarget[] = () => []
  ) {}

  /**
   * Contract: every profile directory under either root, home shadowing
   * builtin, sorted by name. Read-only; never throws on a broken bundle.
   *
   * A directory whose name is not a legal profile name is skipped rather than
   * listed as invalid: it was never a profile, so reporting it as a broken one
   * would put the Architect's `.DS_Store` and their mistyped `memo-policy.json`
   * in the same list.
   */
  list(): readonly ProfileSummary[] {
    const seen = new Map<string, ProfileSummary>()
    for (const [dir, source] of [
      [this.homeProfilesDir, 'home'],
      [this.builtinProfilesDir, 'builtin']
    ] as const) {
      for (const name of readDirNames(dir)) {
        if (seen.has(name)) continue
        if (!profileNameSchema.safeParse(name).success) continue
        const loaded = this.loadFrom(dir, name, source)
        seen.set(name, {
          name,
          source,
          valid: loaded.ok,
          version: loaded.ok ? loaded.bundle.document.version : null,
          knownTargets: knownTargetsFor(this.knownTargets(), name).map((row) => ({
            kind: row.target.kind,
            id: row.target.id,
            path: row.target.path,
            lastUsedAt: row.lastUsedAt
          }))
        })
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Contract: loads one bundle by name, or refuses it BY NAME with every reason
   * at once. Read-only; never throws.
   *
   * The refusal never degrades to defaults. ADR-0012 chose declarative bundles
   * so a profile can be read before it is trusted; a loader that supplied a
   * missing `memo-policy.json` would have made that reading a lie in exactly
   * the field that decides what gets held for a memo.
   */
  load(name: string): ProfileLoad {
    if (!profileNameSchema.safeParse(name).success) {
      return { ok: false, name, reasons: ['profile: not a legal profile name'] }
    }
    for (const [dir, source] of [
      [this.homeProfilesDir, 'home'],
      [this.builtinProfilesDir, 'builtin']
    ] as const) {
      if (!isDirectory(path.join(dir, name))) continue
      return this.loadFrom(dir, name, source)
    }
    return {
      ok: false,
      name,
      reasons: [
        `profile: no bundle named "${name}" in ${this.homeProfilesDir} or ${this.builtinProfilesDir}`
      ]
    }
  }

  /**
   * Contract: the raw FILES of one bundle, home shadowing builtin, or null.
   *
   * Export needs the text, not the parsed object (FR-10.4, M7.6): ADR-0012's
   * argument for declarative bundles is that they are plain files, diffable in
   * review, and a re-serialized object would hand a reviewer a diff of this
   * build's formatting instead of what the author wrote.
   */
  filesOf(name: string): ProfileFiles | null {
    if (!profileNameSchema.safeParse(name).success) return null
    for (const dir of [this.homeProfilesDir, this.builtinProfilesDir]) {
      if (!isDirectory(path.join(dir, name))) continue
      const read = readBundleFiles(path.join(dir, name), name)
      return read.ok ? read.files : null
    }
    return null
  }

  private loadFrom(root: string, name: string, source: 'home' | 'builtin'): ProfileLoad {
    const dir = path.join(root, name)
    const read = readBundleFiles(dir, name)
    if (!read.ok) return { ok: false, name, reasons: read.reasons }
    const parsed = parseProfile(read.files)
    if (!parsed.ok) return { ok: false, name, reasons: parsed.reasons }
    return { ok: true, bundle: parsed.bundle, source }
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function readDirNames(dir: string): readonly string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // A missing root is not a fault: a fresh harness home has no profiles, and
    // an app built without built-ins still runs.
    return []
  }
}

function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** `<dir>/<sub>/*.<ext>` → contents, keyed by file name. Missing dir ⇒ empty. */
function readSubdir(dir: string, sub: string, ext: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>()
  let entries: readonly fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(ext)) continue
    const text = readTextFile(path.join(dir, sub, entry.name))
    if (text !== null) files.set(entry.name, text)
  }
  return files
}

/**
 * Reads the six parts of ADR-0012's bundle off disk as TEXT.
 *
 * The three required JSON files are reported missing by name here rather than
 * as a parse failure downstream, because "memo-policy.json: missing" and
 * "memo-policy.json: not JSON" send the Architect to two different places.
 */
function readBundleFiles(
  dir: string,
  name: string
): { ok: true; files: ProfileFiles } | { ok: false; reasons: readonly string[] } {
  const reasons: string[] = []
  const required = {
    profileJson: 'profile.json',
    memoPolicyJson: 'memo-policy.json',
    harborJson: 'harbor.json'
  } as const
  const bodies: Partial<Record<keyof typeof required, string>> = {}
  for (const [key, file] of Object.entries(required) as [keyof typeof required, string][]) {
    const text = readTextFile(path.join(dir, file))
    if (text === null) reasons.push(`${file}: missing from the bundle`)
    else bodies[key] = text
  }
  if (
    reasons.length > 0 ||
    bodies.profileJson === undefined ||
    bodies.memoPolicyJson === undefined ||
    bodies.harborJson === undefined
  ) {
    return { ok: false, reasons }
  }
  return {
    ok: true,
    files: {
      name,
      profileJson: bodies.profileJson,
      hires: readSubdir(dir, 'hires', '.json'),
      triggers: readSubdir(dir, 'triggers', '.json'),
      playbooks: readSubdir(dir, 'playbooks', '.md'),
      memoPolicyJson: bodies.memoPolicyJson,
      harborJson: bodies.harborJson
    }
  }
}

/**
 * A live profile instance — one bundle activated on one target (FR-9.4).
 *
 * The plan is kept beside the live ids rather than recomputed, so what an
 * instance IS stays the thing the Architect was shown when they activated it.
 * A recomputed plan would drift the moment the bundle on disk changed, and the
 * agents already running would be running under terms nobody approved.
 */
export interface ProfileInstance {
  readonly instanceId: string
  readonly plan: ActivationPlan
  /** Agent ids actually spawned, in the order they came up. */
  readonly agentIds: readonly string[]
  /**
   * Whether this instance's hires are running (M8.8).
   *
   * `down` is what a RESTORED instance is: the harness restarted, the plan
   * came back, and the processes did not. It is a field rather than a
   * derivation because two things depend on it and both are silent when wrong.
   *
   * Triggers are not armed while the crew is down. An armed schedule trigger
   * wakes `trigger.agentId`, so arming one for an agent that does not exist
   * produces a wake into the void once per interval, forever — a check that
   * cannot fail, which is this codebase's recurring defect.
   *
   * And `activate` refuses a duplicate instance (FR-9.4), so without this a
   * restored instance would block the very reactivation that brings its crew
   * back: the restart would have replaced one stuck state with a worse one.
   * A `down` instance is taken over by `activate`; a `live` one is still
   * refused.
   */
  readonly crew: 'live' | 'down'
  /** Scheduler trigger ids armed for this instance. Empty while `crew` is down. */
  readonly armed: readonly string[]
  /**
   * Event bindings this instance declares (`webhook`, `ci`, `health`).
   *
   * Recorded, and NOT armed: nothing publishes these events yet — the Harbor's
   * `gh` ingestion is M7.3 and the webhook endpoint is M7.4. They are exposed
   * so the subscriber that arrives can find them, and so the gap is a listed
   * fact rather than a trigger the Architect believes is on duty.
   */
  readonly pendingEvents: readonly { readonly id: string; readonly event: string }[]
  readonly activatedAt: string
}

export type ActivationResult =
  | { readonly ok: true; readonly instance: ProfileInstance }
  | { readonly ok: false; readonly reasons: readonly string[] }

export interface ProfileActivationOptions {
  readonly store: ProfileStore
  /** The company-wide autonomy ceiling; a profile may only go lower (SDD §9). */
  globalAutonomy(): AutonomyLevel
  /**
   * Which of these declared grants the broker cannot supply (M8.4). Wired to
   * the SAME resolver the spawn path uses, so the activation screen and the
   * outcome cannot disagree; absent means nothing is checked, which is the
   * old behaviour and is why the parameter exists.
   */
  missingGrants?(declared: readonly string[]): readonly string[]
  /**
   * What the target checkout's own git remotes say it is (M8.5). Absent means
   * nothing is read, which is the pre-M8.5 behaviour and is why the parameter
   * exists — but in the shipped app it is always wired, because both shipped
   * bundles carry `repos: []` and without it every activation watches nothing.
   */
  resolveRepos?(target: ActivationTarget): Promise<RepoDerivation>
  /**
   * Whether this instance has anything to watch — `because` names the reason
   * when it has NOT, and is null when it has (M8.5).
   *
   * Its own seam rather than a line inside the activated log row, because the
   * Architect has to SEE it: this is the condition that made the flagship
   * mission inert on first use, and it looked exactly like a healthy
   * activation. Main routes it to the degradation channel (invariant §7).
   *
   * ONE callback carrying both directions rather than two, because a
   * degradation that is raised and never cleared is the failure mode M8.2 was
   * written against: the Architect fixes the remote, reactivates, and the
   * health list still says the mission watches nothing. A second callback
   * could be left unwired; this one cannot be half-wired.
   */
  onWatching?(instanceId: string, because: string | null): void
  /** Spawns one hire. Rejecting unwinds the whole activation — see `activate`. */
  spawn(request: SpawnRequest): Promise<unknown>
  /** Kills one agent, on deactivation or on an unwind. */
  kill(agentId: string): void
  /**
   * The plan is settled and NOTHING has been hired yet (M8.7).
   *
   * The seam exists for work that must happen after the activation is known to
   * be going ahead but before any process exists — today, writing the engine's
   * workspace trust for the target AND for the worktrees this activation is
   * about to create (ADR-0021). It takes the plan rather than the request so
   * the directories trusted are the ones the hires below actually use; deriving
   * them a second time is the drift M8.5 already paid for.
   *
   * It cannot refuse. ADR-0021 makes a failed trust write a visible degradation
   * rather than a refusal, and that stands: an unreadable `~/.claude.json` is
   * the Architect's file, not a reason the company may not start.
   */
  beforeHires?(plan: ActivationPlan): void
  /**
   * The plan is settled and NOTHING has been hired yet; put this instance's
   * runbooks where its agents can read them (M8b.1).
   *
   * Unlike `beforeHires` it CAN refuse, and the difference is the point. A
   * failed engine-trust write leaves a company that still works; an instance
   * whose hires cannot open the runbook they are told to follow cannot do the
   * one thing it was activated for, and every agent discovers that separately
   * and expensively. Refusing here unwinds nothing, because nothing has
   * started.
   *
   * Optional, like every other seam here, so the class stays testable with no
   * filesystem — absent means nothing is installed, which is the pre-M8b.1
   * behaviour and the reason the exit run found what it found.
   */
  installPlaybooks?(
    plan: ActivationPlan,
    playbooks: ReadonlyMap<string, string>
  ): { readonly ok: true } | { readonly ok: false; readonly reasons: readonly string[] }
  /**
   * One hire is up and the instance is live (M8.6). Carries the whole planned
   * hire rather than an id and a policy, so a consumer that later needs the
   * isolation row or the budget does not need a second seam — and so this one
   * cannot drift from the plan the Architect was shown.
   */
  onHired?(hire: PlannedHire): void
  /** One agent is being torn down for good; cancel anything holding it. */
  onReleased?(agentId: string): void
  /** Arms a schedule trigger. */
  addTrigger(trigger: Trigger): void
  /** Disarms one, by id. */
  removeTrigger(triggerId: string): void
  /** True when this path is a directory the agents can work in. */
  targetExists(path: string): boolean
  now?(): Date
  onLogEvent?(draft: { kind: 'profile' } & Record<string, unknown>): void
  /** What an armed schedule trigger does when it fires. */
  onTriggerFired?(instanceId: string, triggerId: string, agentId: string, playbook: string): void
  /**
   * The live set changed; write it down so the next boot can restore it (M8.8).
   *
   * Injected rather than a store constructed here, for the reason everything
   * else in these options is: this class must stay testable with no filesystem,
   * and main owns where harness state lives. Called after EVERY mutation of
   * `live` — activation, deactivation and restore — because a persist that
   * covers only the happy path is a record that disagrees with memory exactly
   * when it is read.
   *
   * It cannot refuse. A failed write is a visible degradation, reported by
   * main; it is not a reason to fail an activation that has already spawned a
   * crew, and rolling one back over a disk error would destroy working agents
   * to protect a record of them.
   */
  persist?(instances: readonly ProfileInstance[]): void
}

/**
 * Activation and deactivation (ADR-0012, FR-9.4, FR-11.1 — M7.2).
 *
 * The class owns three facts and no judgment: which instances are live, which
 * agents belong to which, and which triggers are armed. Every decision —
 * whether the target matches, what each hire becomes, what autonomy composes
 * to — is `activationPlan`'s, computed pure and shown to the Architect BEFORE
 * this class acts on it.
 */
export class ProfileActivations {
  private readonly live = new Map<string, ProfileInstance>()

  /**
   * Plans whose hires are being spawned RIGHT NOW (M8.7b).
   *
   * `AgentManager.spawnConfig` composes a hire's autonomy and its tool grants
   * by asking this module, and it asks DURING the spawn -- the config is built
   * before the process exists. An instance registered only after its last hire
   * was up therefore answered `null` to every one of those questions, and every
   * `null` has a quiet default behind it: `manual` autonomy, and no tools.
   *
   * The autonomy half was live and shipped. `claudePermissionMode` maps
   * `manual` to `--permission-mode default`, so an Architect who granted a
   * profile full autonomy went on answering the engine's permission prompt --
   * the exact complaint `AgentSpawnConfig.autonomy` was added to answer at
   * M7.7, unfixed for every agent that arrives through a profile, with a green
   * suite either side of it because no test asked the question at spawn time.
   *
   * A SET, not one field: two activations can overlap, and a single slot would
   * answer the second one's questions with the first one's plan.
   */
  private readonly activating = new Set<ActivationPlan>()

  constructor(private readonly options: ProfileActivationOptions) {}

  instances(): readonly ProfileInstance[] {
    return [...this.live.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId))
  }

  /**
   * Contract: what activating this profile on this target WOULD do, without
   * doing any of it. The activation screen's source, and `activate`'s own —
   * one computation, so the preview cannot drift from the act.
   *
   * Asynchronous since M8.5: the target's remotes are READ, not remembered.
   * A cached derivation would be a setting nobody re-reads, and the Architect
   * adds a remote to a checkout between two activations like anybody else.
   */
  async preview(request: ActivationRequest): Promise<ActivationPlanResult> {
    const planned = await this.planWith(request)
    return planned.ok ? { ok: true, plan: planned.plan } : { ok: false, reasons: planned.reasons }
  }

  /**
   * `preview`, plus the bundle the plan was computed from.
   *
   * Private, and the reason it exists is that `activate` needs the playbook
   * BODIES and the plan carries only their file names. Re-loading the bundle
   * to get them would read the disk a second time, so an edit landing between
   * the two reads would install runbooks belonging to a plan the Architect was
   * never shown. One load answers both questions, for the same reason
   * `grantsUnavailable` is answered by the resolver the spawn uses: the screen
   * and the outcome must not be able to disagree.
   */
  private async planWith(
    request: ActivationRequest
  ): Promise<
    | { readonly ok: true; readonly plan: ActivationPlan; readonly bundle: ProfileBundle }
    | { readonly ok: false; readonly reasons: readonly string[] }
  > {
    const loaded = this.options.store.load(request.profile)
    if (!loaded.ok) return { ok: false, reasons: loaded.reasons }
    const derived = (await this.options.resolveRepos?.(request.target)) ?? {
      ok: false as const,
      because: 'the harness did not look at the target’s remotes'
    }
    const planned = activationPlan(
      loaded.bundle,
      request.target,
      this.options.globalAutonomy(),
      (declared) => this.options.missingGrants?.(declared) ?? [],
      derived,
      request.repos ?? [],
      request.isolation ?? 'as-declared'
    )
    return planned.ok
      ? { ok: true, plan: planned.plan, bundle: loaded.bundle }
      : { ok: false, reasons: planned.reasons }
  }

  /**
   * Contract: activates a profile on a target, or refuses with every reason.
   *
   * Activation is ALL OR NOTHING. If a hire fails to spawn, the ones already up
   * are killed and the instance is refused — a half-activated crew is worse
   * than none, because the Architect was shown a plan with an on-call agent in
   * it and would have no reason to think that agent is missing.
   */
  async activate(request: ActivationRequest): Promise<ActivationResult> {
    const instanceId = instanceIdFor(request.profile, request.target)
    // A restored instance whose crew is down is TAKEN OVER, not refused: it is
    // a record of what was live, and reactivating it is how the Architect
    // brings the crew back after a restart (M8.8). Refusing here would make the
    // restore itself the thing that blocks recovery.
    if (this.live.get(instanceId)?.crew === 'live') {
      return { ok: false, reasons: [`profile "${instanceId}" is already active`] }
    }
    if (!this.options.targetExists(request.target.path)) {
      return {
        ok: false,
        reasons: [`target "${request.target.path}" is not a directory on this machine`]
      }
    }

    const planned = await this.planWith(request)
    if (!planned.ok) return { ok: false, reasons: planned.reasons }
    const { plan } = planned

    // The runbooks cross from the bundle into the harness home HERE (M8b.1):
    // after the plan is fixed, before anything is spawned. A refusal at this
    // point costs nothing — no process exists and no token has been spent —
    // whereas letting it through is what the 2026-09-09 exit run measured:
    // four hires against three runbooks none of them could open, a duty
    // re-firing every fifteen minutes, `incident-triaged: 0` across eighteen
    // incidents, and $11.22 spent discovering the file was never written.
    //
    // It refuses rather than degrading, unlike `beforeHires` below. ADR-0021's
    // trust write degrades because a company may still work without it; an
    // instance whose hires cannot read their runbook cannot do the one thing
    // it was activated to do, and `profile.ts` already refuses a bundle whose
    // trigger names a playbook it does not carry. This is that same rule, one
    // boundary further on.
    const installed = this.options.installPlaybooks?.(plan, playbookBodies(planned.bundle, plan))
    if (installed !== undefined && !installed.ok) {
      return { ok: false, reasons: installed.reasons }
    }

    // Before the first process, after the plan is fixed: the engine's trust
    // record has to name every directory these hires will work in, or an
    // isolated one meets the first-run dialog with no session and no hook
    // (ADR-0021, M8.7).
    this.options.beforeHires?.(plan)

    // Answerable from here until the instance is registered (or rolled back),
    // because that whole window is when the spawn path asks about these hires.
    this.activating.add(plan)
    try {
      return await this.hire(plan, instanceId)
    } finally {
      this.activating.delete(plan)
    }
  }

  /**
   * The spawn window: every hire up, every trigger armed, the instance
   * registered. Split out so `activate` can hold `activating` across exactly
   * this span with a `finally` -- a flag cleared on the happy path alone is one
   * that leaks on every failure, and this one would leak a plan that answers
   * for agents the roll-back has already killed.
   */
  private async hire(plan: ActivationPlan, instanceId: string): Promise<ActivationResult> {
    const spawned: string[] = []
    for (const hire of plan.hires) {
      try {
        await this.options.spawn(hire.spawn)
        spawned.push(hire.agentId)
      } catch (err) {
        for (const id of spawned) this.options.kill(id)
        const because = err instanceof Error ? err.message.split('\n')[0] : String(err)
        this.options.onLogEvent?.({
          kind: 'profile',
          event: 'activation-failed',
          instanceId,
          agentId: hire.agentId,
          because
        })
        return {
          ok: false,
          reasons: [
            `hire "${hire.hire}" could not spawn: ${because} — nothing was activated`,
            ...(spawned.length > 0
              ? [`${String(spawned.length)} agent(s) already up were killed`]
              : [])
          ]
        }
      }
    }

    const armed: string[] = []
    for (const trigger of plan.triggers) {
      // The plan's own field, not a number parsed back out of its label.
      const everyMs = trigger.everyMs
      if (everyMs === null) continue
      this.options.addTrigger({
        id: trigger.id,
        everyMs,
        run: () => {
          this.options.onTriggerFired?.(instanceId, trigger.id, trigger.agentId, trigger.playbook)
        }
      })
      armed.push(trigger.id)
    }

    // Survival is declared only once every hire is up (M8.6, B12). Declaring
    // inside the loop would arm a ladder for an agent the roll-back above is
    // about to kill, and the ladder would faithfully bring it back.
    for (const hire of plan.hires) this.options.onHired?.(hire)

    const instance: ProfileInstance = {
      instanceId,
      plan,
      agentIds: spawned,
      crew: 'live',
      armed,
      pendingEvents: plan.triggers
        .filter((trigger) => trigger.everyMs === null)
        .map((trigger) => ({ id: trigger.id, event: trigger.event ?? trigger.when })),
      activatedAt: (this.options.now?.() ?? new Date()).toISOString()
    }
    this.live.set(instanceId, instance)
    this.persist()
    this.options.onLogEvent?.({
      kind: 'profile',
      event: 'activated',
      instanceId,
      profile: plan.profile,
      profileVersion: plan.profileVersion,
      target: plan.targetRef,
      agents: spawned,
      armed,
      // The composed levels, not the requested ones: the book of record should
      // say what the crew may actually do, and a clamped request is a fact
      // worth being able to find later.
      autonomy: Object.fromEntries(plan.autonomy.map((row) => [row.kind, row.effective])),
      clamped: plan.autonomy.filter((row) => row.clamped).map((row) => row.kind),
      // What it watches and where that came from (M8.5, NFR-13). A forensic
      // reader asking why no incident was ever raised for this instance can
      // now answer it from `log.jsonl` alone, which was the whole of B7.
      repos: [...plan.repos],
      reposFrom: plan.reposFrom,
      // What the company granted each hire, by the names the bundle used
      // (M8.7b, ADR-0026). Names, not resolved paths, for the same reason
      // `envGrants` logs names: the book of record says what was DECIDED, and
      // a granted tool directory is a decision about what an agent may read as
      // instructions.
      toolGrants: Object.fromEntries(
        plan.hires
          .filter((hire) => hire.tools.length > 0)
          .map((hire) => [hire.agentId, describeToolGrants(hire.tools)])
      ),
      // What each hire may do without stopping to ask its engine (M8c.8,
      // ADR-0035). On the row for the same reason `toolGrants` is: these are
      // acts that will happen with nobody watching, so a forensic reader asking
      // "who authorised that command" answers it from `log.jsonl` alone.
      unattended: Object.fromEntries(
        plan.hires
          .map((hire) => [hire.agentId, describeUnattendedGrants(hire.spawn.unattended)] as const)
          .filter(([, lines]) => lines.length > 0)
      )
    })
    // An instance watching nothing is a mission that cannot work, and until
    // M8.5 that was the silent outcome of every activation there had ever been
    // (invariant §7). It is not a REFUSAL: a profile pointed at a checkout with
    // no usable remote should still hire its crew and run its schedules, and
    // refusing would put a new cliff exactly where M8 is removing one. It is
    // said instead — before activation on the screen, and here afterwards.
    this.options.onWatching?.(instanceId, plan.repos.length === 0 ? plan.reposBecause : null)
    return { ok: true, instance }
  }

  /**
   * Contract: tears one instance down — triggers disarmed first, then agents
   * killed. Refuses an id that is not live rather than reporting success.
   *
   * Triggers first, deliberately: disarming after killing leaves a window in
   * which a trigger fires at an agent that no longer exists.
   *
   * **A crew that is already down is not an error** (M8c.9). A restored
   * instance's hires are `down` by design (ADR-0027): the harness restarted,
   * the plan came back, the processes did not. Asking `kill` for one of them by
   * name threw `agents: no agent "…"` out of the middle of this method, which
   * is how the M8b rehearsal met a closed loop — `profile:activate` refused
   * because the worktrees existed, `profile:deactivate` refused because the
   * agents did not, and the run continued only because the runner deleted four
   * directories by hand. It also threw *after* disarming the triggers and
   * releasing the hires, so the refusal left the instance half torn down.
   *
   * A `live` crew whose agent has died in the meantime is the same shape and is
   * handled the same way: what could not be killed is reported on the row
   * rather than thrown, because a deactivation that stops halfway is strictly
   * worse than one that finishes and says what it found.
   */
  deactivate(instanceId: string): { readonly ok: boolean; readonly reason: string | null } {
    const instance = this.live.get(instanceId)
    if (instance === undefined) return { ok: false, reason: `no active profile "${instanceId}"` }
    for (const triggerId of instance.armed) this.options.removeTrigger(triggerId)
    // Released BEFORE the kill, for the same reason triggers are disarmed
    // first: a hire whose ladder is still armed treats the kill that is
    // deactivating it as a crash, and brings it straight back (M8.6).
    for (const agentId of instance.agentIds) this.options.onReleased?.(agentId)
    // Nothing to kill when the crew is already down — and asking anyway is the
    // defect, not a harmless no-op.
    const unkillable: string[] = []
    if (instance.crew === 'live') {
      for (const agentId of instance.agentIds) {
        try {
          this.options.kill(agentId)
        } catch (err) {
          // Whole, not first-line-only: a `split()[0]` here would add a branch
          // no test could reach (`[0]` of a split is never absent), and this
          // module already learned that a branch which exists to be uncovered
          // is a design smell rather than a coverage problem.
          unkillable.push(`${agentId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    this.live.delete(instanceId)
    this.persist()
    // An instance that is gone is not an instance watching nothing (M8.5). Left
    // standing, the condition would outlive the thing it described and the
    // health list would keep naming an instance that no longer exists.
    this.options.onWatching?.(instanceId, null)
    this.options.onLogEvent?.({
      kind: 'profile',
      event: 'deactivated',
      instanceId,
      agents: instance.agentIds,
      disarmed: instance.armed,
      // What the crew was when the Architect asked, so the row distinguishes
      // "four agents stopped" from "four agents were already down".
      crew: instance.crew,
      ...(unkillable.length > 0 ? { unkillable } : {})
    })
    return { ok: true, reason: null }
  }

  /**
   * Contract: the autonomy an agent actually has for a gate class — the
   * composed level, or null when the agent belongs to no profile.
   *
   * This is the seam that makes FR-11.1 real rather than merely computed:
   * `GateRequest.profileAutonomy` is the field `decideGate` composes with, and
   * until something answered this question it was a field nothing ever set.
   * Null means "not a profile agent", and the caller then uses the global
   * policy alone — NOT a default of `autonomous`, which is why this returns
   * null rather than a level.
   */
  /**
   * Contract: the tool grants an agent's hire declared, with the target they
   * resolve against -- or null when the agent belongs to no profile.
   *
   * Null means "not a profile agent", and the caller then grants NOTHING. It
   * deliberately does not mean "use a default set": ADR-0026's whole point is
   * that a directory reaches an agent because a bundle named it.
   */
  toolsFor(
    agentId: string
  ): { readonly grants: readonly ToolGrant[]; readonly targetPath: string } | null {
    const plan = this.planFor(agentId)
    const hire = plan?.hires.find((row) => row.agentId === agentId)
    if (!plan || !hire) return null
    return { grants: hire.tools, targetPath: plan.targetPath }
  }

  autonomyFor(agentId: string, kind: GateKind): AutonomyLevel | null {
    return this.planFor(agentId)?.autonomy.find((row) => row.kind === kind)?.effective ?? null
  }

  /**
   * Contract: the NAME of the profile this agent was hired by, or null when it
   * belongs to none.
   *
   * The name, not the instance id: SDD §4.1 caps the roster field at 64
   * characters and documents it as the profile, while an instance id is
   * `<profile>@<targetRef>` and would not reliably fit — nor is a target
   * something the roster field claims to carry.
   *
   * Answers DURING a spawn, because `planFor` searches the in-flight plans as
   * well as the live instances (M8.7b). That is the whole reason the roster
   * write can know the answer: the entry is written before the instance is
   * registered.
   */
  profileFor(agentId: string): string | null {
    return this.planFor(agentId)?.profile ?? null
  }

  /**
   * Contract: the INSTANCE id an agent belongs to, or null (M8b.1).
   *
   * The instance rather than the profile, because runbooks are installed per
   * activation: two targets running one profile have two directories, and
   * answering with the profile name would hand both crews the same one.
   *
   * Answers DURING a spawn for the same reason `profileFor` does — `planFor`
   * searches the in-flight plans as well as the live set, and the spawn path
   * asks before the instance is registered. An answer that only became
   * available afterwards would be no answer at all: the settings file is
   * written at spawn.
   */
  instanceFor(agentId: string): string | null {
    return this.planFor(agentId)?.instanceId ?? null
  }

  /**
   * Contract: puts previously-live instances back, with their crews DOWN, and
   * returns one sentence per instance describing what did and did not come
   * back (M8.8). Never spawns, never kills, never arms a trigger.
   *
   * What this restores is everything that does not need a process: `planFor`
   * answers again, so tool grants (M8.7b) and composed autonomy (M7.2) work
   * for a rehired agent; `watchedRepos` sees the instance, so the Harbor
   * resumes ingesting; and the instance is on the panel instead of silently
   * absent.
   *
   * What it deliberately does NOT restore is the crew. Without engine session
   * recovery a respawned agent is amnesiac -- it re-reads its mailbox and
   * redoes in-flight work -- which is the double-processing SRS §6 criterion 6
   * forbids. Recorded as the Architect's decision of 2026-09-05; `--resume`
   * makes it safe and is owed.
   *
   * Idempotent, and refuses to displace a LIVE instance: calling it twice, or
   * after an activation, must not un-hire a running crew.
   */
  restore(instances: readonly ProfileInstance[]): readonly string[] {
    const notes: string[] = []
    for (const instance of instances) {
      if (this.live.get(instance.instanceId)?.crew === 'live') {
        notes.push(`${instance.instanceId} is already live — the record was not applied`)
        continue
      }
      const schedules = instance.plan.triggers.filter((trigger) => trigger.everyMs !== null).length
      this.live.set(instance.instanceId, {
        ...instance,
        crew: 'down',
        // Nothing is armed while the crew is down, and the record must say so:
        // a restored `armed` list naming triggers no scheduler holds is a
        // disarm that would silently do nothing on the next deactivate.
        armed: []
      })
      notes.push(
        `${instance.instanceId} restored from ${instance.activatedAt} — ` +
          `${String(instance.agentIds.length)} hire(s) are down and ` +
          `${String(schedules)} schedule trigger(s) stay disarmed until it is reactivated`
      )
    }
    this.persist()
    return notes
  }

  /**
   * The single write-down point. Private, and called from every mutation of
   * `live` rather than from the callers of those mutations, because a persist
   * a caller can forget is a record that disagrees with memory precisely when
   * it is read -- at the next boot, with nothing to compare it against.
   */
  private persist(): void {
    this.options.persist?.(this.instances())
  }

  /**
   * Contract: the plan an agent belongs to -- live, or being spawned right now
   * -- or null. Pure over this module's state.
   *
   * One place decides this, because two would eventually disagree about which
   * agents a plan speaks for, and the disagreement would be invisible: both
   * answers are plausible values, and the wrong one is a default.
   */
  private planFor(agentId: string): ActivationPlan | null {
    for (const instance of this.live.values()) {
      if (instance.agentIds.includes(agentId)) return instance.plan
    }
    for (const plan of this.activating) {
      if (plan.hires.some((hire) => hire.agentId === agentId)) return plan
    }
    return null
  }
}

/**
 * Contract: the bodies of exactly the playbooks a plan declares, keyed by file
 * name. Pure.
 *
 * Keyed off `plan.playbooks` rather than off the bundle, so the set installed
 * is the set the Architect was shown on the activation screen and the set
 * `activations.json` records. That equality is M8b.1's whole acceptance
 * criterion, and deriving the installed set from a second source is how it
 * would come apart: the exit run's home held zero of three declared runbooks
 * and every surface still named all three.
 *
 * A declared name the bundle does not carry is skipped rather than defaulted
 * to an empty file. `parseProfile` already refuses a trigger naming a playbook
 * the bundle lacks, so this is unreachable through the normal path — and if it
 * ever becomes reachable, an absent file that the audit then reports is a far
 * better outcome than a zero-byte runbook an agent would dutifully follow.
 */
export function playbookBodies(
  bundle: Pick<ProfileBundle, 'playbooks'>,
  plan: Pick<ActivationPlan, 'playbooks'>
): ReadonlyMap<string, string> {
  const byFile = new Map(bundle.playbooks.map((book) => [book.file, book.text]))
  const declared = new Map<string, string>()
  for (const file of plan.playbooks) {
    const text = byFile.get(file)
    if (text !== undefined) declared.set(file, text)
  }
  return declared
}

/** What a fired schedule trigger needs to say, and to whom. */
export interface TriggerWake {
  readonly instanceId: string
  readonly triggerId: string
  readonly agentId: string
  /** The runbook's file name, e.g. `incident.md`. */
  readonly playbook: string
  /**
   * Where that runbook actually is, absolute (M8b.1).
   *
   * The wake used to name the file and leave the agent to find it. On the
   * 2026-09-09 run the health watcher searched the home by name AND by
   * content, read `activations.json`, and correctly concluded the file had
   * never been shipped — work it should not have had to do, and could only do
   * because it happened to be diligent. A duty message that names a path the
   * harness has just written is not asking the agent to guess.
   */
  readonly playbookPath: string
  /** The profile's name, for the wake's own words. */
  readonly profile: string
  /** Where the agent works — the activation target's path. */
  readonly targetPath: string
}

/**
 * Contract: the message a fired schedule trigger sends its agent. Pure.
 *
 * SDD §7.5's first arrow, and the reason this is a function rather than a
 * closure inside `index.ts`: through M7.2 a fired trigger appended a log line
 * and stopped, so the health watcher and the dependency updater were spawned
 * and then never asked for anything — two of FR-9.2's four components inert
 * behind a suite that was entirely green. Logic that lives only in the boot
 * wiring is logic no test can reach, so it lives here instead.
 *
 * The body is rendered from `prompts/profiles/trigger-body.md` (invariant §8);
 * this supplies facts and never prose. It names the runbook and does NOT
 * summarize it — the harness has never read a playbook and must not start.
 */
export function triggerWakeMessage(
  wake: TriggerWake,
  render: (kind: 'subject' | 'body', vars: Record<string, string>) => string,
  at: Date
): Message {
  // `playbook` renders the PATH, and `playbookName` the file name. That way
  // round on purpose: `PromptStore` seeds the home's copy of a prompt on first
  // use and never re-seeds it, so an Ephesus that has already run once keeps
  // its old `trigger-body.md`. Putting the fix in the value of a placeholder
  // that file already contains is what makes it reach an existing install;
  // introducing a new placeholder alone would have fixed only fresh homes —
  // and a fresh home is the only kind an exit run ever uses.
  const vars = {
    profile: wake.profile,
    playbook: wake.playbookPath,
    playbookName: wake.playbook,
    target: wake.targetPath
  }
  return composeMessage({
    // The suffix is derived from the trigger, so a wake is traceable to the
    // binding that sent it (NFR-13) without a random component nothing can
    // reproduce.
    id: makeMessageId(at, `trg${wake.triggerId.replace(/[^a-z0-9]/g, '').slice(0, 10) || 'x'}`),
    // The trigger id ALREADY carries its instance (`activationPlan` builds it
    // as `<instance>/<trigger>`), so prefixing it again both duplicated the
    // instance and blew SDD §4.4's 64-character conversation limit — 66 for a
    // profile named `skeleton-crew` on a target named `musahit`. Every schedule
    // wake threw, the health watcher and the dependency updater received
    // nothing, and the failure surfaced only as a count on the agora health
    // badge. The unit test passed because its fixture ids were shorter than the
    // ones production mints.
    conversation: wake.triggerId.slice(0, 64),
    in_reply_to: null,
    from: PROFILE_ENDPOINT,
    to: wake.agentId,
    // `request` obligates a reply (ADR-0003's table): a scheduled duty that
    // nobody had to answer for is a duty that quietly stops being done.
    act: 'request',
    subject: render('subject', vars).trim().slice(0, 200),
    body: render('body', vars).trim(),
    hops: 0,
    created_at: at.toISOString()
  })
}
