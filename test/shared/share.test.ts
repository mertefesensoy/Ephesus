import { describe, expect, it } from 'vitest'
import {
  SHARE_SCHEMA_VERSION,
  filesOf,
  inspectImport,
  manifestOfHire,
  manifestOfProfile,
  payloadOf,
  type InstalledFacts,
  type ShareEnvelope
} from '../../src/shared/share'
import { parseProfile, type ProfileFiles } from '../../src/shared/profile'
import { GATE_KINDS } from '../../src/shared/gates'
import { ORG_SCHEMA_VERSION, type HireTemplate } from '../../src/shared/org'

/**
 * Sharing hires and profiles (FR-10.4, ADR-0012 — M7.6).
 *
 * The package owes three refusals by name — a secret, an undeclared env grant,
 * a widened autonomy level — plus a lossless round trip. All four are here,
 * and each refusal is asserted for the REASON it gives, not merely for failing:
 * a check that refuses everything would pass a test that only asserted `ok`
 * is false.
 *
 * The risk line is the frame: an imported profile is UNTRUSTED CONTENT and may
 * not raise its own privileges on the way in.
 */

const HIRE: HireTemplate = {
  schemaVersion: ORG_SCHEMA_VERSION,
  name: 'triage-agent',
  version: 1,
  role: 'triage-agent',
  engine: 'claude',
  capabilities: ['triage'],
  envGrants: ['GH_TOKEN'],
  brief: 'You run the front desk.'
}

interface MutableFiles extends Omit<ProfileFiles, 'hires' | 'triggers' | 'playbooks'> {
  profileJson: string
  hires: Map<string, string>
  triggers: Map<string, string>
  playbooks: Map<string, string>
}

function bundleFiles(over: Partial<Record<string, unknown>> = {}): MutableFiles {
  const autonomy = (over.autonomy as Record<string, string>) ?? { outbound: 'manual' }
  const grants = (over.envGrants as string[]) ?? ['GH_TOKEN']
  return {
    name: 'shared-crew',
    profileJson: JSON.stringify({
      schemaVersion: 1,
      name: 'shared-crew',
      version: 1,
      target: { kind: 'repo' },
      autonomy: { default: 'supervised', byKind: autonomy }
    }),
    hires: new Map([['triage-agent.json', JSON.stringify({ ...HIRE, envGrants: grants })]]),
    triggers: new Map([
      [
        'sweep.json',
        JSON.stringify({
          id: 'sweep',
          kind: 'schedule',
          everyMs: 900000,
          hire: 'triage-agent',
          playbook: 'triage.md'
        })
      ]
    ]),
    playbooks: new Map([['triage.md', '# Triage\n\nRead the issue.\n']]),
    memoPolicyJson: JSON.stringify({ schemaVersion: 1, requires: ['new-dependency'] }),
    harborJson: JSON.stringify({
      schemaVersion: 1,
      repos: [{ id: 'app', remote: 'owner/app' }],
      channels: [],
      webhooks: []
    })
  }
}

/** An honest export: the manifest is derived from the payload it ships with. */
function envelopeFor(files: ProfileFiles): ShareEnvelope {
  const manifest = manifestOfProfile(files)
  if (manifest === null) throw new Error('fixture bundle does not validate')
  return {
    schemaVersion: SHARE_SCHEMA_VERSION,
    kind: 'profile',
    exportedAt: '2026-08-31T12:00:00.000Z',
    manifest,
    profile: payloadOf(files)
  }
}

/** Serializes anything — these cases exist to feed a validator bad input. */
const blobOf = (envelope: unknown): string => JSON.stringify(envelope)

describe('export → import round-trips losslessly', () => {
  it('returns byte-identical files', () => {
    const files = bundleFiles()
    const result = inspectImport(blobOf(envelopeFor(files)))
    expect(result.ok).toBe(true)
    if (!result.ok || result.payload === null) throw new Error('expected a profile payload')

    const back = filesOf(result.payload)
    // Byte-for-byte, because ADR-0012's claim is that a shared profile is
    // diffable in review. A round trip that reformatted the JSON would give a
    // reviewer a diff of this build's serializer instead of the author's file.
    expect(back.profileJson).toBe(files.profileJson)
    expect(back.memoPolicyJson).toBe(files.memoPolicyJson)
    expect(back.harborJson).toBe(files.harborJson)
    expect([...back.hires]).toEqual([...files.hires])
    expect([...back.triggers]).toEqual([...files.triggers])
    expect([...back.playbooks]).toEqual([...files.playbooks])
  })

  it('carries a bundle that still parses on the other side', () => {
    const result = inspectImport(blobOf(envelopeFor(bundleFiles())))
    if (!result.ok || result.payload === null) throw new Error('expected a profile payload')
    expect(parseProfile(filesOf(result.payload)).ok).toBe(true)
  })

  it('round-trips a hire template', () => {
    const envelope: ShareEnvelope = {
      schemaVersion: SHARE_SCHEMA_VERSION,
      kind: 'hire',
      exportedAt: '2026-08-31T12:00:00.000Z',
      manifest: manifestOfHire(HIRE),
      hire: HIRE
    }
    const result = inspectImport(blobOf(envelope))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.hire).toEqual(HIRE)
    expect(result.payload).toBeNull()
  })
})

describe('a bundle carrying a secret is refused, and the secret is not quoted back', () => {
  it('refuses a credential hidden in a hire brief', () => {
    const files = bundleFiles()
    const leaked = `${'ghp' + '_'}abcdefghijklmnopqrstuvwxyz0123`
    files.hires.set(
      'triage-agent.json',
      JSON.stringify({ ...HIRE, brief: `Use the token ${leaked} when you push.` })
    )
    const result = inspectImport(blobOf(envelopeFor(files)))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reasons.join(' ')).toMatch(/a GitHub token/)
    // Refusing by NAME, never by quoting: a reason carrying the credential
    // would copy it into the log and any bug report it is pasted into.
    expect(result.reasons.join(' ')).not.toContain(leaked)
  })

  it('refuses a credential hidden in a playbook, not just in the JSON', () => {
    const files = bundleFiles()
    files.playbooks.set('triage.md', `# Triage\n\nexport KEY=${'AKI' + 'A'}ABCDEFGHIJKLMNOP\n`)
    const result = inspectImport(blobOf(envelopeFor(files)))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons.join(' ')).toMatch(/an AWS access key id/)
  })

  it('accepts env grant NAMES, which are the legal thing to carry', () => {
    // ADR-0010: names the broker resolves, never values.
    const files = bundleFiles({ envGrants: ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY'] })
    expect(inspectImport(blobOf(envelopeFor(files))).ok).toBe(true)
  })
})

describe('a manifest that disagrees with its payload is refused', () => {
  it('refuses an UNDECLARED env grant', () => {
    const files = bundleFiles({ envGrants: ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY'] })
    const envelope = envelopeFor(files)
    // The disclosure the human reads omits the second grant. This is the check
    // that makes the confirmation a gate rather than a decoration.
    const manifest = { ...envelope.manifest, envGrants: ['GH_TOKEN'] }
    const result = inspectImport(blobOf({ ...envelope, manifest }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(' ')).toMatch(
        /asks for the env grant "AWS_SECRET_ACCESS_KEY", which its manifest does not declare/
      )
    }
  })

  it('refuses an autonomy level the manifest understates', () => {
    const files = bundleFiles({ autonomy: { outbound: 'autonomous' } })
    const envelope = envelopeFor(files)
    const manifest = {
      ...envelope.manifest,
      autonomy: envelope.manifest.autonomy.map((row) =>
        row.kind === 'outbound' ? { ...row, level: 'manual' } : row
      )
    }
    const result = inspectImport(blobOf({ ...envelope, manifest }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(' ')).toMatch(
        /declares "manual" autonomy for outbound and the bundle requests "autonomous"/
      )
    }
  })

  it('declares EVERY gate class, so a permissive default cannot arrive undisclosed', () => {
    // The bundle names only `outbound`; the rest take its `supervised` default.
    // A manifest listing only the explicit overrides would have hidden that.
    const manifest = manifestOfProfile(bundleFiles())
    expect(manifest?.autonomy.map((row) => row.kind).sort()).toEqual([...GATE_KINDS].sort())
    expect(manifest?.autonomy.find((row) => row.kind === 'destructive')?.level).toBe('supervised')
  })

  it('refuses a manifest hiding a trigger, a playbook or a repository', () => {
    const envelope = envelopeFor(bundleFiles())
    for (const field of ['triggers', 'playbooks', 'repos'] as const) {
      const result = inspectImport(
        blobOf({ ...envelope, manifest: { ...envelope.manifest, [field]: [] } })
      )
      expect(result.ok).toBe(false)
    }
  })

  it('refuses a manifest that names a different profile than it ships', () => {
    const envelope = envelopeFor(bundleFiles())
    const result = inspectImport(
      blobOf({ ...envelope, manifest: { ...envelope.manifest, name: 'something-friendly' } })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons.join(' ')).toMatch(/the manifest names/)
  })
})

describe('an import may not widen what a trusted name already has', () => {
  const installed: InstalledFacts = {
    envGrants: ['GH_TOKEN'],
    autonomy: GATE_KINDS.map((kind) => ({ kind, level: 'manual' as const }))
  }

  it('refuses a raise of an existing profile’s autonomy', () => {
    const files = bundleFiles({ autonomy: { outbound: 'autonomous' } })
    const result = inspectImport(blobOf(envelopeFor(files)), installed)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(' ')).toMatch(
        /would raise outbound autonomy for "shared-crew" from "manual" to "autonomous"/
      )
    }
  })

  it('refuses a NEW env grant on an existing profile', () => {
    const files = bundleFiles({ envGrants: ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY'] })
    const result = inspectImport(blobOf(envelopeFor(files)), installed)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reasons.join(' ')).toMatch(
        /would add the env grant "AWS_SECRET_ACCESS_KEY" to "shared-crew"/
      )
    }
  })

  it('allows an import that keeps or NARROWS what is installed', () => {
    const permissive: InstalledFacts = {
      envGrants: ['GH_TOKEN', 'AWS_SECRET_ACCESS_KEY'],
      autonomy: GATE_KINDS.map((kind) => ({ kind, level: 'autonomous' as const }))
    }
    // Narrowing is not a privilege escalation, so it is not this check's
    // business to refuse it — a shared bundle that tightens a profile is
    // exactly what a security fix looks like.
    expect(inspectImport(blobOf(envelopeFor(bundleFiles())), permissive).ok).toBe(true)
  })

  it('says the import REPLACES something, so a human is told', () => {
    const result = inspectImport(blobOf(envelopeFor(bundleFiles())), installed)
    // With `installed` non-null and nothing widened, the flag must be set —
    // overwriting a profile the Architect already trusts is a fact the
    // confirmation screen has to show even when nothing grew.
    const narrowing: InstalledFacts = {
      envGrants: ['GH_TOKEN'],
      autonomy: GATE_KINDS.map((kind) => ({ kind, level: 'autonomous' as const }))
    }
    const ok = inspectImport(blobOf(envelopeFor(bundleFiles())), narrowing)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.replaces).toBe(true)
    void result
  })

  it('treats a first-time import as new, not as a replacement', () => {
    const result = inspectImport(blobOf(envelopeFor(bundleFiles())), null)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.replaces).toBe(false)
  })
})

describe('a malformed import is refused rather than partly honoured', () => {
  it('refuses a blob that is not JSON', () => {
    expect(inspectImport('not json').ok).toBe(false)
    expect(inspectImport('').ok).toBe(false)
  })

  it('refuses an envelope with an unknown field', () => {
    const envelope = envelopeFor(bundleFiles())
    expect(inspectImport(blobOf({ ...envelope, autoActivate: true })).ok).toBe(false)
  })

  it('refuses a kind whose payload is missing', () => {
    const envelope = envelopeFor(bundleFiles())
    const { profile: _dropped, ...withoutPayload } = envelope
    void _dropped
    const result = inspectImport(JSON.stringify(withoutPayload))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons.join(' ')).toMatch(/no bundle is present/)
  })

  it('refuses a bundle that does not validate against the frozen schema', () => {
    const files = bundleFiles()
    files.profileJson = JSON.stringify({ schemaVersion: 1, name: 'shared-crew' })
    const envelope = {
      schemaVersion: SHARE_SCHEMA_VERSION,
      kind: 'profile' as const,
      exportedAt: '2026-08-31T12:00:00.000Z',
      // Hand-written manifest, since the bundle cannot be summarized.
      manifest: {
        kind: 'profile' as const,
        name: 'shared-crew',
        envGrants: [],
        hires: [],
        autonomy: [],
        triggers: [],
        playbooks: [],
        repos: []
      },
      profile: payloadOf(files)
    }
    expect(inspectImport(blobOf(envelope)).ok).toBe(false)
  })
})

/**
 * Regressions for two defects an adversarial pass found in this module before
 * it shipped. Both are privilege escalations that the obvious implementation
 * has, and neither is visible from a happy-path test.
 */
describe('an imported bundle cannot escape its own directory', () => {
  it('refuses a file name that escapes the bundle directory', () => {
    // `install` writes with `path.join(dir, 'playbooks', name)`, and join
    // resolves `..` — so this name would have landed on the harness's
    // gate-policy.json, which SDD §2 says "can only ever loosen, never
    // tighten". Overwriting it with `autonomy: "autonomous"` turns the entire
    // approval system off.
    const files = bundleFiles()
    files.playbooks.set(
      '../../../gate-policy.json',
      '{"schemaVersion":1,"autonomy":"autonomous","rules":[]}'
    )
    const envelope = {
      schemaVersion: SHARE_SCHEMA_VERSION,
      kind: 'profile' as const,
      exportedAt: '2026-08-31T12:00:00.000Z',
      manifest: manifestOfProfile(files),
      profile: payloadOf(files)
    }
    expect(inspectImport(blobOf(envelope)).ok).toBe(false)
  })

  it('refuses every shape of path in a file name', () => {
    for (const name of ['../x.md', 'a/b.md', 'a\b.md', '/etc/passwd.md', '..md', 'x.md/../y.md']) {
      const files = bundleFiles()
      files.playbooks.set(name, '# x\n')
      const envelope = {
        schemaVersion: SHARE_SCHEMA_VERSION,
        kind: 'profile' as const,
        exportedAt: '2026-08-31T12:00:00.000Z',
        manifest: manifestOfProfile(files),
        profile: payloadOf(files)
      }
      expect(inspectImport(blobOf(envelope)).ok, `accepted "${name}"`).toBe(false)
    }
  })

  it('still accepts an ordinary bare file name', () => {
    const files = bundleFiles()
    files.playbooks.set('escalation.md', '# Escalation\n')
    expect(inspectImport(blobOf(envelopeFor(files))).ok).toBe(true)
  })
})

describe('the secret scan reads what the payload MEANS, not how it is spelled', () => {
  it('catches a credential written with JSON unicode escapes', () => {
    // Scanning the raw blob text is the obvious implementation and it misses
    // this: the raw JSON never contains the token, but `JSON.parse` decodes it
    // into a real one.
    const token = `${'ghp' + '_'}${'A'.repeat(20)}`
    const backslash = String.fromCharCode(92)
    const escaped = [...token]
      .map((char) => `${backslash}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('')

    const files = bundleFiles()
    const envelope = envelopeFor(files)
    const blob = JSON.stringify(envelope).replace(
      JSON.stringify(files.playbooks.get('triage.md')),
      `"${escaped}"`
    )

    // The premise of the regression, asserted so it cannot rot into a test
    // that passes for the wrong reason.
    expect(blob).not.toContain(token)
    expect(JSON.parse(blob).profile.playbooks['triage.md']).toContain(token)

    const result = inspectImport(blob)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons.join(' ')).toMatch(/a GitHub token/)
  })

  it('catches a credential hidden in an object KEY, and says so', () => {
    const files = bundleFiles()
    const envelope = envelopeFor(files)
    const blob = JSON.stringify({
      ...envelope,
      manifest: { ...envelope.manifest, [`${'ghp' + '_'}${'B'.repeat(20)}`]: 'x' }
    })
    const result = inspectImport(blob)
    expect(result.ok).toBe(false)
    // The REASON is the assertion. The strict envelope schema would refuse this
    // blob anyway for its unknown key, so a test that only checked `ok` could
    // not tell whether the secret scan looked at keys at all — and "there is a
    // credential in this file" is the fact the Architect actually needs.
    if (!result.ok) expect(result.reasons.join(' ')).toMatch(/a GitHub token/)
  })
})
