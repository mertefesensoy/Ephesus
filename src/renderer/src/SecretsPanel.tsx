import { useCallback, useState, type ReactElement } from 'react'
import type { SecretStatus, SecretTest } from '../../shared/secrets'

/**
 * The broker's one surface (ADR-0010, FR-11.4).
 *
 * Until this existed the broker was reachable from nowhere: `secrets:set` was
 * wired through main and exposed on the preload bridge, and no component in the
 * app ever called it — so an agent whose role declared `GH_TOKEN` spawned with
 * `grantsMissing: ["GH_TOKEN"]` every time and there was no place to fix it.
 *
 * Write-only by construction, and that is the whole design:
 *
 *  - a value travels renderer→main and never the other way (there is no
 *    `secrets:get` channel, and a test fails if a fifth channel appears);
 *  - the input is a password field, cleared the moment it is submitted, so the
 *    value is never in the DOM after the write and never in a screenshot;
 *  - what the Architect gets back is presence and a rotation date. Not a
 *    prefix, not a length, not a masked echo — those leak, and they are the
 *    reason people think masking is safe.
 */

/**
 * Names this company is known to want. Convenience only: any name matching the
 * broker's pattern can be typed, and the quick-picks are just the ones the
 * built-in profiles declare as `envGrants` so nobody has to remember spelling.
 */
const KNOWN_NAMES = ['GH_TOKEN', 'GH_APP_PRIVATE_KEY'] as const

/** The broker's own rule, restated so the field can refuse before the round trip. */
const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/

/** Contract: pure. True when `name` is a name the broker would accept. */
export function secretNameOk(name: string): boolean {
  return name.length > 0 && name.length <= 64 && NAME_PATTERN.test(name)
}

/** Contract: pure. What the Architect is told about a secret they asked about. */
export function describeStatus(status: SecretStatus | null): string {
  if (status === null) return 'not checked'
  if (!status.present) return 'not set'
  return status.lastRotated === null
    ? 'set'
    : `set · last written ${status.lastRotated.slice(0, 16).replace('T', ' ')}`
}

const heading = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  fontWeight: 'normal',
  margin: '12px 0 6px'
} as const

const field = {
  fontFamily: 'var(--eph-face-data)',
  fontSize: '12px',
  padding: '3px 6px',
  border: '1px solid var(--eph-ink-700)',
  background: 'var(--eph-parchment-100)',
  color: 'var(--eph-ink-900)',
  marginRight: '4px'
} as const

const control = {
  fontFamily: 'var(--eph-face-display)',
  fontSize: '8px',
  padding: '4px 8px',
  marginRight: '4px',
  border: '2px solid var(--eph-ink-900)',
  background: 'var(--eph-marble-200)',
  color: 'var(--eph-ink-900)'
} as const

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

export function SecretsPanel(): ReactElement {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<SecretStatus | null>(null)
  const [tested, setTested] = useState<SecretTest | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const look = useCallback((which: string) => {
    setStatus(null)
    setTested(null)
    setProblem(null)
    const eph = window.eph
    if (!eph || !secretNameOk(which)) return
    void eph.secrets.status(which).then(setStatus, (err: unknown) => {
      setProblem(err instanceof Error ? err.message : String(err))
    })
  }, [])

  const save = useCallback(() => {
    const eph = window.eph
    if (!eph || !secretNameOk(name) || value.length === 0) return
    const written = value
    // Cleared before the await resolves: the value must not sit in component
    // state waiting on a round trip.
    setValue('')
    setTested(null)
    setProblem(null)
    void eph.secrets.set(name, written).then(setStatus, (err: unknown) => {
      setProblem(err instanceof Error ? err.message : String(err))
    })
  }, [name, value])

  return (
    <div>
      <p style={heading}>Credentials</p>
      <p style={note}>
        Written, never read back. Agents receive these by name at spawn, and only the roles whose
        hire declares the grant.
      </p>

      <p style={{ margin: '0 0 6px' }}>
        {KNOWN_NAMES.map((known) => (
          <button
            key={known}
            type="button"
            style={chip}
            onClick={() => {
              setName(known)
              look(known)
            }}
          >
            {known}
          </button>
        ))}
      </p>

      <p style={{ margin: '0 0 6px' }}>
        <input
          style={{ ...field, width: '200px' }}
          value={name}
          placeholder="SECRET_NAME"
          aria-label="secret name"
          onChange={(event) => {
            setName(event.target.value)
          }}
          onBlur={() => {
            look(name)
          }}
        />
        <span style={note}>{describeStatus(status)}</span>
      </p>

      <p style={{ margin: '0 0 6px' }}>
        <input
          style={{ ...field, width: '260px' }}
          type="password"
          value={value}
          placeholder="value (write-only)"
          aria-label="secret value"
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value)
          }}
        />
        <button
          type="button"
          style={control}
          disabled={!secretNameOk(name) || value.length === 0}
          onClick={save}
        >
          STORE
        </button>
        <button
          type="button"
          style={control}
          disabled={!secretNameOk(name)}
          onClick={() => {
            const eph = window.eph
            if (!eph) return
            void eph.secrets.test(name).then(setTested, (err: unknown) => {
              setProblem(err instanceof Error ? err.message : String(err))
            })
          }}
        >
          TEST
        </button>
        <button
          type="button"
          style={control}
          disabled={!secretNameOk(name)}
          onClick={() => {
            const eph = window.eph
            if (!eph) return
            void eph.secrets.delete(name).then(setStatus, (err: unknown) => {
              setProblem(err instanceof Error ? err.message : String(err))
            })
          }}
        >
          REVOKE
        </button>
      </p>

      {tested === null ? null : (
        <p style={tested.ok ? note : warn}>
          {tested.ok ? 'the broker can still retrieve it' : `cannot retrieve it: ${tested.reason}`}
        </p>
      )}
      {problem === null ? null : <p style={warn}>{problem}</p>}
    </div>
  )
}
