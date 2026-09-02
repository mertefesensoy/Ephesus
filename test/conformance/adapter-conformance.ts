import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ENGINE_IDS, HOOK_SUPPORTS, HOOK_SUPPORT_RANK } from '../../src/shared/engines'
import { HOOK_EVENTS } from '../../src/shared/hooks'
import type { AgentSpawnConfig, EngineAdapter, UsageFact } from '../../src/main/engines'
import { removeTempDir } from '../tmpdir'

/**
 * The engine-adapter conformance suite (TEST-STRATEGY §5, NFR-12).
 *
 * This is the containment wall ADR-0009 describes: Ephesus inherits every
 * engine's quirks, so the price of adding an engine is passing this table. It
 * runs per-PR against the fake adapter and the claude adapter; the claude
 * adapter's *live* half (spawning a real binary) is nightly territory and is
 * not run here.
 *
 * Cases are written against the surface, never a mechanism. "Identity injection
 * observable" does not care whether an adapter uses argv, env or a context
 * file — only that the identity is demonstrably in the plan the agent will run
 * under, which is what SDD §3 means by "conformance-tested for effect, not
 * mechanism".
 */

export interface ConformanceSubject {
  /** Name in the test output. */
  readonly name: string
  /** Built fresh per case, so no case can leak state into another. */
  make(): EngineAdapter
  /**
   * Files this adapter is expected to write into the agent's cwd, relative to
   * it. Every one must be a local/gitignored variant (ADR-0009).
   */
  readonly settingsRel: readonly string[]
  /** True when the adapter is expected to wire every harness hook event. */
  readonly wiresEveryEvent: boolean
  /**
   * A sample of THIS engine's transcript format, plus the facts it must yield.
   * Required when the adapter declares `transcripts`.
   *
   * Every engine writes its own format (NFR-12), so the suite cannot supply
   * the lines itself — asserting one shape across all adapters would demand
   * that Claude Code parse the fake engine's JSON, which is a conformance
   * failure invented by the test. What conformance actually owns is the
   * *behaviour* around the lines: a missing file yields nothing, a malformed
   * line yields nothing, and a good line yields exactly what it said
   * (ADR-0009: "unrecognized lines are skipped, never guessed at").
   */
  readonly transcriptSample?: {
    /** Well-formed lines in this engine's own format. */
    readonly goodLines: readonly string[]
    /** The facts `goodLines` must produce, in order. */
    readonly expected: readonly UsageFact[]
    /** Lines this engine must ignore: junk, and a well-formed non-fact. */
    readonly ignoredLines: readonly string[]
  }
}

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

export interface ConformanceRig {
  readonly cfg: AgentSpawnConfig
  readonly cwd: string
  readonly root: string
}

/** A temp agent cwd plus a materialized identity — never a real repo. */
export function conformanceRig(): ConformanceRig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-conf-'))
  temps.push(root)
  const cwd = path.join(root, 'repo')
  const agentDir = path.join(root, 'agora', 'agents', 'agent.subject')
  fs.mkdirSync(cwd, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, 'identity.md'),
    '# Subject\n\nRole: conformance-subject.\nSecret handshake: pomegranate-42.\n',
    'utf8'
  )
  fs.writeFileSync(
    path.join(root, 'agora', 'PROTOCOL.md'),
    '# Company protocol\n\nWrite only inside your own agent directory.\n',
    'utf8'
  )
  return {
    root,
    cwd,
    cfg: {
      agentId: 'agent.subject',
      hookToken: 'conformance-token',
      hookEndpoint: path.join(root, 'events.sock'),
      cwd,
      commitIdentity: null,
      ghTokenCommand: '',
      envGrants: {},
      identityPath: path.join(agentDir, 'identity.md'),
      protocolPath: path.join(root, 'agora', 'PROTOCOL.md'),
      memory: '',
      recallCommand: '',
      autonomy: 'manual'
    }
  }
}

/** Everything in a spawn plan an injected identity could plausibly reach. */
function planHaystack(adapter: EngineAdapter, cfg: AgentSpawnConfig): string {
  const plan = adapter.spawnArgs(cfg)
  return [
    ...plan.argv,
    ...Object.values(plan.env),
    ...plan.settings.map((injection) => injection.contents)
  ].join('\n')
}

export function runAdapterConformance(subject: ConformanceSubject): void {
  describe(`conformance: ${subject.name}`, () => {
    describe('declared surface (ADR-0009)', () => {
      it('declares a known engine id and a known hook grade', () => {
        const adapter = subject.make()
        expect(ENGINE_IDS).toContain(adapter.id)
        expect(HOOK_SUPPORTS).toContain(adapter.hooks)
        expect(HOOK_SUPPORT_RANK[adapter.hooks]).toBeTypeOf('number')
      })

      it('describes a binary with an install command and a version probe', () => {
        const spec = subject.make().binary()
        expect(spec.name.length).toBeGreaterThan(0)
        expect(spec.install.command.length).toBeGreaterThan(0)
        expect(spec.versionProbe.command.length).toBeGreaterThan(0)
        expect(spec.parseVersion('')).toBeNull()
      })

      it('offers an interrupt key with real bytes and a label to show', () => {
        const key = subject.make().interrupt()
        expect(key.bytes.length).toBeGreaterThan(0)
        expect(key.label.length).toBeGreaterThan(0)
      })

      it('resumes a session by id, when it declares resume (FR-1.4, FR-5.4)', () => {
        const adapter = subject.make()
        if (!adapter.resume) return // optional capability; absence is legal
        const args = adapter.resume.resumeArgs('sess-abc123')
        // The contract is an argv *fragment* appended to the spawn plan, so it
        // must be non-empty, must name the session, and must not smuggle the
        // whole command back in — the caller already has argv[0].
        expect(args.length).toBeGreaterThan(0)
        expect(args.join(' ')).toContain('sess-abc123')
        expect(args[0]).not.toBe(adapter.spawnArgs(conformanceRig().cfg).argv[0])
      })

      it('resumes different sessions differently, and the same one the same way', () => {
        const adapter = subject.make()
        if (!adapter.resume) return
        expect(adapter.resume.resumeArgs('sess-a')).toEqual(adapter.resume.resumeArgs('sess-a'))
        expect(adapter.resume.resumeArgs('sess-a')).not.toEqual(adapter.resume.resumeArgs('sess-b'))
      })

      it('reads transcripts without inventing facts, when it declares them', async () => {
        const adapter = subject.make()
        if (!adapter.transcripts) {
          // ADR-0009 makes this optional; a missing reader is a visible product
          // tier, not a hidden failure. Nothing to assert but the absence.
          expect(adapter.transcripts).toBeUndefined()
          return
        }
        const sample = subject.transcriptSample
        if (!sample) {
          throw new Error(
            `${subject.name} declares transcripts but supplies no transcriptSample — the suite cannot assert a format it does not know`
          )
        }
        const rig = conformanceRig()
        const dir = adapter.transcripts.transcriptDir(rig.cfg)
        expect(path.isAbsolute(dir)).toBe(true)

        // A transcript that is not there yields no facts, not an error: an
        // engine that has not written one yet is the normal early state.
        expect(await adapter.transcripts.read(path.join(rig.root, 'nope.jsonl'))).toEqual([])

        const file = path.join(rig.root, 'transcript.jsonl')
        fs.writeFileSync(file, [...sample.goodLines, ...sample.ignoredLines, ''].join('\n'), 'utf8')
        // Exactly the declared facts: the ignored lines contribute nothing, and
        // nothing is invented to stand in for them.
        expect(await adapter.transcripts.read(file)).toEqual(sample.expected)

        const junkOnly = path.join(rig.root, 'junk.jsonl')
        fs.writeFileSync(junkOnly, [...sample.ignoredLines, ''].join('\n'), 'utf8')
        expect(await adapter.transcripts.read(junkOnly)).toEqual([])
      })
    })

    describe('spawn plan (SDD §3)', () => {
      it('carries the two harness variables and the agent cwd', () => {
        const rig = conformanceRig()
        const plan = subject.make().spawnArgs(rig.cfg)

        expect(plan.cwd).toBe(rig.cwd)
        expect(plan.argv.length).toBeGreaterThan(0)
        expect(plan.env['EPH_AGENT_ID']).toBe('agent.subject')
        expect(plan.env['EPH_HOOK_TOKEN']).toBe('conformance-token')
      })

      it('passes declared grants through and nothing undeclared', () => {
        const rig = conformanceRig()
        const cfg = { ...rig.cfg, envGrants: { GRANTED_TOKEN: 'granted-value' } }
        const plan = subject.make().spawnArgs(cfg)

        expect(plan.env['GRANTED_TOKEN']).toBe('granted-value')
        // A secret that was never granted must not appear anywhere in the plan.
        expect(JSON.stringify(plan)).not.toContain('UNGRANTED')
      })

      it('carries the memory layer the Library composed, unchanged', () => {
        const rig = conformanceRig()
        const cfg = { ...rig.cfg, memory: '## Your memory\n\nThe kiln fires at 1280C.' }
        const haystack = planHaystack(subject.make(), cfg)

        // ADR-0006 layer 1 reaches the agent whichever mechanism the adapter
        // uses, and the adapter neither trims it nor decides how much of it to
        // carry — the Library already did (NFR-12).
        expect(haystack).toContain('The kiln fires at 1280C.')
      })

      it('hands the agent the recall command, and nothing when there is none', () => {
        const rig = conformanceRig()
        const withRecall = subject
          .make()
          .spawnArgs({ ...rig.cfg, recallCommand: 'node /shims/eph-recall.mjs' })
        expect(withRecall.env['EPH_RECALL']).toBe('node /shims/eph-recall.mjs')

        // An empty command must not become an empty variable: `$EPH_RECALL q`
        // would then run `q` (ADR-0006 layer 2 absent is a state, not a trap).
        const without = subject.make().spawnArgs({ ...rig.cfg, recallCommand: '' })
        expect(without.env['EPH_RECALL']).toBeUndefined()
      })

      it('makes identity injection observable in the plan (effect, not mechanism)', () => {
        const rig = conformanceRig()
        const haystack = planHaystack(subject.make(), rig.cfg)

        expect(haystack).toContain('pomegranate-42')
        expect(haystack).toContain('Write only inside your own agent directory')
      })

      it('refuses to build a plan when the identity source is missing', () => {
        const rig = conformanceRig()
        fs.rmSync(rig.cfg.identityPath, { force: true })

        expect(() => subject.make().injectIdentity(rig.cfg)).toThrow()
        expect(() => subject.make().spawnArgs(rig.cfg)).toThrow()
      })
    })

    describe('settings-file hygiene (TEST-STRATEGY §5)', () => {
      it('writes only local variants, and only inside the agent cwd', () => {
        const rig = conformanceRig()
        const plan = subject.make().wireHooks(rig.cfg)

        expect(plan.injections.map((i) => path.relative(rig.cwd, i.path))).toEqual([
          ...subject.settingsRel
        ])
        for (const injection of plan.injections) {
          const relative = path.relative(rig.cwd, injection.path)
          expect(relative.startsWith('..')).toBe(false)
          expect(path.basename(injection.path)).toContain('.local.')
        }
      })

      /**
       * An adapter may legitimately install nothing — that is what a
       * `pty-heuristic` engine with no verifiable hook file looks like, and it
       * is the strongest possible answer to the hygiene rule. The two cases
       * below are about *what an installer leaves behind*, so they apply only
       * to adapters that install something; the third holds for everyone.
       */
      const installsSettings = subject.settingsRel.length > 0

      it.runIf(installsSettings)(
        'backs up a pre-existing file and restores it byte-for-byte',
        async () => {
          const rig = conformanceRig()
          const target = path.join(rig.cwd, subject.settingsRel[0] ?? '')
          const original = '{\r\n  "mine": true\r\n}\r\n'
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, original, 'utf8')
          const before = fs.readFileSync(target)

          const plan = subject.make().wireHooks(rig.cfg)
          await plan.install()
          expect(fs.readFileSync(target).equals(before)).toBe(false)

          await plan.uninstall()
          expect(fs.readFileSync(target).equals(before)).toBe(true)
        }
      )

      it('leaves the agent cwd exactly as it found it', async () => {
        const rig = conformanceRig()
        const plan = subject.make().wireHooks(rig.cfg)
        const before = fs.readdirSync(rig.cwd)

        await plan.install()
        // Both halves are claims the suite checks: an installer must actually
        // install, and an adapter that declares no settings must actually write
        // nothing — "wrote nothing" is not taken on trust either.
        if (installsSettings) expect(fs.readdirSync(rig.cwd)).not.toEqual(before)
        else expect(fs.readdirSync(rig.cwd)).toEqual(before)

        await plan.uninstall()
        expect(fs.readdirSync(rig.cwd)).toEqual(before)
      })

      it('is safe to uninstall twice, or without installing', async () => {
        const rig = conformanceRig()
        const plan = subject.make().wireHooks(rig.cfg)
        await expect(plan.uninstall()).resolves.toBeUndefined()
        await plan.install()
        await plan.uninstall()
        await expect(plan.uninstall()).resolves.toBeUndefined()
      })
    })

    describe('hook grade honesty (FR-2.3)', () => {
      it('wires enough events to back the grade it declares', () => {
        const adapter = subject.make()
        if (!subject.wiresEveryEvent) return

        const rig = conformanceRig()
        const wiring = adapter
          .wireHooks(rig.cfg)
          .injections.map((injection) => injection.contents)
          .join('\n')

        // A `native` grade claims the engine reports the whole lifecycle. If an
        // event is not wired, the grade is a lie the agent card would repeat.
        for (const event of HOOK_EVENTS) expect(wiring).toContain(event)
        expect(adapter.hooks).toBe('native')
      })
    })
  })
}
