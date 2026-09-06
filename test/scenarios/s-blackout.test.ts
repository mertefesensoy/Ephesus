import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHomes, startCompany, scenarioMessage, sendStep, type Company } from './company'
import { QuitSequence } from '../../src/main/shutdown'
import { UiBridge } from '../../src/main/ui-bridge'
import os from 'node:os'
import { GateManager } from '../../src/main/watch/gates'
import { ProfileActivations, ProfileStore } from '../../src/main/profiles'
import { Scheduler } from '../../src/main/scheduler'
import { activationsRecord, restoreCompany, type RestoreStores } from '../../src/main/restore'
import { JsonStateStore } from '../../src/main/state-store'
import { EMPTY_GATES, GATES_REL, denyAllPolicy, gatesRecordSchema } from '../../src/shared/gates'
import {
  ACTIVATIONS_REL,
  EMPTY_ACTIVATIONS,
  activationsRecordSchema,
  watchedRepos
} from '../../src/shared/profile-activation'
import { EMPTY_TRIGGERS, TRIGGERS_REL, triggersRecordSchema } from '../../src/shared/restart'
import {
  DRAFTS_REL,
  draftsRecordSchema,
  EMPTY_DRAFTS,
  type OutboundDraft,
  type PostPermit
} from '../../src/shared/outbound'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { HARBOR_ENDPOINT } from '../../src/shared/reserved'
import { FrontOffice, OUTBOUND_SUBJECT } from '../../src/main/frontoffice'
import { removeTempDir } from '../tmpdir'

/** Homes made by the M8.8 restart cases below, cleaned with the rest. */
const blackoutHomes: string[] = []

/**
 * **S-BLACKOUT** (TEST-STRATEGY §3, SRS §6.6): "kill main mid-delivery /
 * mid-commit at injected fault points; restart; assert zero loss, zero
 * double-processing, committer reconcile."
 *
 * The fault points are in the production code path (`Agora`'s and `Hermes`'s
 * `faults` seams), not in a mock — a blackout has to interrupt the *real*
 * ordering between a rename and a commit, and a seam that only exists under a
 * mock proves nothing about it.
 *
 * "Restart" is modelled the way it actually happens: the old objects are
 * abandoned mid-flight and a fresh company is built over the same home, exactly
 * as a killed Electron process and a new one would.
 */

const companies: Company[] = []

afterEach(async () => {
  // Close every company FIRST — a blackout scenario runs two over one home —
  // then remove the directories, so no teardown races a commit in flight.
  for (const company of companies.splice(0)) await company.close()
  cleanupHomes()
  for (const dir of blackoutHomes.splice(0)) removeTempDir(dir)
})

async function boot(options: Parameters<typeof startCompany>[0] = {}): Promise<Company> {
  const company = await startCompany(options)
  companies.push(company)
  return company
}

/** Rebuilds the harness over an existing home, as a restarted process would. */
async function restartOver(home: string): Promise<Company> {
  const { Agora } = await import('../../src/main/agora')
  const { Hermes } = await import('../../src/main/hermes')
  const { PromptStore } = await import('../../src/main/prompts')
  const { GateManager, wireGateChokePoints } = await import('../../src/main/watch/gates')
  const { Breaker } = await import('../../src/main/watch/breaker')
  const { LedgerEndpoint } = await import('../../src/main/ledger')
  const { Odeon } = await import('../../src/main/odeon')
  const { Gymnasium } = await import('../../src/main/gymnasium')
  const { Stoa } = await import('../../src/main/stoa')
  const { BriefingJob } = await import('../../src/main/briefing')
  const { MeetingDriver } = await import('../../src/main/meeting')
  const { OrgLayer } = await import('../../src/main/org')
  const { emptyLedger } = await import('../../src/shared/tasks')
  const { CostLedger, MemoryLedgerStore } = await import('../../src/main/watch/ledger')
  const { denyAllPolicy } = await import('../../src/shared/gates')
  const { fileURLToPath } = await import('node:url')
  const repo = fileURLToPath(new URL('../../', import.meta.url))

  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(repo, 'prompts'))
  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  await agora.ensureRepo()
  await agora.reconcile()
  const hermes = new Hermes({ agora, prompts })
  const blackoutGates = new GateManager({ policy: () => denyAllPolicy })

  const company: Company = {
    home,
    // The restarted half never opens a window and never quits: it is the
    // company that comes BACK. An unattached bridge and a sequence over an
    // empty floor are the honest stand-ins, and both are the shipped classes.
    ui: new UiBridge(),
    quit: new QuitSequence({
      liveAgents: () => [],
      ask: () => 'now',
      closing: () => null,
      agents: () => null,
      steps: () => [],
      onDegraded: () => undefined
    }),
    quitDegradations: [],
    agora,
    hermes,
    hookServer: null as never,
    hookEvents: [],
    // The restarted half of a blackout re-reads state from disk; it never
    // opens a gate, so a deny-all manager with no sinks is the honest stand-in.
    gates: blackoutGates,
    // The restarted half re-reads `tasks.json` from disk like the real app.
    tasks: new LedgerEndpoint({ store: agora, knownAgents: () => hermes.knownAgents() }),
    // A blackout scenario asserts what survived on disk in the data plane; the
    // Odeon subsystems are not exercised, so honest stand-ins over the same
    // restored Agora are what belong here.
    odeon: new Odeon({
      agoraRoot: agora.root,
      prompts,
      task: () => null,
      recordDeck: () => {}
    }),
    gymnasium: new Gymnasium({
      agoraRoot: agora.root,
      seedFrom: path.join(repo, 'docs', 'gymnasium')
    }),
    // The restarted half re-reads the watchlist from disk like everything else
    // here; a blackout never studies anything.
    stoa: new Stoa({
      agoraRoot: agora.root,
      seedFrom: path.join(repo, 'test', 'fixtures', 'stoa-seed')
    }),
    briefing: new BriefingJob({
      prompts,
      gather: () => ({ events: [], ledger: emptyLedger, openGates: [], openMemos: [], spend: [] }),
      orchestrator: () => null,
      deliver: () => {}
    }),
    meetings: new MeetingDriver({
      agoraRoot: agora.root,
      prompts,
      deliver: () => {},
      orchestrator: () => null
    }),
    org: new OrgLayer({
      agoraRoot: agora.root,
      gather: () => ({ events: [], agents: [], spend: [] })
    }),
    triaged: [],
    chokePoints: wireGateChokePoints({ gates: blackoutGates, prompts }),
    // A blackout scenario never trips the breaker; it asserts what survived on
    // disk. A no-effect breaker is the honest stand-in.
    breaker: new Breaker({
      effects: {
        steer: () => {},
        pauseDeliveries: () => {},
        constrainBudget: () => {},
        interrupt: () => {},
        stop: () => {},
        avatar: () => {},
        returnTask: () => {}
      },
      steerText: () => ''
    }),
    breakerActs: [],
    // The restarted half never closes the floor; a real protocol over the
    // rebuilt rails is the honest stand-in (nothing calls begin() here).
    closing: new (await import('../../src/main/closing')).ClosingTime({
      liveAgents: () => hermes.knownAgents(),
      deliver: (message) => hermes.deliverFromHarness(message),
      render: () => '',
      onLogEvent: () => {}
    }),
    // Nothing here begins a closing, so no deadline is ever armed. False is the
    // contract's answer for that, not a stub: a scenario that tripped a
    // deadline which never existed would be asserting against nothing.
    tripClosingDeadline: () => false,
    // The incident plane is deliberately not exercised by a blackout: what a
    // restart owes an in-flight incident is its own question (the endpoint
    // re-raises a still-failing run by design), and S-PROFILE owns it. An
    // honest stand-in over the same restored Agora belongs here.
    incidents: new (await import('../../src/main/incidents')).IncidentEndpoint({
      bindings: () => [],
      orchestratorId: () => agora.registry().orchestratorId ?? 'agent.artemis',
      deliver: (message) => hermes.deliverFromHarness(message),
      render: () => '',
      onLogEvent: () => {}
    }),
    incidentBindings: [],
    unmetObligations: [],
    escalatedNow: [],
    // A blackout scenario asserts what survived on disk in the *data plane*;
    // the cost plane's own restart property is S-LEDGER's. Honest stand-ins.
    ledgerStore: new MemoryLedgerStore(),
    costs: new CostLedger({ store: new MemoryLedgerStore() }),
    foldSpend: async () => {},
    runTurnIn: async () => '',
    hire: (agentId) => hermes.ensureMailbox(agentId),
    sessionOf: (agentId) => `sess-${agentId}`,
    runTurn: async () => '',
    inbox: (agentId) => {
      const dir = path.join(hermes.mailboxDir(agentId), 'inbox')
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((n) => n.endsWith('.json'))
            .sort()
        : []
    },
    inflight: (agentId) => {
      const dir = path.join(hermes.mailboxDir(agentId), 'inbox', '.inflight')
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((n) => n.endsWith('.json'))
            .sort()
        : []
    },
    done: (agentId) => {
      const dir = path.join(hermes.mailboxDir(agentId), 'inbox', '.done')
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((n) => n.endsWith('.json'))
            .sort()
        : []
    },
    readInbox: (agentId, name) =>
      JSON.parse(
        fs.readFileSync(path.join(hermes.mailboxDir(agentId), 'inbox', name), 'utf8')
      ) as never,
    close: async () => {
      hermes.stop()
      await agora.drained().catch(() => {})
    }
  }
  companies.push(company)
  return company
}

describe('S-BLACKOUT — killed mid-delivery', () => {
  it('loses nothing when the harness dies before the rename', async () => {
    let armed = true
    const company = await boot({
      hermesFaults: (point) => {
        if (point === 'before-deliver' && armed) {
          armed = false
          throw new Error('blackout')
        }
      }
    })
    company.hire('agent.a')
    company.hire('agent.b')

    const sent = scenarioMessage({ from: 'agent.a', to: 'agent.b', act: 'request' })
    await company.runTurn('agent.a', [sendStep(sent)])
    await expect(company.hermes.sweep()).rejects.toThrow(/blackout/)

    // The message never left the outbox, so nothing was lost.
    const outbox = path.join(company.agora.agentDir('agent.a'), 'outbox')
    expect(fs.readdirSync(outbox).filter((n) => n.endsWith('.json'))).toHaveLength(1)

    // The restarted harness picks it up and delivers it exactly once.
    const restarted = await restartOver(company.home)
    await restarted.hermes.sweep()
    expect(restarted.inbox('agent.b')).toEqual([`${sent.id}.json`])
    expect(fs.readdirSync(outbox).filter((n) => n.endsWith('.json'))).toEqual([])
  })

  it('does not double-process when the harness dies after the rename', async () => {
    let armed = true
    const company = await boot({
      hermesFaults: (point) => {
        if (point === 'before-drain-outbox' && armed) {
          armed = false
          throw new Error('blackout')
        }
      }
    })
    company.hire('agent.a')
    company.hire('agent.b')

    const sent = scenarioMessage({ from: 'agent.a', to: 'agent.b', act: 'request' })
    await company.runTurn('agent.a', [sendStep(sent)])
    await expect(company.hermes.sweep()).rejects.toThrow(/blackout/)

    // Delivered, but the outbox copy survived the crash — the dangerous state.
    expect(company.inbox('agent.b')).toEqual([`${sent.id}.json`])

    const restarted = await restartOver(company.home)
    await restarted.hermes.sweep()

    // Still exactly one copy: the same id renames onto the same filename.
    expect(restarted.inbox('agent.b')).toEqual([`${sent.id}.json`])
    // And the recipient consumes it exactly once.
    expect(await restarted.hermes.consumeInbox('agent.b')).toHaveLength(1)
    expect(await restarted.hermes.consumeInbox('agent.b')).toHaveLength(0)
    // Handed over once, and in flight until this session proves it read it.
    expect(restarted.inflight('agent.b')).toEqual([`${sent.id}.json`])
  })

  it('does not re-consume mail the dead harness had already handed over', async () => {
    const company = await boot({
      hermesFaults: (point) => {
        if (point === 'after-consume') throw new Error('blackout right after the handover')
      }
    })
    company.hire('agent.a')
    company.hire('agent.b')

    const sent = scenarioMessage({ from: 'agent.a', to: 'agent.b', act: 'request' })
    await company.runTurn('agent.a', [sendStep(sent)])
    await company.hermes.sweep()

    // The mail was handed over; the harness died before finishing the turn, so
    // it is IN FLIGHT rather than archived.
    await expect(company.hermes.consumeInbox('agent.b')).rejects.toThrow(/blackout/)
    expect(company.inflight('agent.b')).toEqual([`${sent.id}.json`])

    // The requirement this case exists for is unchanged: a NEW harness cannot
    // know what the dead one's session did with what it was handed, so it
    // settles the in-flight mail rather than redelivering it. Guessing wrong
    // the other way would double-process work that may have been done
    // (§6 criterion 6). The redelivery this fix adds is only for the death the
    // harness OBSERVES — an agent exiting while the harness is alive.
    const restarted = await restartOver(company.home)
    expect(await restarted.hermes.consumeInbox('agent.b')).toEqual([])
    expect(restarted.done('agent.b')).toEqual([`${sent.id}.json`])
  })
})

describe('S-BLACKOUT — killed mid-commit', () => {
  it('commits the in-flight work on the next boot, losing nothing', async () => {
    let armed = false
    const company = await boot({
      agoraFaults: (point) => {
        if (point === 'after-stage' && armed) throw new Error('blackout between stage and commit')
      }
    })
    company.hire('agent.a')
    company.hire('agent.b')

    const sent = scenarioMessage({ from: 'agent.a', to: 'agent.b', act: 'request' })
    await company.runTurn('agent.a', [sendStep(sent)])
    armed = true
    await company.hermes.sweep()
    await company.agora.drained().catch(() => {})

    // Delivered on disk, but never committed.
    expect(company.inbox('agent.b')).toEqual([`${sent.id}.json`])
    expect(await company.agora.isDirty()).toBe(true)

    // The restart reconciles: the working tree is clean and the delivery is
    // in history under a name that says why it landed.
    const restarted = await restartOver(company.home)
    expect(await restarted.agora.isDirty()).toBe(false)
    expect(restarted.inbox('agent.b')).toEqual([`${sent.id}.json`])

    const { ExecGitRunner } = await import('../../src/main/git')
    const log = await new ExecGitRunner().run(path.join(company.home, 'agora'), [
      'log',
      '--format=%s'
    ])
    expect(log.stdout).toContain('reconcile uncommitted work after restart')
  })

  it('clears a lock the dead harness left behind', async () => {
    const company = await boot()
    company.hire('agent.a')
    const lock = path.join(company.home, 'agora', '.git', 'index.lock')
    fs.writeFileSync(lock, '', 'utf8')

    const restarted = await restartOver(company.home)

    expect(fs.existsSync(lock)).toBe(false)
    // And the committer works again afterwards.
    fs.writeFileSync(path.join(company.home, 'agora', 'after.txt'), 'x', 'utf8')
    await expect(restarted.agora.commit('after the blackout')).resolves.toMatchObject({
      attempts: 1
    })
  })

  it('keeps the event log intact across the blackout', async () => {
    const company = await boot()
    company.hire('agent.a')
    company.hire('agent.b')

    await company.runTurn('agent.a', [
      sendStep(scenarioMessage({ from: 'agent.a', to: 'agent.b' }))
    ])
    await company.hermes.sweep()
    const before = company.agora.readLog().map((e) => e.seq)
    expect(before.length).toBeGreaterThan(0)

    const restarted = await restartOver(company.home)

    // Every earlier event is still readable, and numbering carries on.
    expect(restarted.agora.readLog().map((e) => e.seq)).toEqual(before)
    const next = restarted.agora.appendLog({ kind: 'spawn', agentId: 'agent.c' })
    expect(next.seq).toBe((before.at(-1) ?? 0) + 1)
  })
})
/**
 * **S-BLACKOUT — killed holding the company's coordination state** (M8.8,
 * NFR-5, SRS §6 criterion 6).
 *
 * Every case above restarts a company that was holding NOTHING: the restarted
 * half is built with `liveAgents: () => []` and a fresh deny-all `GateManager`,
 * so "restore exactly" was asserted over an empty set and passed for years
 * while a restart silently un-hired the company. That is why this whole class
 * of defect was invisible to a green suite.
 *
 * These cases restart with an activation, a gate and a trigger clock LIVE, over
 * the real stores on a real disk. The first company is ABANDONED — never
 * reused, never asked a question — exactly as a killed Electron process is; the
 * second is built over the same home and must answer from what is on disk.
 */
describe('S-BLACKOUT — killed holding an activation, a gate and a trigger clock', () => {
  const HOUR = 3_600_000

  /** One harness lifetime over `home`: the stores, and the three subsystems. */
  function lifetime(home: string, nowMs = HOUR) {
    const stores: RestoreStores = {
      triggers: new JsonStateStore({
        file: path.join(home, TRIGGERS_REL),
        schema: triggersRecordSchema,
        empty: EMPTY_TRIGGERS
      }),
      activations: new JsonStateStore({
        file: path.join(home, ACTIVATIONS_REL),
        schema: activationsRecordSchema,
        empty: EMPTY_ACTIVATIONS
      }),
      gates: new JsonStateStore({
        file: path.join(home, GATES_REL),
        schema: gatesRecordSchema,
        empty: EMPTY_GATES
      }),
      drafts: new JsonStateStore({
        file: path.join(home, DRAFTS_REL),
        schema: draftsRecordSchema,
        empty: EMPTY_DRAFTS
      })
    }
    const scheduler = new Scheduler({
      now: () => new Date(nowMs),
      persist: (lastFired) => {
        stores.triggers.save({ schemaVersion: 1, lastFired: { ...lastFired } })
      }
    })
    const gates = new GateManager({
      policy: () => denyAllPolicy,
      persist: (record) => {
        stores.gates.save(record)
      },
      now: () => new Date(nowMs)
    })
    const activations = new ProfileActivations({
      store: new ProfileStore(path.join(home, 'profiles'), path.join(home, 'no-builtins')),
      globalAutonomy: () => 'autonomous',
      spawn: () => Promise.resolve({}),
      kill: () => {},
      addTrigger: (trigger) => scheduler.add(trigger),
      removeTrigger: (id) => scheduler.remove(id),
      targetExists: () => true,
      persist: (instances) => {
        stores.activations.save(activationsRecord(instances))
      }
    })
    // A REAL Front Office, wired to the real gates, because the draft an
    // outbound gate holds is the half M8.8 restored without (ADR-0030).
    const posted: PostPermit[] = []
    const frontOffice = new FrontOffice({
      outboundAutonomy: () => 'supervised',
      openGate: (request) => {
        const outcome = gates.submit({
          kind: 'outbound',
          agentId: request.agentId,
          packaging: {
            what: `comment on ${request.key}`,
            why: 'the issue asked a question',
            blastRadius: 'one public comment',
            rollback: 'delete the comment'
          }
        })
        return outcome.held ? outcome.gate.id : null
      },
      post: (permit) => {
        posted.push(permit)
        return Promise.resolve({ ok: true, because: null })
      },
      deliver: () => {},
      onLogEvent: () => {},
      persist: (record) => {
        stores.drafts.save(record)
      },
      now: () => new Date(nowMs)
    })
    return { stores, scheduler, gates, activations, frontOffice, posted }
  }

  function home(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-blackout-restart-'))
    blackoutHomes.push(dir)
    return dir
  }

  function held(gates: GateManager, taskId: string) {
    const outcome = gates.submit({
      agentId: 'agent.crew-myapp-oncall',
      kind: 'destructive',
      taskId,
      packaging: {
        what: 'rm -rf build',
        why: 'the build is stale',
        blastRadius: 'the build directory',
        rollback: 'rerun the build'
      }
    })
    if (!outcome.held) throw new Error('deny-all should have held this')
    return outcome.gate
  }

  /** What the FIRST process did before it was killed. */
  function firstLifetime(dir: string) {
    const first = lifetime(dir)
    writeBlackoutBundle(path.join(dir, 'profiles'))
    const gate = held(first.gates, 'task-1')
    first.scheduler.add({
      id: 'crew@repo:myapp/sweep',
      everyMs: HOUR,
      run: () => {}
    })
    return { gate, tick: first.scheduler.tick() }
  }

  it('a gate open at the blackout is in the queue after the restart', async () => {
    const dir = home()
    const { gate } = firstLifetime(dir)

    // The killed process is abandoned here — never touched again.
    const second = lifetime(dir, HOUR + 60_000)
    expect(second.gates.list()).toEqual([])

    const report = restoreCompany(second.stores, {
      restoreTriggers: (lastFired) => second.scheduler.restore(lastFired),
      restoreActivations: (record) => second.activations.restore(record.instances),
      restoreGates: (record) => second.gates.restore(record),
      restoreDrafts: (record) => second.frontOffice.restore(record),
      gatesHoldingADraft: () =>
        second.frontOffice.pending().flatMap((f) => (f.gateId === null ? [] : [f.gateId])),
      openGates: () => second.gates.list(),
      blockedTasks: () => [{ id: 'task-1', gates: [gate.id] }]
    })

    expect(second.gates.list().map((g) => g.id)).toEqual([gate.id])
    expect(second.gates.gatesFor('task-1')).toHaveLength(1)
    // The block is answerable again: no orphan, and a verdict lands.
    expect(report.counts.orphanBlocks).toBe(0)
    expect(second.gates.decide(gate.id, 'approved').ok).toBe(true)
  })

  /**
   * The defect stated plainly. Without the record, the restarted company holds
   * no gate while `tasks.json` still says the task is blocked — so the task can
   * never reach `done` and nothing in the queue explains why.
   */
  it('without the record the block is orphaned, and the restart SAYS so', () => {
    const dir = home()
    const second = lifetime(dir, HOUR + 60_000)

    const report = restoreCompany(second.stores, {
      restoreTriggers: (lastFired) => second.scheduler.restore(lastFired),
      restoreActivations: (record) => second.activations.restore(record.instances),
      restoreGates: (record) => second.gates.restore(record),
      restoreDrafts: (record) => second.frontOffice.restore(record),
      gatesHoldingADraft: () =>
        second.frontOffice.pending().flatMap((f) => (f.gateId === null ? [] : [f.gateId])),
      openGates: () => second.gates.list(),
      blockedTasks: () => [{ id: 'task-1', gates: ['g-2026-09-05t03-00-00-000z-deadbeef'] }]
    })

    expect(second.gates.list()).toEqual([])
    expect(report.counts.orphanBlocks).toBe(1)
    expect(report.problems[0]?.cause).toBe('restart/orphan-block:task-1')
    expect(report.problems[0]?.detail).toContain('cannot reach done')
  })

  /**
   * ADR-0030, and the defect the M8.8 audit found on 2026-09-06.
   *
   * M8.8 restored the outbound GATE and nothing restored the draft it held.
   * The Architect saw a gate whose packaging read correctly, approved it, and
   * `onVerdict` found nothing to post: the gate settled as approved, the log
   * recorded a verdict, and the comment never left the machine. The queue was
   * empty before M8.8, so the restore is what made this reachable.
   */
  function outboundDraft(): OutboundDraft {
    return {
      schemaVersion: 1,
      kind: 'outbound-draft',
      repo: 'owner/app',
      target: 'issue',
      ref: 412,
      body: 'Thanks for the report — I have opened a task to reproduce this.'
    }
  }

  function draftMessage(nowMs: number): Message {
    return composeMessage({
      id: makeMessageId(new Date(nowMs), 'draft1'),
      conversation: 'c-front-office',
      in_reply_to: null,
      from: 'agent.crew-myapp-oncall',
      to: HARBOR_ENDPOINT,
      act: 'inform',
      subject: OUTBOUND_SUBJECT,
      body: JSON.stringify(outboundDraft()),
      hops: 1,
      created_at: new Date(nowMs).toISOString()
    })
  }

  it('an outbound gate open at the blackout can still be POSTED after the restart', async () => {
    const dir = home()
    const first = lifetime(dir)
    await first.frontOffice.onDraft(draftMessage(HOUR))
    const gateId = first.gates.list()[0]?.id
    if (gateId === undefined) throw new Error('the draft should have opened a gate')
    expect(first.posted).toHaveLength(0)

    const second = lifetime(dir, HOUR + 60_000)
    const report = restoreCompany(second.stores, {
      restoreTriggers: (lastFired) => second.scheduler.restore(lastFired),
      restoreActivations: (record) => second.activations.restore(record.instances),
      restoreGates: (record) => second.gates.restore(record),
      restoreDrafts: (record) => second.frontOffice.restore(record),
      gatesHoldingADraft: () =>
        second.frontOffice.pending().flatMap((f) => (f.gateId === null ? [] : [f.gateId])),
      openGates: () => second.gates.list(),
      blockedTasks: () => []
    })

    expect(report.counts.drafts).toBe(1)
    expect(report.counts.draftlessGates).toBe(0)
    // The whole point: the Architect's approval reaches a real comment.
    expect(await second.frontOffice.onVerdict(gateId, true)).toBe(true)
    expect(second.posted).toHaveLength(1)
    expect(second.posted[0]?.draft.body).toBe(outboundDraft().body)
  })

  it('a gate whose draft did NOT come back is reported, not silently approved', async () => {
    const dir = home()
    const first = lifetime(dir)
    await first.frontOffice.onDraft(draftMessage(HOUR))
    // The record is damaged in exactly the way that loses the words and keeps
    // the gate — which is the state every restart was in before ADR-0030.
    fs.writeFileSync(path.join(dir, DRAFTS_REL), '{ "schemaVersion": 1, "drafts": [] }', 'utf8')

    const second = lifetime(dir, HOUR + 60_000)
    const report = restoreCompany(second.stores, {
      restoreTriggers: (lastFired) => second.scheduler.restore(lastFired),
      restoreActivations: (record) => second.activations.restore(record.instances),
      restoreGates: (record) => second.gates.restore(record),
      restoreDrafts: (record) => second.frontOffice.restore(record),
      gatesHoldingADraft: () =>
        second.frontOffice.pending().flatMap((f) => (f.gateId === null ? [] : [f.gateId])),
      openGates: () => second.gates.list(),
      blockedTasks: () => []
    })

    expect(report.counts.draftlessGates).toBe(1)
    const problem = report.problems.find((p) => p.cause.startsWith('restart/draftless-gate:'))
    expect(problem?.detail).toContain('post nothing')
    // Reported, never settled on the harness's own authority (NFR-9): the gate
    // is still there for the Architect to deny.
    expect(second.gates.list()).toHaveLength(1)
  })

  it('the activation is back, with its crew honestly down', async () => {
    const dir = home()
    const first = lifetime(dir)
    writeBlackoutBundle(path.join(dir, 'profiles'))
    const activated = await first.activations.activate({
      profile: 'crew',
      target: { kind: 'repo', id: 'myapp', path: dir }
    })
    if (!activated.ok) throw new Error(activated.reasons.join(' · '))

    const second = lifetime(dir, HOUR + 60_000)
    expect(second.activations.instances()).toEqual([])

    restoreCompany(second.stores, {
      restoreTriggers: (lastFired) => second.scheduler.restore(lastFired),
      restoreActivations: (record) => second.activations.restore(record.instances),
      restoreGates: (record) => second.gates.restore(record),
      restoreDrafts: (record) => second.frontOffice.restore(record),
      gatesHoldingADraft: () =>
        second.frontOffice.pending().flatMap((f) => (f.gateId === null ? [] : [f.gateId])),
      openGates: () => second.gates.list(),
      blockedTasks: () => []
    })

    const [instance] = second.activations.instances()
    expect(instance?.instanceId).toBe('crew@repo:myapp')
    expect(instance?.crew).toBe('down')
    // The M8.7 seam: a rehired agent must still find its plan.
    expect(second.activations.autonomyFor('agent.crew-myapp-oncall', 'tool-permission')).toBe(
      'autonomous'
    )
    // …and the Harbor watches again.
    expect(watchedRepos(second.activations.instances())).toEqual([])
  })

  it('a trigger that fired before the blackout is not due again at boot', async () => {
    const dir = home()
    const { tick } = firstLifetime(dir)
    await tick

    const second = lifetime(dir, HOUR + 60_000)
    const ran: string[] = []
    restoreCompany(second.stores, {
      restoreTriggers: (lastFired) => second.scheduler.restore(lastFired),
      restoreActivations: (record) => second.activations.restore(record.instances),
      restoreGates: (record) => second.gates.restore(record),
      restoreDrafts: (record) => second.frontOffice.restore(record),
      gatesHoldingADraft: () =>
        second.frontOffice.pending().flatMap((f) => (f.gateId === null ? [] : [f.gateId])),
      openGates: () => second.gates.list(),
      blockedTasks: () => []
    })
    second.scheduler.add({
      id: 'crew@repo:myapp/sweep',
      everyMs: HOUR,
      run: () => {
        ran.push('sweep')
      }
    })

    await second.scheduler.tick()

    expect(ran).toEqual([])
  })

  /** Nothing was ever written, so a first run must restore nothing and be quiet. */
  it('a first run over an empty home restores nothing and reports nothing', () => {
    const second = lifetime(home())
    const report = restoreCompany(second.stores, {
      restoreTriggers: (lastFired) => second.scheduler.restore(lastFired),
      restoreActivations: (record) => second.activations.restore(record.instances),
      restoreGates: (record) => second.gates.restore(record),
      restoreDrafts: (record) => second.frontOffice.restore(record),
      gatesHoldingADraft: () =>
        second.frontOffice.pending().flatMap((f) => (f.gateId === null ? [] : [f.gateId])),
      openGates: () => second.gates.list(),
      blockedTasks: () => []
    })

    expect(report.problems).toEqual([])
    expect(report.notes).toEqual([])
  })

  /**
   * Damaged is not absent. State exists that can no longer be read, and the
   * company must say so rather than come back looking healthy and empty.
   */
  it('a damaged record is reported, and costs only its own subsystem', () => {
    const dir = home()
    const first = lifetime(dir)
    held(first.gates, 'task-1')
    fs.writeFileSync(path.join(dir, ACTIVATIONS_REL), '{ not json')

    const second = lifetime(dir, HOUR + 60_000)
    const report = restoreCompany(second.stores, {
      restoreTriggers: (lastFired) => second.scheduler.restore(lastFired),
      restoreActivations: (record) => second.activations.restore(record.instances),
      restoreGates: (record) => second.gates.restore(record),
      restoreDrafts: (record) => second.frontOffice.restore(record),
      gatesHoldingADraft: () =>
        second.frontOffice.pending().flatMap((f) => (f.gateId === null ? [] : [f.gateId])),
      openGates: () => second.gates.list(),
      blockedTasks: () => []
    })

    expect(report.problems.map((p) => p.cause)).toEqual(['restart/activations-unreadable'])
    expect(report.problems[0]?.detail).toContain('comes back un-hired')
    // The gates still came back: one damaged record costs its own subsystem.
    expect(second.gates.list()).toHaveLength(1)
  })
})

/** A bundle the activation above can load off a real disk (M8.8). */
function writeBlackoutBundle(root: string): void {
  const dir = path.join(root, 'crew')
  fs.mkdirSync(path.join(dir, 'hires'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'triggers'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'playbooks'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'profile.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'crew',
      version: 1,
      target: { kind: 'repo' },
      autonomy: { default: 'autonomous', byKind: {} }
    })
  )
  fs.writeFileSync(
    path.join(dir, 'memo-policy.json'),
    JSON.stringify({ schemaVersion: 1, requires: [] })
  )
  fs.writeFileSync(
    path.join(dir, 'harbor.json'),
    JSON.stringify({ schemaVersion: 1, repos: [], channels: [], webhooks: [] })
  )
  fs.writeFileSync(
    path.join(dir, 'hires', 'oncall.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'oncall',
      version: 1,
      role: 'oncall',
      engine: 'claude',
      capabilities: ['triage'],
      envGrants: [],
      brief: 'Work.'
    })
  )
}
