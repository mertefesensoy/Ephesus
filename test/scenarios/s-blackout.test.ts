import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupHomes, startCompany, scenarioMessage, sendStep, type Company } from './company'

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
    expect(restarted.done('agent.b')).toEqual([`${sent.id}.json`])
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

    // The agent got the mail; the harness died before finishing the turn.
    await expect(company.hermes.consumeInbox('agent.b')).rejects.toThrow(/blackout/)
    expect(company.done('agent.b')).toEqual([`${sent.id}.json`])

    const restarted = await restartOver(company.home)
    expect(await restarted.hermes.consumeInbox('agent.b')).toEqual([])
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
