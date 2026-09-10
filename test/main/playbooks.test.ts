import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditPlaybooks,
  installPlaybooks,
  installedPlaybooks,
  playbookDegradations,
  playbookPath,
  playbooksDir
} from '../../src/main/playbooks'
import {
  ProfileActivations,
  ProfileStore,
  playbookBodies,
  triggerWakeMessage
} from '../../src/main/profiles'
import { incidentFrom } from '../../src/shared/incident'
import { comparePlaybooks, playbooksAgree } from '../../src/shared/profile-playbooks'
import type { SpawnRequest } from '../../src/shared/agents'
import { removeTempDir } from '../tmpdir'

/**
 * The runbooks reach the harness home (M8b.1 — Finding 8 of the 2026-09-09
 * exit run).
 *
 * The run this closes is not hypothetical and its cost is on the record: the
 * repository bundle carried `incident.md`, `health-check.md` and
 * `dependency-update.md`; `$EPH_HOME/profiles/` was EMPTY; `activations.json`
 * named all three. Eighteen incidents were raised and `incident-triaged` was
 * **0**, because the on-call agent had no runbook. The health watcher refused
 * its duty twice and said why; Artemis escalated it to a human. Four green
 * suites and 4,392 passing tests never saw it, because nothing had ever asked
 * whether the DECLARED set and the ON-DISK set were the same set.
 *
 * That question is the first `describe` below, asked through `activate()`
 * rather than through the installer — a test that called `installPlaybooks`
 * and asserted the files appeared would have passed on 2026-09-09 too, since
 * the defect was never in a writer. It was that nobody called one.
 */

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) removeTempDir(dir)
})

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-playbooks-'))
  roots.push(dir)
  return dir
}

/** The real shipped Skeleton Crew, as it sits in the repository. */
const BUILTINS = path.join(__dirname, '..', '..', 'profiles')

interface Rig {
  readonly home: string
  readonly targetDir: string
  readonly activations: ProfileActivations
  readonly spawned: SpawnRequest[]
  /**
   * What the SPAWN PATH could see about each hire, captured while that hire
   * was spawning. `index.ts` resolves `playbooksFor` exactly then, to write it
   * into the engine's settings file, so anything asserted after `activate()`
   * returns is a different question with a different answer.
   */
  readonly atSpawn: { agentId: string; instanceId: string | null; dir: string | null }[]
}

/**
 * An activation rig over the SHIPPED bundle and a real, empty home.
 *
 * Deliberately not a synthetic fixture. The exit run's home was a fresh one
 * and the bundle was the shipped Skeleton Crew, so a fixture bundle with one
 * tidy playbook would be asserting against a shape production does not have —
 * and the three files that failed to arrive are the three this reads.
 */
function rig(options: { readonly failInstall?: boolean } = {}): Rig {
  const home = tmp()
  const targetDir = path.join(home, 'repo')
  fs.mkdirSync(targetDir, { recursive: true })
  const spawned: SpawnRequest[] = []
  const atSpawn: { agentId: string; instanceId: string | null; dir: string | null }[] = []
  const activations = new ProfileActivations({
    store: new ProfileStore(path.join(home, 'profiles'), BUILTINS),
    globalAutonomy: () => 'autonomous',
    installPlaybooks: (plan, books) =>
      options.failInstall === true
        ? { ok: false, reasons: [`playbooks: could not install into ${home}`] }
        : ((): { ok: true } | { ok: false; reasons: readonly string[] } => {
            const outcome = installPlaybooks(home, plan.instanceId, books)
            return outcome.ok ? { ok: true } : { ok: false, reasons: outcome.reasons }
          })(),
    spawn: (request) => {
      spawned.push(request)
      // The production expression, evaluated where production evaluates it:
      //   playbooksFor: (agentId) => {
      //     const instanceId = activations?.instanceFor(agentId) ?? null
      //     return instanceId === null ? null : playbooksDir(home.root, instanceId)
      //   }
      const instanceId = activations.instanceFor(request.agentId)
      atSpawn.push({
        agentId: request.agentId,
        instanceId,
        dir: instanceId === null ? null : playbooksDir(home, instanceId)
      })
      return Promise.resolve({})
    },
    kill: () => {},
    addTrigger: () => {},
    removeTrigger: () => {},
    targetExists: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory()
  })
  return { home, targetDir, activations, spawned, atSpawn }
}

const target = (p: string) => ({ kind: 'repo' as const, id: 'aftershock', path: p })

describe('the assertion that would have failed on 2026-09-09', () => {
  it('leaves every playbook the instance declares readable on disk', async () => {
    const r = rig()

    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    // The declared set is not hardcoded here: it is read back off the plan, so
    // a bundle that gains a fourth playbook tomorrow is covered by this test
    // without anybody remembering to update it.
    const declared = result.instance.plan.playbooks
    expect(declared.length).toBeGreaterThan(0)
    expect(auditPlaybooks(r.home, { instanceId: result.instance.instanceId, declared })).toEqual({
      missing: [],
      extra: []
    })

    // And the specific three the run needed, named, so a regression that
    // emptied the declared set could not make this pass vacuously.
    expect([...declared].sort()).toEqual(['dependency-update.md', 'health-check.md', 'incident.md'])
  })

  it('writes the runbook TEXT, not just a file with the right name', async () => {
    const r = rig()
    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    // An empty file at the right path satisfies a set comparison and is still
    // useless to the agent told to follow it, so the bytes are checked against
    // the bundle they came from.
    for (const file of result.instance.plan.playbooks) {
      const installed = fs.readFileSync(
        playbookPath(r.home, result.instance.instanceId, file),
        'utf8'
      )
      expect(installed).toBe(
        fs.readFileSync(path.join(BUILTINS, 'skeleton-crew', 'playbooks', file), 'utf8')
      )
      expect(installed.length).toBeGreaterThan(0)
    }
  })

  it('puts them where the agent is TOLD to look, not merely somewhere', async () => {
    const r = rig()
    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))
    const instanceId = result.instance.instanceId

    // The wake message and the incident message are the two surfaces that name
    // a runbook to an agent. Both must name a path that resolves — naming one
    // that does not is the whole of Finding 8, and asserting the file exists
    // without asserting the MESSAGE points at it would leave that half open.
    const wake = triggerWakeMessage(
      {
        instanceId,
        triggerId: `${instanceId}/health-sweep`,
        agentId: 'agent.skeleton-crew-aftershock-health-watcher',
        playbook: 'health-check.md',
        playbookPath: playbookPath(r.home, instanceId, 'health-check.md'),
        profile: 'skeleton-crew',
        targetPath: r.targetDir
      },
      (kind, vars) =>
        kind === 'subject'
          ? `duty: ${vars.playbookName}`
          : `open ${vars.playbook} in ${vars.target}`,
      new Date('2026-09-09T06:00:00.000Z')
    )
    const named = wake.body.replace('open ', '').replace(` in ${r.targetDir}`, '')
    expect(fs.existsSync(named)).toBe(true)
    expect(wake.subject).toContain('health-check.md')

    const incident = incidentFrom(
      {
        kind: 'ci-run',
        repo: 'mertefesensoy/aftershock',
        ref: 34317920145,
        title: 'ci',
        state: 'completed',
        conclusion: 'failure',
        url: 'https://example.invalid/1',
        at: '2026-09-09T06:27:59.000Z',
        author: null,
        labels: [],
        draft: false
      },
      {
        instanceId,
        agentId: 'agent.skeleton-crew-aftershock-ci-babysitter',
        playbook: 'incident.md',
        playbookPath: playbookPath(r.home, instanceId, 'incident.md')
      }
    )
    expect(incident).not.toBeNull()
    expect(fs.existsSync(incident?.playbookPath ?? '')).toBe(true)
    // The log row keeps the NAME — a machine-specific path in an append-only
    // file ages badly, and the book of record is read by people.
    expect(incident?.playbook).toBe('incident.md')
  })

  it('refuses the activation and spawns NOTHING when the install fails', async () => {
    const r = rig({ failInstall: true })

    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reasons.join(' · ')).toContain('playbooks')
    // The ordering claim, and the reason the seam sits where it does: a crew
    // that cannot read its runbook must cost nothing to refuse. On 2026-09-09
    // it cost four hires, eighteen incidents and $11.22.
    expect(r.spawned).toEqual([])
    expect(r.activations.instances()).toEqual([])
  })

  it('replaces a previous install rather than merging with it', async () => {
    const home = tmp()
    installPlaybooks(
      home,
      'crew@repo:app',
      new Map([
        ['incident.md', '# v1\n'],
        ['retired.md', '# dropped in v2\n']
      ])
    )
    installPlaybooks(home, 'crew@repo:app', new Map([['incident.md', '# v2\n']]))

    // A merge would leave `retired.md` readable, and an agent told to follow a
    // runbook by name would open one the current profile does not carry.
    expect(installedPlaybooks(home, 'crew@repo:app')).toEqual(['incident.md'])
    expect(fs.readFileSync(playbookPath(home, 'crew@repo:app', 'incident.md'), 'utf8')).toBe(
      '# v2\n'
    )
  })
})

describe('the engine grant can be resolved at the moment it is needed', () => {
  it('answers for every hire DURING its spawn, and the runbooks are already there', async () => {
    // The trap this is written against: `instanceFor` delegates to `planFor`,
    // which searches the IN-FLIGHT plans as well as the live set. An
    // implementation that only consulted the live set would answer null for
    // every hire at spawn and answer correctly the instant activation
    // returned — so a test that asked afterwards would be green, and every
    // agent would nonetheless have been spawned with no runbook grant.
    const r = rig()
    const result = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!result.ok) throw new Error(result.reasons.join(' · '))

    expect(r.atSpawn.length).toBe(r.spawned.length)
    expect(r.atSpawn.length).toBeGreaterThan(0)
    for (const seen of r.atSpawn) {
      expect(seen.instanceId).toBe(result.instance.instanceId)
      // And the ordering claim the grant depends on: the settings file is
      // written at spawn, so the directory it names must already exist by
      // then. Installing after the hires would name a directory that appears
      // later, which the engine records as an absent path.
      expect(seen.dir).not.toBeNull()
      expect(fs.existsSync(seen.dir ?? '')).toBe(true)
      expect(fs.readdirSync(seen.dir ?? '').sort()).toEqual(
        [...result.instance.plan.playbooks].sort()
      )
    }
  })
})

describe('what gets installed is what the PLAN declares', () => {
  const bundle = {
    playbooks: [
      { file: 'incident.md', text: '# incident\n' },
      { file: 'health-check.md', text: '# health\n' },
      { file: 'retired.md', text: '# not declared by this plan\n' }
    ]
  }

  it('installs the declared set, not everything the bundle carries', () => {
    // Today `plan.playbooks` IS the bundle's whole set, so this filter is a
    // no-op in production and no end-to-end test can distinguish the two. It
    // is asserted directly instead, because the equality M8b.1 rests on is
    // "declared == installed": the day a plan carries a subset, keying off the
    // bundle would install runbooks the audit does not expect and the audit
    // would start reporting `extra` for files the harness itself wrote.
    const bodies = playbookBodies(bundle, { playbooks: ['incident.md', 'health-check.md'] })
    expect([...bodies.keys()].sort()).toEqual(['health-check.md', 'incident.md'])
    expect(bodies.get('incident.md')).toBe('# incident\n')
  })

  it('skips a declared name the bundle does not carry rather than inventing one', () => {
    // `parseProfile` already refuses a trigger naming a playbook the bundle
    // lacks, so this is unreachable through the normal path. If it ever
    // becomes reachable, an ABSENT file the audit then reports beats a
    // zero-byte runbook an agent would dutifully follow.
    const bodies = playbookBodies(bundle, { playbooks: ['incident.md', 'ghost.md'] })
    expect([...bodies.keys()]).toEqual(['incident.md'])
  })
})

describe('a restored instance whose runbooks went missing says so', () => {
  it('reports the instance, the files and the fix', () => {
    const home = tmp()
    const detail = playbookDegradations(home, [
      { instanceId: 'skeleton-crew@repo:aftershock', declared: ['incident.md', 'health-check.md'] }
    ])
    expect(detail).toHaveLength(1)
    expect(detail[0]).toContain('skeleton-crew@repo:aftershock')
    expect(detail[0]).toContain('health-check.md')
    expect(detail[0]).toContain('incident.md')
    expect(detail[0]).toContain(playbooksDir(home, 'skeleton-crew@repo:aftershock'))
    // A degradation that does not say what to do is read once and ignored.
    expect(detail[0]).toContain('Reactivate')
  })

  it('is silent when every declared runbook is installed', () => {
    const home = tmp()
    installPlaybooks(home, 'crew@repo:app', new Map([['incident.md', '# x\n']]))
    expect(
      playbookDegradations(home, [{ instanceId: 'crew@repo:app', declared: ['incident.md'] }])
    ).toEqual([])
  })

  it('reports a runbook nobody declared, not only a missing one', () => {
    const home = tmp()
    installPlaybooks(
      home,
      'crew@repo:app',
      new Map([
        ['incident.md', '# x\n'],
        ['stray.md', '# hand-edited in\n']
      ])
    )
    const detail = playbookDegradations(home, [
      { instanceId: 'crew@repo:app', declared: ['incident.md'] }
    ])
    // Equality, not "nothing is missing". A runbook the plan does not name is
    // one nobody approved, and it still opens when an agent is pointed at it.
    expect(detail).toHaveLength(1)
    expect(detail[0]).toContain('stray.md')
  })
})

describe('the boot audit, over the expression index.ts actually evaluates', () => {
  /**
   * The production expression this mirrors, from `src/main/index.ts`:
   *
   *     playbookDegradations(
   *       home.root,
   *       (activations?.instances() ?? []).map((instance) => ({
   *         instanceId: instance.instanceId,
   *         declared: instance.plan.playbooks
   *       }))
   *     )
   *
   * Mirrored rather than asserted through a hand-typed record, because the
   * fragile half is the DERIVATION — `instance.plan.playbooks` — and a test
   * that types its own `declared` array proves nothing about it. Rename that
   * field, or restore an instance whose plan carries playbooks under another
   * name, and a test with its own fixture stays green while production audits
   * an empty set and reports nothing for ever. `index.ts` is not reachable
   * from a test in this build, so the expression is reproduced here against
   * the real `ProfileActivations`.
   */
  const auditAsIndexDoes = (home: string, activations: ProfileActivations) =>
    playbookDegradations(
      home,
      activations.instances().map((instance) => ({
        instanceId: instance.instanceId,
        declared: instance.plan.playbooks
      }))
    )

  it('is silent for an instance restored into a home that still has its runbooks', async () => {
    const r = rig()
    const activated = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!activated.ok) throw new Error(activated.reasons.join(' · '))

    expect(auditAsIndexDoes(r.home, r.activations)).toEqual([])
  })

  it('names the instance when the home lost its runbooks while the harness was off', async () => {
    const r = rig()
    const activated = await r.activations.activate({
      profile: 'skeleton-crew',
      target: target(r.targetDir)
    })
    if (!activated.ok) throw new Error(activated.reasons.join(' · '))

    // What a cleaned, moved or half-copied home looks like on the next boot.
    // `activations.json` still carries the plan; the directory is gone.
    fs.rmSync(playbooksDir(r.home, activated.instance.instanceId), {
      recursive: true,
      force: true
    })

    const reported = auditAsIndexDoes(r.home, r.activations)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain(activated.instance.instanceId)
    for (const file of activated.instance.plan.playbooks) {
      expect(reported[0]).toContain(file)
    }
  })
})

describe('the installer refuses what it must not write', () => {
  it('refuses a file name that would escape the instance directory', () => {
    const home = tmp()
    const outcome = installPlaybooks(
      home,
      'crew@repo:app',
      new Map([['../../gate-policy.json', '{"autonomy":"autonomous"}']])
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reasons.join(' · ')).toContain('bare file name')
    // Nothing was written, including the directory itself — a guard that
    // refuses after creating the target is a guard that already lost.
    expect(fs.existsSync(playbooksDir(home, 'crew@repo:app'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'gate-policy.json'))).toBe(false)
  })

  it('names the destination when the write itself fails', () => {
    // A FILE where the HOME must go, so `mkdirSync` cannot make a directory
    // beneath it — a genuine ENOTDIR, the shape a real permission or layout
    // failure takes. Note what does NOT work as a fixture, because finding out
    // is why this test looks like this: putting a file where the playbooks
    // directory goes, since the replace-first `rmSync` removes it and the
    // install then succeeds. That is the REPLACE semantics working correctly.
    const home = path.join(tmp(), 'not-a-directory')
    fs.writeFileSync(home, 'a file')
    const dir = playbooksDir(home, 'crew@repo:app')

    const outcome = installPlaybooks(home, 'crew@repo:app', new Map([['incident.md', '# x\n']]))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    // The destination, not just the errno: a runner told `EACCES` learns
    // nothing; one told which directory could not be written knows whether
    // they picked a home they cannot write to.
    expect(outcome.reasons.join(' · ')).toContain(dir)
    expect(outcome.reasons.join(' · ')).toContain('incident.md')
  })

  it('reads an absent directory as the empty set rather than throwing', () => {
    const home = tmp()
    // The state the exit run was actually in. It has to be REPORTABLE, so the
    // boot audit can name it — a throw here would take the boot down instead.
    expect(installedPlaybooks(home, 'never@repo:activated')).toEqual([])
    expect(playbooksAgree(comparePlaybooks(['incident.md'], []))).toBe(false)
  })
})
/**
 * **M8c.9 — a shipped runbook must not ask for a ref git cannot create.**
 *
 * `incident.md` told every hire to *"Push to `agent/<your-name>/<topic>`"*. A
 * hire is already working on `agent/<your-name>`, and git will not nest a ref
 * under an existing one:
 *
 * ```text
 * fatal: cannot lock ref 'refs/heads/agent/mason/fix-geo':
 *        'refs/heads/agent/mason' exists; cannot create …
 * ```
 *
 * So the instruction failed for every agent that followed it, each improvised a
 * name outside its own namespace, and `Worktrees.create` then read the
 * improvisation as somebody else's checkout — the refusal that closed the loop
 * after the M8b rehearsal's restart. Two halves of one defect; this is the guard
 * on the half that lives in prose.
 */
describe('the branch a shipped runbook tells a hire to push (M8c.9)', () => {
  const BUNDLES = path.join(__dirname, '..', '..', 'profiles')

  /** Every shipped runbook and hire brief, as text. */
  function shippedInstructions(): readonly {
    readonly file: string
    readonly body: string
  }[] {
    const found: { file: string; body: string }[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
          found.push({
            file: path.relative(BUNDLES, full),
            body: fs.readFileSync(full, 'utf8')
          })
        }
      }
    }
    walk(BUNDLES)
    return found
  }

  /** Whether `text` names a ref nested under an `agent/<name>` branch. */
  function nestsUnderAnAgentBranch(text: string): boolean {
    // `agent/*` does not match (no second segment); `agent/<name>-<topic>` does
    // not match (a hyphen is not a separator git cares about).
    return /agent\/[^\s`/"]+\/[^\s`/"]+/.test(text)
  }

  it('never asks for a ref nested under the branch the harness already minted', () => {
    const offenders = shippedInstructions()
      .filter((entry) => nestsUnderAnAgentBranch(entry.body))
      .map((entry) => entry.file)

    expect(offenders).toEqual([])
  })

  it('CONTROL — the sentence that shipped until M8c.9 is caught by this check', () => {
    expect(nestsUnderAnAgentBranch('Push to `agent/<your-name>/<topic>` and open the PR')).toBe(
      true
    )
    expect(nestsUnderAnAgentBranch('agent/mason/fix-geo')).toBe(true)
    // …and the two forms that are legal are not.
    expect(nestsUnderAnAgentBranch('name the topic branch `agent/<your-name>-<topic>`')).toBe(false)
    expect(nestsUnderAnAgentBranch('Push your own `agent/*` branch and open it.')).toBe(false)
  })
})
