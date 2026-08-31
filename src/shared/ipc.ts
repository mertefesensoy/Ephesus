import type { AgentCard, SpawnRequest } from './agents'
import type { AvatarSnapshot } from './avatar'
import type { CommandState } from './commands'
import type { LogEntry } from './log'
import type { KnowledgeDoc, MemoryView } from './memory'
import type { OrgNode } from './org'
import type { GymDecided, GymRowView } from './gym-view'
import type { BriefView, SourceView, StoaCurated } from './stoa-view'
import type {
  ActivationResult,
  ProfileInstanceView,
  ProfileLoad,
  ProfileSummary
} from './profile-view'
import type { ActivationPlanResult, ActivationRequest } from './profile-activation'
import type { HarborView } from './harbor'
import type { ShareExport, ShareInspection, ShareInstall } from './share-view'
import type { ModeSet, ModeView } from './mode-view'
import type {
  BriefRecord,
  RetroGenerated,
  RetroRow,
  RetroView,
  ConveneOutcome,
  MeetingAction,
  MeetingClosed,
  MeetingSaid,
  MeetingView,
  DeckCommentOutcome,
  DeckRecord,
  MemoDecided,
  MemoQueueRow
} from './odeon'
import type { MemoVerdictName } from './memo'

/** Which slice of the memo queue to read. */
export type MemoQueueName = 'open' | 'decided' | 'all'
import type { RecallResponse } from './recall'
import type { Registry } from './registry'
import type { BreakerState } from './breaker'
import type { AgentSpend } from './cost'
import type { GateVerdict, OpenGate } from './gates'
import type { Message } from './message'
import type { SecretStatus, SecretTest } from './secrets'
import type { TaskLedger } from './tasks'
import type { EphConfig } from './config'

/**
 * The typed `window.eph` surface (SDD §5) — the ONLY renderer door. Groups are
 * added milestone by milestone; every channel is registered in src/main/ipc.ts
 * and validated in main before touching state.
 */
export const IpcChannels = {
  configGet: 'config:get',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  agentsList: 'agents:list',
  agentsSpawn: 'agents:spawn',
  agentsCard: 'agents:card',
  agentsKill: 'agents:kill',
  agentsInterrupt: 'agents:interrupt',
  agentsSend: 'agents:send',
  avatarsList: 'avatars:list',
  hooksState: 'hooks:state',
  commandsList: 'commands:list',
  commandsSubmit: 'commands:submit',
  agoraRegistry: 'agora:registry',
  agoraTasks: 'agora:tasks',
  agoraBoard: 'agora:board',
  agoraLog: 'agora:log',
  agoraHealth: 'agora:health',
  // The Library's surface (SDD §5 `agora: memory(id)` plus the three the Memory
  // panel needs to show the ladder honestly and to fill the shelf). Documented
  // in SDD §5 in the same commit — the M3.1 rule: a new channel gets a doc line
  // and a DECISIONS-LOG entry, or it does not ship.
  agoraMemory: 'agora:memory',
  agoraRecall: 'agora:recall',
  agoraKnowledge: 'agora:knowledge',
  agoraRegisterKnowledge: 'agora:register-knowledge',
  // The Odeon's surface (SDD §5 `odeon:`). `deck` is the viewer's read of one
  // archived artifact; it is not in the SDD's abridged list and is recorded in
  // DECISIONS-LOG with SDD §5 updated to name it.
  odeonDecks: 'odeon:decks',
  odeonDeck: 'odeon:deck',
  odeonComment: 'odeon:comment',
  odeonBriefs: 'odeon:briefs',
  gymLedger: 'gym:ledger',
  gymProposal: 'gym:proposal',
  gymVerdict: 'gym:verdict',
  gymMetricResult: 'gym:metric-result',
  // The company mode (SDD §5 `gym: mode() setMode(m)`, ADR-0018). `setMode` is
  // architect-only and enforced in the handler, like `gym:verdict`: the
  // renderer names no actor, so there is no field an untrusted surface could
  // set to claim one.
  gymMode: 'gym:mode',
  gymSetMode: 'gym:set-mode',
  // The Stoa's surface (SDD §5 `stoa:`), exactly the five documented channels.
  // `register`/`retire` are Architect-only (FR-13.1) and enforced in the
  // handler, not here — the renderer names no registrar, so there is no field
  // an untrusted surface could set. There is deliberately no channel that sets
  // a pin: SDD §7.7 puts that inside the study flow.
  stoaWatchlist: 'stoa:watchlist',
  stoaRegister: 'stoa:register',
  stoaRetire: 'stoa:retire',
  stoaBriefs: 'stoa:briefs',
  stoaBrief: 'stoa:brief',
  // Mission profiles (SDD §5 `profiles:`, ADR-0012). M7.1 ships the READ half —
  // `list` and `inspect` — because loading is pure and inspecting a bundle
  // before trusting it is the safety story ADR-0012 chose profiles for.
  // `activate`/`deactivate` are M7.2's and are deliberately absent until the
  // composition they depend on exists.
  profilesList: 'profiles:list',
  profilesInspect: 'profiles:inspect',
  // SDD §5 lists `activate(name, target)` and `deactivate(instanceId)`.
  // `preview` and `instances` are added beside them under the M3.1 rule — a new
  // channel gets a doc line and a DECISIONS-LOG entry, or it does not ship.
  // `preview` is not a convenience: it is the screen ADR-0012's safety story
  // rests on, and it returns the SAME plan `activate` executes, so the two
  // cannot drift.
  profilesPreview: 'profiles:preview',
  profilesActivate: 'profiles:activate',
  profilesDeactivate: 'profiles:deactivate',
  profilesInstances: 'profiles:instances',
  // The Harbor's inbound half (SDD §5 `harbor: repos()`, FR-10.1). Reading is
  // free: `repos` answers from what the last ingestion held and touches no
  // network — the scheduler drives ingestion, so a panel opening cannot make
  // the company shell out to `gh`.
  harborRepos: 'harbor:repos',
  // Sharing (SDD §5 `harbor: hireExport(role) hireImport(blob)`, FR-10.4 — M7.6).
  // FOUR channels where the SDD's abridged list names two, recorded in
  // DECISIONS-LOG with SDD §5 updated to name them (the M3.1 rule).
  //
  // The split is the requirement, not a convenience. FR-10.4 says "import only
  // pre-fills the spawn form — a human always confirms", so INSPECT reads a
  // blob and returns a disclosure while writing nothing, and INSTALL is what a
  // confirmed form reaches. There is deliberately no channel that does both,
  // and none that activates: an imported profile is inert until the Architect
  // activates it through `profiles:activate`, which is its own action.
  harborHireExport: 'harbor:hire-export',
  harborProfileExport: 'harbor:profile-export',
  harborImportInspect: 'harbor:import-inspect',
  harborImportInstall: 'harbor:import-install',
  orgChart: 'org:chart',
  orgMetrics: 'org:metrics',
  orgRetros: 'org:retros',
  orgGenerateRetro: 'org:generate-retro',
  odeonConvene: 'odeon:convene',
  odeonMeeting: 'odeon:meeting',
  odeonMeetingSay: 'odeon:meeting-say',
  odeonMeetingClose: 'odeon:meeting-close',
  odeonMemos: 'odeon:memos',
  odeonVerdict: 'odeon:verdict',
  // SDD §5's four channels, exactly. Write-only by construction (ADR-0010):
  // there is deliberately no `secrets:get`, and the API-surface test in
  // test/main/secrets.test.ts fails if a fifth channel is ever added here —
  // whether it reads a value or not, since widening the documented IPC
  // signature is a BUILD-PROMPT §8 must-ask, not an implementation detail.
  secretsSet: 'secrets:set',
  secretsStatus: 'secrets:status',
  secretsTest: 'secrets:test',
  secretsDelete: 'secrets:delete',
  watchBudgets: 'watch:budgets',
  watchApprovals: 'watch:approvals',
  watchApprove: 'watch:approve',
  watchHumanQueue: 'watch:human-queue',
  watchBreaker: 'watch:breaker-state',
  watchDismiss: 'watch:dismiss'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

// NOTE: this module must stay free of runtime dependencies (zod included) —
// the sandboxed preload imports it, and sandboxed preloads cannot require
// external modules at runtime. Validators live in the sibling schema modules
// (config.ts, pty.ts) which only main imports.

/** Per-id event channels pushed main→renderer (SDD §5: `pty:data:<id>`). */
export const ptyDataChannel = (id: string): string => `pty:data:${id}`
export const ptyExitChannel = (id: string): string => `pty:exit:${id}`

export interface ConfigSnapshot {
  config: EphConfig
  /** Non-null when config.json failed validation — shown in the UI, never silent. */
  warning: string | null
}

/** Push channel carrying agent-card changes to the renderer (SDD §5 `state:agents`). */
export const AGENTS_STATE_CHANNEL = 'state:agents'

/** Push channel carrying one agent's avatar snapshot (SDD §6, ADR-0002). */
export const AVATARS_STATE_CHANNEL = 'state:avatars'

/** Push channel carrying one agent's held command text (FR-1.3). */
export const COMMANDS_STATE_CHANNEL = 'state:commands'

/**
 * Push channel signalling that the task ledger changed (SDD §5 `state:tasks`).
 * A nudge, not a payload: the kanban re-reads `agora:tasks` so it can never
 * disagree with main about what the ledger holds (the renderer is a projection).
 */
export const TASKS_STATE_CHANNEL = 'state:tasks'

/**
 * the memo queue changed (SDD §5 `odeon:queue`). A nudge, not a payload: the
 * panel re-reads `odeon:memos`, so it can never hold a second copy of the queue
 * that disagrees with the archive.
 */
export const ODEON_QUEUE_CHANNEL = 'odeon:queue'

/** Push channel signalling that `log.jsonl` has grown (SDD §5 `log:append`). */
export const LOG_APPEND_CHANNEL = 'log:append'

/**
 * Push channel for the approvals queue (SDD §5 `gate:open`). Carries the gate
 * that just opened, or null when one was settled — the payload is a nudge, not
 * a second copy of the queue: the renderer re-reads `watch:approvals` so it can
 * never disagree with main about what is open (the renderer is a projection).
 */
export const GATE_OPEN_CHANNEL = 'gate:open'

/** One agent's avatar snapshot, addressed. */
export interface AvatarUpdate {
  readonly agentId: string
  readonly snapshot: AvatarSnapshot
  /**
   * Mail waiting in this agent's inbox — UI-DESIGN §5.4's desk tray flag, which
   * IS `pendingMailCount` and not a look-alike. It rides the avatar update
   * rather than a channel of its own because it is a fact about the same agent
   * at the same moment: a separate channel could disagree with the snapshot,
   * and the floor would show a raised flag on a citizen who had just consumed
   * the mail.
   *
   * Deliberately NOT part of `AvatarSnapshot`: the snapshot is the SDD §6 state
   * machine, and mail is not one of its states.
   */
  readonly pendingMail: number
}

/**
 * Health of the event plane, for the visible degradation states FR-2.3 and
 * SDD §10 require: schema drift must be shown, and a hook endpoint that never
 * came up must be shown as "events unavailable" rather than a frozen floor with
 * no explanation.
 */
export interface HooksState {
  /** Endpoint currently listening, or null when the event plane is down. */
  readonly endpoint: string | null
  /** Distinct drift warnings seen this run, in first-seen order (FR-2.3). */
  readonly driftWarnings: readonly string[]
  /** Why the endpoint is down, when it is. */
  readonly failure: string | null
}

/**
 * Data-plane health, for invariant §7: every degradation is a visible UI state,
 * never a `console.warn` only the developer can see. Corrupt schema files,
 * commit-queue give-ups, and runtime failures (sweep/exit/hook-handler errors)
 * all surface here.
 */
export interface AgoraHealth {
  /** Schema files that failed to parse this run (kept on disk as evidence). */
  readonly fileWarnings: readonly { readonly file: string; readonly reason: string }[]
  /** Commits the queue gave up on after exhausting its retry budget. */
  readonly commitFailures: readonly { readonly subject: string; readonly reason: string }[]
  /** Runtime degradations reported by main since boot (bounded, newest last). */
  readonly runtime: readonly {
    readonly at: number
    readonly source: string
    readonly detail: string
  }[]
}

export interface EphApi {
  config: {
    get: () => Promise<ConfigSnapshot>
  }
  agents: {
    list: () => Promise<readonly AgentCard[]>
    /** Spawns one agent through its engine adapter; resolves with its card. */
    spawn: (request: SpawnRequest) => Promise<AgentCard>
    card: (agentId: string) => Promise<AgentCard>
    kill: (agentId: string) => Promise<void>
    /** Writes the engine's cancel key into the agent's PTY (ADR-0009). */
    interrupt: (agentId: string) => Promise<void>
    /** Sends Architect text to the agent's PTY verbatim (FR-1.3). */
    send: (agentId: string, text: string) => Promise<void>
    /** Subscribe to agent-card changes. Returns an unsubscribe function. */
    onChange: (cb: (card: AgentCard) => void) => () => void
  }
  avatars: {
    list: () => Promise<readonly AvatarUpdate[]>
    /** Subscribe to avatar snapshots. Returns an unsubscribe function. */
    onChange: (cb: (update: AvatarUpdate) => void) => () => void
  }
  hooks: {
    /** Event-plane health, including drift warnings that must be shown. */
    state: () => Promise<HooksState>
  }
  odeon: {
    /** Convenes a meeting: attendees and one agenda line (FR-7.4). */
    convene: (attendees: readonly string[], agenda: string) => Promise<ConveneOutcome>
    /** The live meeting, or null. The panel is a projection of it. */
    meeting: () => Promise<MeetingView | null>
    /**
     * The Architect takes the floor (UC-07 step 3). `to` hands it on; leaving
     * it out makes the interjection an aside that costs nobody their turn.
     */
    meetingSay: (text: string, to?: string) => Promise<MeetingSaid>
    /** Closes the meeting: minutes archived, action items sent to the scribe. */
    meetingClose: (actions: readonly MeetingAction[]) => Promise<MeetingClosed>
    /** Every archived standup brief, newest first (FR-7.1). */
    briefs: () => Promise<readonly BriefRecord[]>
    /** Every archived review deck, newest first (FR-7.2). */
    decks: () => Promise<readonly DeckRecord[]>
    /** One deck's HTML, for the in-app viewer. Null when the ref is foreign. */
    deck: (ref: string) => Promise<string | null>
    /**
     * A review comment on an archived deck (UC-05 step 4). It goes to the
     * orchestrator as mail, NOT to the ledger: FR-5.2 gives her the ledger, and
     * SDD §5 routes human-authored mail through her. She decides what task the
     * comment implies.
     */
    comment: (ref: string, text: string) => Promise<DeckCommentOutcome>
    /** The memo queue (FR-7.3). `open` is what the Architect owes a verdict. */
    memos: (queue: MemoQueueName) => Promise<readonly MemoQueueRow[]>
    /**
     * The Architect's verdict on a memo (UC-06 step 4). Architect-only by
     * construction: this channel exists on the window bridge, which main knows
     * with certainty is the Architect, and the orchestrator's own verdicts
     * arrive as mail instead.
     */
    verdict: (memoId: string, verdict: MemoVerdictName, notes: string) => Promise<MemoDecided>
    /** Subscribe to "the memo queue changed"; the panel then re-reads. */
    onQueue: (cb: () => void) => () => void
  }
  gym: {
    /** Every ledger row, oldest first (R2 — the ledger is total). */
    ledger: () => Promise<readonly GymRowView[]>
    /** One proposal document, as filed. */
    proposal: (id: string) => Promise<string | null>
    /**
     * The Architect's verdict (FR-12.3). ARCHITECT-ONLY, and enforced in the
     * handler rather than here: the renderer sends no decider at all, and
     * main supplies `architect` because it knows a call on the window bridge
     * IS the Architect. There is no field an untrusted surface could set.
     */
    verdict: (id: string, verdict: 'approved' | 'rejected') => Promise<GymDecided>
    /** Records the measured outcome; null means it could not be measured. */
    metricResult: (id: string, measured: string | null) => Promise<GymDecided>
    /** The company mode, plus what the proof gate would say (FR-14.1). */
    mode: () => Promise<ModeView>
    /**
     * Sets the company mode (FR-14.2). ARCHITECT-ONLY, enforced in the handler.
     * The first `improving` enable is refused unless SRS §6.9's evidence is on
     * the record, and the refusal lists exactly what is missing.
     */
    setMode: (mode: 'directed' | 'improving') => Promise<ModeSet>
  }
  stoa: {
    /** Every registered source, plus retired ones marked as such (FR-13.1). */
    watchlist: () => Promise<readonly SourceView[]>
    /**
     * Registers one source. ARCHITECT-ONLY, enforced in the handler for the
     * same reason `gym.verdict` is: main supplies `architect` because a call
     * on the window bridge IS the Architect, and the draft carries no id, no
     * registrar and no timestamp for anyone to claim. Agents may propose a
     * source in a report or a brief; no agent path reaches this channel.
     */
    register: (draft: {
      url: string
      tags: readonly string[]
      license: string
      pin: string | null
      notes: string
    }) => Promise<StoaCurated>
    /** Retires one source — it moves to the retired list, never deleted. */
    retire: (id: string) => Promise<StoaCurated>
    /** Every archived brief (FR-13.4), newest id first. */
    briefs: () => Promise<readonly BriefView[]>
    /** One brief's text, as archived and immutable. */
    brief: (id: string) => Promise<string | null>
  }
  profiles: {
    /**
     * Every bundle under the harness home or the built-ins, home shadowing
     * builtin. An INVALID bundle still gets a row (`valid: false`) — a profile
     * that disappeared from the list when its JSON broke would look
     * uninstalled, which is the silent degradation invariant §7 forbids.
     */
    list: () => Promise<readonly ProfileSummary[]>
    /**
     * One bundle, or every reason it was refused (ADR-0012). Reading is pure:
     * inspecting a profile activates nothing, spawns nothing and writes
     * nothing — it is how the Architect reads what a profile MAY do before
     * deciding whether it may.
     */
    inspect: (name: string) => Promise<ProfileLoad>
    /**
     * What activating this profile on this target WOULD do — hires, grants,
     * budgets, composed autonomy, triggers, repos — without doing any of it.
     * The activation screen reads this; `activate` executes the same plan.
     */
    preview: (request: ActivationRequest) => Promise<ActivationPlanResult>
    /** Activates it. All or nothing: a hire that cannot spawn unwinds the rest. */
    activate: (request: ActivationRequest) => Promise<ActivationResult>
    /** Tears one instance down — triggers disarmed first, then agents killed. */
    deactivate: (instanceId: string) => Promise<{ ok: boolean; reason: string | null }>
    /** Every live instance (FR-9.4: many profiles, many targets, one floor). */
    instances: () => Promise<readonly ProfileInstanceView[]>
  }
  harbor: {
    /**
     * What the port holds: the registered repositories, their queues, the rows
     * that were dropped, and any failure — per repo, and for `gh` overall.
     * A failure is a FIELD, never an empty list: a repo whose call errored and
     * one with nothing open must not look alike (invariant §7).
     */
    repos: () => Promise<HarborView>
    /** One role template as a shareable blob (FR-10.4). */
    hireExport: (profile: string, hire: string) => Promise<ShareExport>
    /** A whole ADR-0012 bundle, as the FILES it is made of. */
    profileExport: (name: string) => Promise<ShareExport>
    /**
     * What importing this blob WOULD do. Writes nothing, starts nothing —
     * this is the pre-fill FR-10.4 requires, and the manifest it returns is
     * recomputed from the payload rather than taken from the envelope.
     */
    importInspect: (blob: string) => Promise<ShareInspection>
    /**
     * Writes an accepted import into the harness home. The human confirming
     * is what reaches this. It does NOT activate: the imported profile is
     * inert until `profiles:activate`, which is a separate Architect action.
     */
    importInstall: (blob: string) => Promise<ShareInstall>
  }
  org: {
    /** The org chart, read off the roster (FR-11.5). */
    chart: () => Promise<readonly OrgNode[]>
    /** Per-agent metrics, folded from the book of record — never counted. */
    metrics: () => Promise<RetroView>
    /** Every archived weekly retro, newest first. */
    retros: () => Promise<readonly RetroRow[]>
    /** Generates one now, for the Architect who does not want to wait. */
    generateRetro: () => Promise<RetroGenerated>
  }
  agora: {
    /** The roster (SDD §4.1). */
    registry: () => Promise<Registry>
    /** The task ledger (SDD §4.2). */
    tasks: () => Promise<TaskLedger>
    /** The blackboard (FR-4.2). Artemis is its only scribe. */
    board: () => Promise<string>
    /** Subscribe to "the ledger changed"; the kanban then re-reads `tasks`. */
    onTasks: (cb: () => void) => () => void
    /** Events after `afterSeq` — the Activity feed pages with this (SDD §4.3). */
    log: (afterSeq: number, limit: number) => Promise<readonly LogEntry[]>
    /** Subscribe to "the log grew"; the feed then pages from its own cursor. */
    onAppend: (cb: () => void) => () => void
    /** Data-plane degradations — shown, never only logged (invariant §7). */
    health: () => Promise<AgoraHealth>
    /** One agent's memory, its archive, and whether reflection is due (ADR-0006). */
    memory: (agentId: string) => Promise<MemoryView>
    /**
     * Recall, on the same path and the same rungs `eph-recall` uses. The
     * response carries which rung answered and why it was not a higher one, so
     * the panel can show the ladder rather than implying the best one.
     */
    recall: (query: string, scope: string | null, limit: number) => Promise<RecallResponse>
    /** The Architect's reference shelf (FR-6.4). */
    knowledge: () => Promise<readonly KnowledgeDoc[]>
    /** Registers one reference document; the file goes through the committer. */
    registerKnowledge: (name: string, text: string) => Promise<readonly KnowledgeDoc[]>
  }
  commands: {
    /** Agents currently holding unsent Architect text. */
    list: () => Promise<readonly CommandState[]>
    /**
     * Sends a free prompt to an agent, or holds it until the agent is idle
     * (FR-1.3). Resolves with what the harness did with it.
     */
    submit: (agentId: string, text: string) => Promise<CommandState>
    /** Subscribe to held-text changes. Returns an unsubscribe function. */
    onChange: (cb: (state: CommandState) => void) => () => void
  }
  /**
   * Write-only credential management (ADR-0010, SDD §5). Every method here
   * either takes a value or returns presence — none returns a stored value,
   * and none ever will: "show me my key" is impossible by design, and the
   * Architect re-pastes from the provider console when in doubt.
   */
  secrets: {
    set: (name: string, value: string) => Promise<SecretStatus>
    status: (name: string) => Promise<SecretStatus>
    /** Can the broker still retrieve this credential? ok|fail, never a value. */
    test: (name: string) => Promise<SecretTest>
    delete: (name: string) => Promise<SecretStatus>
  }
  /** The Watch (SDD §5 `watch:`). Breaker state follows in M3.5. */
  watch: {
    /**
     * Per-agent spend, session and cumulative side by side (ADR-0011). Every
     * figure is folded from the durable ledger at call time — there is no
     * in-memory counter for a restart to zero (invariant §11).
     */
    budgets: () => Promise<readonly AgentSpend[]>
    /** Gates waiting on the Architect, oldest first (UC-08). */
    approvals: () => Promise<readonly OpenGate[]>
    /**
     * Records a verdict from the app window — always the `local` channel,
     * which main stamps itself. There is deliberately no way to claim another
     * channel from here: voice and remote verdicts arrive on the Herald (M6)
     * and Harbor (M7) paths inside main (NFR-9).
     *
     * Resolves with the refusal reason when the verdict could not be taken.
     */
    approve: (
      gateId: string,
      verdict: GateVerdict
    ) => Promise<{ readonly ok: boolean; readonly reason: string | null }>
    /**
     * Mail Hermes diverted to the Architect's own queue at `agora/human/`
     * (FR-3.7): `to:"human"` before Artemis exists, plus hop-cap diversions.
     * It accumulated with no reader from M2 until this surface; the approvals
     * post is where the Architect actually looks.
     */
    humanQueue: () => Promise<readonly Message[]>
    /**
     * Archives one message from the Architect's queue, the same way an agent's
     * inbox is consumed (atomic rename into `.done/`, ADR-0003). Resolves
     * false when it was already gone — a second click on a stale render is not
     * an error.
     */
    dismiss: (messageId: string) => Promise<boolean>
    /** Subscribe to "a gate opened or closed"; the view then re-reads. */
    onGateChange: (cb: () => void) => () => void
    /**
     * Per-agent breaker state (ADR-0011): the rung, what is firing, and
     * whether this engine's hook grade weakens the protection — the last of
     * which ADR-0011 requires on the agent card rather than hidden.
     */
    breakerState: () => Promise<readonly BreakerState[]>
  }
  pty: {
    /**
     * Raw keystrokes to a PTY. Prompts go through `commands.submit`; this is
     * the Architect operating the engine's own interface (FR-1.3).
     */
    write: (id: string, data: string) => Promise<void>
    resize: (id: string, cols: number, rows: number) => Promise<void>
    /** Subscribe to output bytes for one pty id. Returns an unsubscribe function. */
    onData: (id: string, cb: (data: string) => void) => () => void
    /** Subscribe to process exit for one pty id. Returns an unsubscribe function. */
    onExit: (id: string, cb: (exitCode: number) => void) => () => void
  }
}
