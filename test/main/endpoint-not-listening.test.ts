import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import { HARBOR_ENDPOINT, HERMES_SENDER, PROFILE_ENDPOINT } from '../../src/shared/reserved'
import type { RoutingContext } from '../../src/shared/routing'
import { Agora } from '../../src/main/agora'
import { Hermes } from '../../src/main/hermes'
import { PromptStore } from '../../src/main/prompts'
import { removeTempDir } from '../tmpdir'

/**
 * What happens to a message for an endpoint that is not wired.
 *
 * The two endpoints an Ephesus can legitimately run without — Harbor is absent
 * when nothing is watching a repository, and the profile endpoint when no
 * bundle is installed — and both are reachable by address from any agent's
 * outbox. The rule (`hermes.ts` §"profile endpoint is listening") is BOUNCE,
 * never drop: an agent that files an incident into a company with no Harbor
 * must be told, or it waits for an answer that is never coming and the operator
 * sees an agent that simply stopped.
 *
 * Both refusals were unreachable by any test until now, so "it bounces" was a
 * comment rather than a fact.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
const homes: string[] = []
const agoras: Agora[] = []

afterEach(async () => {
  for (const agora of agoras.splice(0)) await agora.drained().catch(() => {})
  for (const home of homes.splice(0)) removeTempDir(home)
})

interface Rig {
  readonly hermes: Hermes
  post(ownerId: string, message: Message): void
  sweep(): Promise<void>
  inbox(agentId: string): Message[]
}

async function rig(): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-noendpoint-'))
  homes.push(home)
  const prompts = new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS)
  const agora = new Agora({ root: path.join(home, 'agora'), prompts, backoffMs: 1 })
  await agora.ensureRepo()
  agoras.push(agora)

  // Deliberately no `harbor` and no `profiles`: this rig IS the condition.
  const hermes: Hermes = new Hermes({
    agora,
    prompts,
    context: (): RoutingContext => ({
      knownAgents: hermes.knownAgents(),
      orchestratorId: 'agent.artemis'
    })
  })
  hermes.ensureMailbox('agent.mason')

  return {
    hermes,
    post: (ownerId, message) => {
      const outbox = path.join(hermes.mailboxDir(ownerId), 'outbox')
      fs.mkdirSync(outbox, { recursive: true })
      fs.writeFileSync(path.join(outbox, `${message.id}.json`), JSON.stringify(message, null, 2))
    },
    sweep: async () => {
      await hermes.sweep()
    },
    inbox: (agentId) => {
      const dir = path.join(hermes.mailboxDir(agentId), 'inbox')
      if (!fs.existsSync(dir)) return []
      return fs
        .readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Message)
    }
  }
}

let seq = 0
function addressed(to: string, subject: string): Message {
  return composeMessage({
    id: makeMessageId(new Date(2026, 8, 6, 9, 0, seq++), 'bb22'),
    conversation: 'conv-endpoint',
    from: 'agent.mason',
    to,
    // Both endpoints take 'inform'; a bad act bounces on the ROUTE, before
    // the endpoint is consulted, which is a different refusal entirely.
    act: 'inform',
    subject,
    body: JSON.stringify({ note: 'anything — it never reaches a handler' }),
    created_at: new Date().toISOString()
  })
}

describe('an endpoint nobody is listening on bounces, and never drops', () => {
  it('tells the sender when there is no Harbor to take an incident', async () => {
    const r = await rig()
    r.post('agent.mason', addressed(HARBOR_ENDPOINT, 'the build is red on main'))

    await r.sweep()

    const [bounced] = r.inbox('agent.mason')
    expect(bounced?.from).toBe(HERMES_SENDER)
    // The router wrote it, so it says so — and it says WHY, because "no
    // incident endpoint is listening" is an operator's fact, not the agent's
    // fault, and an agent told only "refused" will retry forever.
    expect(bounced?.body).toContain('no incident endpoint is listening')
  })

  it('tells the sender when no profile endpoint is installed', async () => {
    const r = await rig()
    r.post('agent.mason', addressed(PROFILE_ENDPOINT, 'activate the skeleton crew'))

    await r.sweep()

    const [bounced] = r.inbox('agent.mason')
    expect(bounced?.from).toBe(HERMES_SENDER)
    expect(bounced?.body).toContain('no profile endpoint is listening')
  })
})
