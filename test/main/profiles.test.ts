import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProfileStore, triggerWakeMessage } from '../../src/main/profiles'
import { PROFILE_ENDPOINT } from '../../src/shared/reserved'
import { PROFILE_SCHEMA_VERSION } from '../../src/shared/profile'
import { ORG_SCHEMA_VERSION } from '../../src/shared/org'

/**
 * The profile store (SDD §1.1 `profiles.ts`, SDD §2, ADR-0012 — M7.1).
 *
 * Real files in real temp directories, per TEST-STRATEGY §1: the fs IS the
 * mechanism here, so mocking it would test nothing. The claims:
 *
 *  - **Loading is pure.** No write, no spawn, no schedule — asserted by taking
 *    a census of the tree before and after, not by reading the code.
 *  - **A broken bundle is refused BY NAME and still LISTED.** A profile that
 *    disappeared when its JSON broke would look uninstalled.
 *  - **Home shadows builtin**, and the list says which one answered.
 */

const homes: string[] = []

afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-profiles-'))
  homes.push(dir)
  return dir
}

interface BundleOptions {
  readonly version?: number
  readonly profileJson?: string
  readonly omit?: readonly string[]
}

/** Writes a complete, valid bundle at `<root>/<name>/`. */
function writeBundle(root: string, name: string, options: BundleOptions = {}): string {
  const dir = path.join(root, name)
  const omit = new Set(options.omit ?? [])
  fs.mkdirSync(path.join(dir, 'hires'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'triggers'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'playbooks'), { recursive: true })

  if (!omit.has('profile.json')) {
    fs.writeFileSync(
      path.join(dir, 'profile.json'),
      options.profileJson ??
        JSON.stringify({
          schemaVersion: PROFILE_SCHEMA_VERSION,
          name,
          version: options.version ?? 1,
          target: { kind: 'repo' },
          autonomy: { default: 'supervised', byKind: { destructive: 'manual' } }
        })
    )
  }
  if (!omit.has('memo-policy.json')) {
    fs.writeFileSync(
      path.join(dir, 'memo-policy.json'),
      JSON.stringify({ schemaVersion: PROFILE_SCHEMA_VERSION, requires: ['new-dependency'] })
    )
  }
  if (!omit.has('harbor.json')) {
    fs.writeFileSync(
      path.join(dir, 'harbor.json'),
      JSON.stringify({
        schemaVersion: PROFILE_SCHEMA_VERSION,
        repos: [{ id: 'myapp', remote: 'octocat/myapp' }],
        channels: [],
        webhooks: []
      })
    )
  }
  fs.writeFileSync(
    path.join(dir, 'hires', 'ci-babysitter.json'),
    JSON.stringify({
      schemaVersion: ORG_SCHEMA_VERSION,
      name: 'ci-babysitter',
      version: 1,
      role: 'ci-babysitter',
      engine: 'claude',
      capabilities: ['ci'],
      envGrants: ['GH_TOKEN'],
      brief: 'Watch the CI runs.',
      budget: { dailyTokens: 500_000 }
    })
  )
  fs.writeFileSync(
    path.join(dir, 'triggers', 'ci-watch.json'),
    JSON.stringify({
      id: 'ci-watch',
      kind: 'event',
      event: 'ci',
      hire: 'ci-babysitter',
      playbook: 'incident.md'
    })
  )
  fs.writeFileSync(path.join(dir, 'playbooks', 'incident.md'), '# Incident\n\nTriage first.\n')
  return dir
}

/** Every file under `dir`, with its bytes — a census to compare against. */
function census(dir: string): readonly string[] {
  const out: string[] = []
  const walk = (at: string): void => {
    for (const entry of fs
      .readdirSync(at, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else out.push(`${path.relative(dir, full)}=${fs.readFileSync(full, 'utf8')}`)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

function store(home: string, builtin: string): ProfileStore {
  return new ProfileStore(path.join(home, 'profiles'), builtin)
}

describe('loading a bundle', () => {
  it('loads a valid bundle and reports where it came from', () => {
    const home = tempRoot()
    const builtin = tempRoot()
    writeBundle(path.join(home, 'profiles'), 'skeleton-crew')

    const loaded = store(home, builtin).load('skeleton-crew')
    if (!loaded.ok) throw new Error(loaded.reasons.join(' · '))
    expect(loaded.source).toBe('home')
    expect(loaded.bundle.document.name).toBe('skeleton-crew')
    expect(loaded.bundle.hires).toHaveLength(1)
    expect(loaded.bundle.playbooks[0]?.file).toBe('incident.md')
  })

  it('refuses a bundle missing a required file, naming the FILE — not a parse error', () => {
    const home = tempRoot()
    writeBundle(path.join(home, 'profiles'), 'skeleton-crew', { omit: ['memo-policy.json'] })

    const loaded = store(home, tempRoot()).load('skeleton-crew')
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.name).toBe('skeleton-crew')
    expect(loaded.reasons.join(' · ')).toContain('memo-policy.json: missing from the bundle')
  })

  it('refuses a name that is not a profile name, without touching the disk', () => {
    const home = tempRoot()
    const loaded = store(home, tempRoot()).load('../../etc')
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.reasons.join(' · ')).toContain('not a legal profile name')
  })

  it('refuses a bundle that is not there, naming both roots it looked in', () => {
    const home = tempRoot()
    const builtin = tempRoot()
    const loaded = store(home, builtin).load('front-office')
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.reasons.join(' · ')).toContain('front-office')
    expect(loaded.reasons.join(' · ')).toContain(builtin)
  })

  it('ignores stray files in hires/, triggers/ and playbooks/ rather than refusing on them', () => {
    // An editor backup or a `.DS_Store` is not a broken hire template.
    const home = tempRoot()
    const dir = writeBundle(path.join(home, 'profiles'), 'skeleton-crew')
    fs.writeFileSync(path.join(dir, 'hires', 'ci-babysitter.json.bak'), 'not json')
    fs.writeFileSync(path.join(dir, 'playbooks', '.DS_Store'), ' ')

    expect(store(home, tempRoot()).load('skeleton-crew').ok).toBe(true)
  })
})

describe('loading is pure — a reader, not an activation', () => {
  it('writes nothing anywhere, for a valid bundle or a broken one', () => {
    const home = tempRoot()
    const builtin = tempRoot()
    writeBundle(path.join(home, 'profiles'), 'skeleton-crew')
    writeBundle(builtin, 'front-office', { profileJson: '{ broken' })

    const before = { home: census(home), builtin: census(builtin) }
    const subject = store(home, builtin)
    subject.list()
    subject.load('skeleton-crew')
    subject.load('front-office')
    subject.load('nothing-here')

    expect(census(home)).toEqual(before.home)
    expect(census(builtin)).toEqual(before.builtin)
  })

  it('does NOT seed the home copy from a builtin it read', () => {
    // The PromptStore seeds on read; this store deliberately does not. A
    // silently seeded copy would shadow the built-in forever, so a corrected
    // Skeleton Crew shipped next release would not be the one running.
    const home = tempRoot()
    const builtin = tempRoot()
    fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
    writeBundle(builtin, 'skeleton-crew')

    const loaded = store(home, builtin).load('skeleton-crew')
    expect(loaded.ok).toBe(true)
    if (loaded.ok) expect(loaded.source).toBe('builtin')
    expect(fs.readdirSync(path.join(home, 'profiles'))).toEqual([])
  })

  it('reads the bundle fresh each time — an edit on disk is the next answer', () => {
    // No cache: the Architect edits a bundle in a text editor and inspects it
    // again, which is the loop ADR-0012 is designed around.
    const home = tempRoot()
    const dir = writeBundle(path.join(home, 'profiles'), 'skeleton-crew', { version: 1 })
    const subject = store(home, tempRoot())
    const first = subject.load('skeleton-crew')
    if (!first.ok) throw new Error('expected ok')
    expect(first.bundle.document.version).toBe(1)

    const bumped = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8')) as Record<
      string,
      unknown
    >
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ ...bumped, version: 2 }))

    const second = subject.load('skeleton-crew')
    if (!second.ok) throw new Error('expected ok')
    expect(second.bundle.document.version).toBe(2)
  })
})

describe('listing', () => {
  it('lists a broken bundle as a row, marked invalid — never omits it', () => {
    const home = tempRoot()
    writeBundle(path.join(home, 'profiles'), 'skeleton-crew')
    writeBundle(path.join(home, 'profiles'), 'front-office', { profileJson: '{ broken' })

    const rows = store(home, tempRoot()).list()
    expect(rows.map((row) => row.name)).toEqual(['front-office', 'skeleton-crew'])
    expect(rows.map((row) => row.valid)).toEqual([false, true])
    expect(rows.find((row) => row.name === 'front-office')?.version).toBeNull()
  })

  it('home shadows builtin, and the row says which one answered', () => {
    const home = tempRoot()
    const builtin = tempRoot()
    writeBundle(path.join(home, 'profiles'), 'skeleton-crew', { version: 9 })
    writeBundle(builtin, 'skeleton-crew', { version: 1 })
    writeBundle(builtin, 'front-office')

    const rows = store(home, builtin).list()
    expect(rows.map((row) => [row.name, row.source, row.version])).toEqual([
      ['front-office', 'builtin', 1],
      ['skeleton-crew', 'home', 9]
    ])
    const loaded = store(home, builtin).load('skeleton-crew')
    if (!loaded.ok) throw new Error('expected ok')
    expect(loaded.bundle.document.version).toBe(9)
  })

  it('skips directories that were never profiles, rather than listing them as broken', () => {
    const home = tempRoot()
    const profiles = path.join(home, 'profiles')
    writeBundle(profiles, 'skeleton-crew')
    fs.mkdirSync(path.join(profiles, '.git'), { recursive: true })
    fs.mkdirSync(path.join(profiles, 'Not A Profile'), { recursive: true })
    fs.writeFileSync(path.join(profiles, 'README.md'), '# profiles')

    expect(
      store(home, tempRoot())
        .list()
        .map((row) => row.name)
    ).toEqual(['skeleton-crew'])
  })

  it('is empty, not an error, when neither root exists', () => {
    expect(new ProfileStore('/no/such/home/profiles', '/no/such/app/profiles').list()).toEqual([])
  })
})

describe('a fired schedule trigger actually wakes its agent', () => {
  const WAKE = {
    instanceId: 'skeleton-crew:repo:myapp',
    triggerId: 'health-sweep',
    agentId: 'agent.skeleton-crew-myapp-health-watcher',
    playbook: 'health-check.md',
    profile: 'skeleton-crew',
    targetPath: '/repos/myapp'
  }
  const render = (kind: 'subject' | 'body', vars: Record<string, string>): string =>
    kind === 'subject' ? `duty: ${vars.playbook}` : `follow ${vars.playbook} in ${vars.target}`
  const at = new Date('2026-08-31T09:00:00.000Z')

  it('addresses the agent the binding names, from the profile endpoint', () => {
    const message = triggerWakeMessage(WAKE, render, at)
    expect(message.to).toBe('agent.skeleton-crew-myapp-health-watcher')
    expect(message.from).toBe(PROFILE_ENDPOINT)
    // `request` obligates a reply — a duty nobody must answer for is a duty
    // that quietly stops being done (ADR-0003's obligation table).
    expect(message.act).toBe('request')
  })

  it('names the runbook and does not summarize it', () => {
    const message = triggerWakeMessage(WAKE, render, at)
    expect(message.body).toContain('health-check.md')
    // The harness has never read a playbook. If this message ever carried the
    // runbook's CONTENT, the bundle would have two places that say what to do.
    expect(message.body).not.toContain('Do these now')
    expect(message.body.length).toBeLessThan(500)
  })

  it('threads every wake of one binding onto one conversation', () => {
    const first = triggerWakeMessage(WAKE, render, at)
    const second = triggerWakeMessage(WAKE, render, new Date('2026-08-31T09:15:00.000Z'))
    expect(first.conversation).toBe(second.conversation)
    // Distinct ids, so two wakes are two messages and neither overwrites the
    // other in an inbox.
    expect(first.id).not.toBe(second.id)
  })
})

describe('a trigger wake survives the ids production actually mints', () => {
  /**
   * The wake used to build its conversation as `${instanceId}:${triggerId}`,
   * and `activationPlan` already mints the trigger id as `<instance>/<trigger>`
   * — so the instance appeared twice and the result was 66 characters against
   * SDD §4.4's limit of 64. `composeMessage` threw, every schedule trigger
   * wake failed, and the two agents those triggers wake received nothing for
   * the whole of a live run.
   *
   * The earlier test passed because its fixture ids were shorter than real
   * ones. So this case derives the ids the way the app does rather than
   * inventing tidy ones.
   */
  it('builds a legal message for a real instance and trigger id', () => {
    const instanceId = 'skeleton-crew@repo:musahit'
    const triggerId = `${instanceId}/health-sweep`
    const message = triggerWakeMessage(
      {
        instanceId,
        triggerId,
        agentId: 'agent.skeleton-crew-musahit-health-watcher',
        playbook: 'health-check.md',
        profile: 'skeleton-crew',
        targetPath: 'C:\\repos\\musahit'
      },
      (kind, vars) => (kind === 'subject' ? `duty: ${vars.playbook}` : `follow ${vars.playbook}`),
      new Date('2026-09-01T09:00:00.000Z')
    )
    // composeMessage validates; reaching here at all is most of the assertion.
    expect(message.conversation.length).toBeLessThanOrEqual(64)
    expect(message.to).toBe('agent.skeleton-crew-musahit-health-watcher')
  })

  it('stays legal for the longest ids the schema still permits', () => {
    // A 64-char profile name and a 64-char target id are both legal, so the
    // composed conversation must survive them rather than merely surviving the
    // built-ins that happen to ship.
    const instanceId = `${'p'.repeat(60)}@repo:${'t'.repeat(60)}`
    const triggerId = `${instanceId}/${'g'.repeat(60)}`
    expect(() =>
      triggerWakeMessage(
        {
          instanceId,
          triggerId,
          agentId: 'agent.a',
          playbook: 'x.md',
          profile: 'p',
          targetPath: '/tmp'
        },
        () => 'text',
        new Date('2026-09-01T09:00:00.000Z')
      )
    ).not.toThrow()
  })
})
