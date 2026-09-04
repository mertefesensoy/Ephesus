import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { ProfileInstanceView, ProfileSummary } from '../../shared/profile-view'
import type { ActivationPlan, ComposedAutonomy } from '../../shared/profile-activation'

/**
 * The Profiles tab — the activation desk (ADR-0012, FR-9.1/9.4, UI-DESIGN §4).
 *
 * ADR-0012 chose declarative bundles for one reason above the others: so an
 * Architect can **read what a profile may do before activating it**. That
 * sentence is a promise about a SCREEN, and until this panel there was none —
 * the loader, the plan, the composition and the IPC all shipped across M7.1 and
 * M7.2 with no renderer caller, which meant the safety story ADR-0012 is built
 * on could not actually be read by anybody.
 *
 * So the shape of this panel is not a layout choice. It is the disclosure:
 *
 * - **Nothing activates without a preview first.** `activate` is not reachable
 *   from a listed profile; it is reachable only from a plan the Architect has
 *   on screen. The same `activationPlan` produces the preview and executes the
 *   activation (M7.2), so what is shown is what runs — not a second rendering
 *   of it that could drift.
 * - **Clamped autonomy is shown, not swallowed.** Where a bundle asked for more
 *   than the global policy allows, the row says so. A profile that wanted
 *   `autonomous` and was cut to `supervised` is a fact about the bundle you are
 *   deciding to trust.
 * - **An invalid bundle keeps its row**, with its reasons. A profile that
 *   vanished when its JSON broke would look uninstalled, and the Architect
 *   would go hunting for a missing directory instead of a missing comma.
 * - **Event triggers are listed as NOT ARMED.** Nothing publishes `webhook`,
 *   `ci` or `health` into the scheduler, so a screen that showed them as live
 *   watchers would be describing duty nobody is on.
 */

const REFRESH_MS = 5_000

/** What the target form holds, before it becomes an activation request. */
export interface TargetFields {
  readonly kind: 'repo' | 'app'
  readonly id: string
  readonly path: string
}

export const EMPTY_TARGET: TargetFields = { kind: 'repo', id: '', path: '' }

/**
 * Contract: pure. True when the form holds enough to ask for a preview.
 *
 * Exported and tested because the alternative is a disabled-button expression
 * inside a component, which is exactly where the M5b.1 pin defect lived — a
 * one-line mapping nobody could reach with a table test.
 */
export function targetReady(fields: TargetFields): boolean {
  return fields.id.trim().length > 0 && fields.path.trim().length > 0
}

/**
 * Contract: pure. The `owner/repo` slugs in a line the Architect typed.
 *
 * Split on commas and whitespace, trimmed, blanks dropped, order and
 * duplicates preserved-then-deduplicated — a paste from a browser tab is the
 * expected input, so `owner/repo, owner/other` and `owner/repo owner/other`
 * both work. NOT validated here: main validates against the same schema the
 * Harbor uses, and a renderer that pre-judged would be a second opinion that
 * can drift from the one that decides.
 *
 * Exported because the alternative is an expression inside a component, which
 * is where the M5b.1 pin defect lived.
 */
export function parseRepoList(text: string): readonly string[] {
  const seen: string[] = []
  for (const part of text.split(/[\s,]+/)) {
    const slug = part.trim()
    if (slug.length === 0 || seen.includes(slug)) continue
    seen.push(slug)
  }
  return seen
}

/**
 * Contract: pure. The form as the `profiles:preview`/`activate` request.
 *
 * `repos` is omitted rather than sent empty: the schema's field is optional and
 * an empty array would read as "the Architect chose no repositories", which is
 * a different statement from "the Architect did not choose" — the first would
 * override a bundle's own declaration with nothing.
 */
export function activationRequest(
  profile: string,
  fields: TargetFields,
  repos = ''
): {
  profile: string
  target: { kind: 'repo' | 'app'; id: string; path: string }
  repos?: string[]
} {
  const chosen = parseRepoList(repos)
  return {
    profile,
    target: { kind: fields.kind, id: fields.id.trim(), path: fields.path.trim() },
    ...(chosen.length > 0 ? { repos: [...chosen] } : {})
  }
}

const panel = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  flex: '1 1 0',
  minWidth: 0,
  border: '2px solid var(--eph-ink-900)',
  boxShadow:
    'inset 0 0 0 1px var(--eph-marble-50), inset 0 0 0 2px var(--eph-ink-700), 2px 2px 0 var(--eph-ink-900)',
  background: 'var(--eph-marble-50)',
  padding: '12px',
  overflowY: 'auto'
} as const

const titleTab = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  display: 'inline-block',
  margin: '-12px 0 12px -12px',
  padding: '4px 8px',
  background: 'var(--eph-ink-900)',
  color: 'var(--eph-marble-50)'
} as const

const card = {
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-parchment-100)',
  padding: '10px',
  marginBottom: '8px'
} as const

const button = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  padding: '4px 8px',
  marginRight: '4px',
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-marble-200)'
} as const

const field = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px',
  marginBottom: '4px',
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-marble-50)',
  color: 'var(--eph-ink-900)'
} as const

/**
 * A remembered target. Deliberately quieter than `button`: choosing one fills
 * the form, and the thing that activates is still the same two-step read-then-
 * activate below it. A chip that looked like the activate button would be
 * offering an approval it does not carry.
 */
const chip = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '11px',
  padding: '1px 6px',
  marginRight: '4px',
  border: '1px solid var(--eph-ink-500)',
  background: 'var(--eph-marble-200)',
  color: 'var(--eph-ink-900)'
} as const

const note = { color: 'var(--eph-ink-500)', margin: '4px 0' } as const

const warn = { color: 'var(--eph-wine)', margin: '4px 0' } as const

const heading = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  margin: '12px 0 6px'
} as const

/**
 * One autonomy row. Presentational and exported so the render harness can read
 * the branch that only appears with data: the CLAMPED marker.
 */
export function AutonomyRow({ row }: { readonly row: ComposedAutonomy }): ReactElement {
  return (
    <li style={{ margin: '2px 0' }}>
      <span>{row.kind}: </span>
      <strong>{row.effective}</strong>
      {row.clamped ? (
        <span style={{ color: 'var(--eph-wine)' }}>
          {' '}
          (asked for {row.requested}, cut back by the global {row.global})
        </span>
      ) : null}
    </li>
  )
}

/**
 * The plan, rendered as the disclosure ADR-0012 promises.
 *
 * Every section answers "what would this be allowed to do". Presentational and
 * exported, so a test can assert the screen actually SHOWS the grants and the
 * clamped rows rather than asserting that a function returned them.
 */
export function PlanView({ plan }: { readonly plan: ActivationPlan }): ReactElement {
  // On the structured binding, not on the label the same object renders for
  // humans — the incident path already paid for keying on `when`.
  const armed = plan.triggers.filter((trigger) => trigger.everyMs !== null)
  const unarmed = plan.triggers.filter((trigger) => trigger.everyMs === null)
  return (
    <div style={card}>
      <p style={{ margin: '0 0 6px' }}>
        <strong>{plan.profile}</strong> v{plan.profileVersion} on {plan.targetRef}
      </p>

      <p style={heading}>It would hire</p>
      <ul style={{ margin: '0 0 0 16px', padding: 0 }}>
        {plan.hires.map((hire) => (
          <li key={hire.agentId} style={{ margin: '2px 0' }}>
            {hire.agentId} — {hire.spawn.role} on {hire.spawn.engine} ({hire.hireRef})
          </li>
        ))}
      </ul>

      <p style={heading}>It would hold these secrets</p>
      {plan.envGrants.length === 0 ? (
        <p style={note}>none</p>
      ) : (
        <p style={{ margin: '4px 0' }}>{plan.envGrants.join(', ')}</p>
      )}
      {plan.grantsUnavailable.length > 0 && (
        // A promise the broker cannot keep, said out loud BEFORE activation
        // rather than discovered as a missing variable at spawn (M8.4).
        <p style={warn}>
          the broker cannot supply {plan.grantsUnavailable.join(', ')} — those hires will start
          without them
        </p>
      )}

      <p style={heading}>It may act at</p>
      <ul style={{ margin: '0 0 0 16px', padding: 0 }}>
        {plan.autonomy.map((row) => (
          <AutonomyRow key={row.kind} row={row} />
        ))}
      </ul>

      <p style={heading}>It would arm</p>
      {armed.length === 0 ? (
        <p style={note}>no scheduled triggers</p>
      ) : (
        <ul style={{ margin: '0 0 0 16px', padding: 0 }}>
          {armed.map((trigger) => (
            <li key={trigger.id} style={{ margin: '2px 0' }}>
              {trigger.id}: {trigger.when} → {trigger.agentId} follows {trigger.playbook}
            </li>
          ))}
        </ul>
      )}
      {unarmed.length > 0 ? (
        <p style={warn}>
          declared but NOT armed — nothing publishes these events yet:{' '}
          {unarmed.map((trigger) => `${trigger.id} (${trigger.when})`).join(', ')}
        </p>
      ) : null}

      <p style={heading}>It would watch</p>
      {plan.repos.length === 0 ? (
        // The condition that made the flagship mission inert on first use, said
        // out loud BEFORE the Architect activates it (M8.5, B7). It used to
        // read "add them to the bundle's harbor.json", which described the fix
        // for a problem the screen never said you had.
        <p style={warn}>nothing — {plan.reposBecause}</p>
      ) : (
        <>
          <p style={{ margin: '4px 0' }}>{plan.repos.join(', ')}</p>
          {/* Where it came from, so a repository the Architect chose reads
              differently from one the harness read off the checkout. */}
          <p style={note}>{plan.reposBecause}</p>
        </>
      )}

      <p style={heading}>It holds these for a memo</p>
      <p style={{ margin: '4px 0' }}>
        {plan.memoRequires.length === 0 ? 'none' : plan.memoRequires.join(', ')}
      </p>

      <p style={heading}>Its agents read</p>
      <p style={{ margin: '4px 0' }}>
        {plan.playbooks.length === 0 ? 'no playbooks' : plan.playbooks.join(', ')}
      </p>
    </div>
  )
}

/** One live instance, with the agents it put on the floor. */
export function InstanceRow({
  instance,
  onDeactivate
}: {
  readonly instance: ProfileInstanceView
  readonly onDeactivate: (instanceId: string) => void
}): ReactElement {
  return (
    <div style={card}>
      <p style={{ margin: '0 0 4px' }}>
        <strong>{instance.instanceId}</strong>
      </p>
      <p style={note}>
        {instance.agentIds.length} agent(s); {instance.armed.length} trigger(s) armed
      </p>
      {instance.pendingEvents.length > 0 ? (
        <p style={warn}>
          waiting on events nothing publishes:{' '}
          {instance.pendingEvents.map((pending) => `${pending.id} (${pending.event})`).join(', ')}
        </p>
      ) : null}
      <button
        type="button"
        style={button}
        onClick={() => {
          onDeactivate(instance.instanceId)
        }}
      >
        DEACTIVATE
      </button>
    </div>
  )
}

export function ProfilesPanel(): ReactElement {
  const [rows, setRows] = useState<readonly ProfileSummary[]>([])
  const [instances, setInstances] = useState<readonly ProfileInstanceView[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [target, setTarget] = useState<TargetFields>(EMPTY_TARGET)
  /** The Architect's repository override, empty on the normal path (M8.5). */
  const [repos, setRepos] = useState('')
  const [plan, setPlan] = useState<ActivationPlan | null>(null)
  const [reasons, setReasons] = useState<readonly string[]>([])

  const refresh = useCallback(() => {
    // No bridge means the preload did not load; the shell shows that banner.
    const eph = window.eph
    if (!eph) return
    void eph.profiles.list().then(setRows)
    void eph.profiles.instances().then(setInstances)
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => {
      clearInterval(timer)
    }
  }, [refresh])

  /**
   * Points the form at a different target, dropping any repository override
   * typed for the previous one (M8.5).
   *
   * An override is an answer about ONE checkout — the fork the derivation
   * refused to choose between. Letting it follow the Architect to another
   * target is how the company ends up watching the wrong repository, which is
   * the exact outcome `deriveRepo` refuses to risk by guessing. Clearing it on
   * any edit to the target is blunt, and blunt in the safe direction: the plan
   * is re-read before anything is activated, so a cleared box is visible.
   */
  const retarget = useCallback(
    (next: TargetFields) => {
      if (next.kind !== target.kind || next.id !== target.id || next.path !== target.path) {
        setRepos('')
      }
      setTarget(next)
    },
    [target]
  )

  const preview = useCallback(
    (name: string) => {
      const eph = window.eph
      if (!eph) return
      setSelected(name)
      setPlan(null)
      setReasons([])
      void eph.profiles.preview(activationRequest(name, target, repos)).then((result) => {
        if (result.ok) setPlan(result.plan)
        else setReasons(result.reasons)
      })
    },
    [target, repos]
  )

  const activate = useCallback(() => {
    const eph = window.eph
    if (!eph || selected === null) return
    void eph.profiles.activate(activationRequest(selected, target, repos)).then((result) => {
      if (!result.ok) setReasons(result.reasons)
      else {
        setPlan(null)
        setSelected(null)
        setReasons([])
        // The next activation starts from what the checkout says, not from an
        // override typed for the one that just went live.
        setRepos('')
      }
      refresh()
    })
  }, [selected, target, repos, refresh])

  const deactivate = useCallback(
    (instanceId: string) => {
      const eph = window.eph
      if (!eph) return
      void eph.profiles.deactivate(instanceId).then(() => {
        refresh()
      })
    },
    [refresh]
  )

  return (
    <section style={panel} aria-label="Profiles">
      <h2 style={titleTab}>PROFILES</h2>

      <p style={heading}>Target</p>
      <select
        style={field}
        aria-label="target kind"
        value={target.kind}
        onChange={(event) => {
          retarget({ ...target, kind: event.target.value === 'app' ? 'app' : 'repo' })
        }}
      >
        <option value="repo">repo</option>
        <option value="app">app</option>
      </select>
      <input
        style={field}
        aria-label="target id"
        placeholder="id, e.g. myapp"
        value={target.id}
        onChange={(event) => {
          retarget({ ...target, id: event.target.value })
        }}
      />
      <input
        style={field}
        aria-label="target path"
        placeholder="absolute path to the working copy"
        value={target.path}
        onChange={(event) => {
          retarget({ ...target, path: event.target.value })
        }}
      />
      {/* Left empty on the normal path: the checkout's own remote answers this
          (M8.5). It exists because a derivation can be REFUSED — a fork has two
          remotes and two answers, and guessing between them would be the
          harness deciding whose repository the company files incidents against.
          The preview below always says which of the two happened. */}
      <input
        style={field}
        aria-label="repositories to watch"
        placeholder="repositories to watch — leave empty to read the target's remote"
        value={repos}
        onChange={(event) => {
          setRepos(event.target.value)
        }}
      />

      <p style={heading}>Available</p>
      {rows.length === 0 ? <p style={note}>no profiles installed</p> : null}
      {rows.map((row) => (
        <div key={row.name} style={card}>
          <p style={{ margin: '0 0 4px' }}>
            <strong>{row.name}</strong>{' '}
            <span style={note}>
              ({row.source}
              {row.version === null ? '' : `, v${String(row.version)}`})
            </span>
          </p>
          {row.knownTargets.length > 0 ? (
            <p style={{ margin: '0 0 4px' }}>
              <span style={note}>used before: </span>
              {row.knownTargets.map((known) => (
                <button
                  key={`${known.kind}:${known.id}`}
                  type="button"
                  style={chip}
                  title={known.path}
                  onClick={() => {
                    // Fills the form and nothing else. Preview and activate
                    // still run exactly as they do for a typed path — a
                    // remembered target is a convenience, never an approval.
                    retarget({
                      kind: known.kind === 'app' ? 'app' : 'repo',
                      id: known.id,
                      path: known.path
                    })
                  }}
                >
                  {known.kind}:{known.id}
                </button>
              ))}
            </p>
          ) : null}
          {row.valid ? (
            <button
              type="button"
              style={button}
              disabled={!targetReady(target)}
              onClick={() => {
                preview(row.name)
              }}
            >
              READ WHAT IT MAY DO
            </button>
          ) : (
            // Kept on the list rather than hidden: a profile that disappeared
            // when its JSON broke would look uninstalled (invariant §7).
            <p style={warn}>this bundle does not validate and cannot be activated</p>
          )}
        </div>
      ))}

      {reasons.length > 0 ? (
        <>
          <p style={heading}>Refused</p>
          <ul style={{ margin: '0 0 0 16px', padding: 0, color: 'var(--eph-wine)' }}>
            {reasons.map((reason) => (
              <li key={reason} style={{ margin: '2px 0' }}>
                {reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {plan !== null ? (
        <>
          <p style={heading}>Before you activate</p>
          <PlanView plan={plan} />
          {/* Activation is reachable only from a plan on screen — never from a
              listed profile — so nothing starts that the Architect has not read. */}
          <button type="button" style={button} onClick={activate}>
            ACTIVATE
          </button>
          <button
            type="button"
            style={button}
            onClick={() => {
              setPlan(null)
              setSelected(null)
            }}
          >
            CANCEL
          </button>
        </>
      ) : null}

      <p style={heading}>On the floor</p>
      {instances.length === 0 ? <p style={note}>nothing activated</p> : null}
      {instances.map((instance) => (
        <InstanceRow key={instance.instanceId} instance={instance} onDeactivate={deactivate} />
      ))}
    </section>
  )
}
