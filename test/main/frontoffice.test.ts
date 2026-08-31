import { describe, expect, it } from 'vitest'
import { FrontOffice, OUTBOUND_SUBJECT } from '../../src/main/frontoffice'
import { HARBOR_ENDPOINT } from '../../src/shared/reserved'
import { composeMessage, makeMessageId, type Message } from '../../src/shared/message'
import type { OutboundDraft, PostPermit } from '../../src/shared/outbound'
import type { AutonomyLevel } from '../../src/shared/gates'

/**
 * The Front Office's outbound desk (FR-9.3, UC-10 step 3 — M7.5).
 *
 * The package line asks for three things and each has its own block below:
 * the autonomy ladder as a table (every rung, what it does AND what it
 * refuses); a draft-only profile with no code path that posts; and batching
 * into the standup that PRESERVES the gate rather than replacing it.
 */

const AUTHOR = 'agent.front-office-myapp-triage-agent'

const DRAFT: OutboundDraft = {
  schemaVersion: 1,
  kind: 'outbound-draft',
  repo: 'owner/app',
  target: 'issue',
  ref: 412,
  body: 'Thanks for the report — I have opened a task to reproduce this.'
}

interface Rig {
  readonly office: FrontOffice
  readonly posted: PostPermit[]
  readonly gates: { agentId: string; key: string; draft: OutboundDraft }[]
  readonly delivered: Message[]
  readonly logged: Record<string, unknown>[]
}

function rig(level: AutonomyLevel | null, postOk = true): Rig {
  const posted: PostPermit[] = []
  const gates: { agentId: string; key: string; draft: OutboundDraft }[] = []
  const delivered: Message[] = []
  const logged: Record<string, unknown>[] = []
  let gateSeq = 0
  const office = new FrontOffice({
    outboundAutonomy: () => level,
    openGate: (request) => {
      gates.push(request)
      gateSeq += 1
      return `gate-${String(gateSeq)}`
    },
    post: (permit) => {
      posted.push(permit)
      return Promise.resolve({ ok: postOk, because: postOk ? null : 'gh exploded' })
    },
    deliver: (message) => delivered.push(message),
    onLogEvent: (draft) => logged.push(draft),
    now: () => new Date('2026-08-31T12:00:00.000Z')
  })
  return { office, posted, gates, delivered, logged }
}

function draftMessage(body: unknown = DRAFT, from = AUTHOR): Message {
  return composeMessage({
    id: makeMessageId(new Date('2026-08-31T11:59:00.000Z'), 'draft1'),
    conversation: 'c-front-office',
    in_reply_to: null,
    from,
    to: HARBOR_ENDPOINT,
    act: 'inform',
    subject: OUTBOUND_SUBJECT,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    hops: 1,
    created_at: '2026-08-31T11:59:00.000Z'
  })
}

describe('the ladder, rung by rung — what it does and what it refuses', () => {
  it('manual: files the draft, sends nothing, opens no gate', async () => {
    const { office, posted, gates, logged } = rig('manual')
    const disposition = await office.onDraft(draftMessage())

    expect(disposition).toEqual({ kind: 'file', because: 'draft-only' })
    // What it REFUSES is the assertion that matters.
    expect(posted).toEqual([])
    expect(gates).toEqual([])
    expect(office.drafts()).toHaveLength(1)
    expect(office.pending()).toHaveLength(0)
    expect(logged.find((row) => row.event === 'outbound-filed')).toMatchObject({
      because: 'draft-only'
    })
  })

  it('supervised: opens a gate and holds; still sends nothing', async () => {
    const { office, posted, gates, logged } = rig('supervised')
    const disposition = await office.onDraft(draftMessage())

    expect(disposition).toEqual({ kind: 'hold', because: 'above-configured-level' })
    expect(posted).toEqual([])
    expect(gates).toHaveLength(1)
    expect(gates[0]?.agentId).toBe(AUTHOR)
    expect(gates[0]?.key).toBe('owner/app#issue:412')
    // The WHOLE draft reaches the gate: UC-08's packaging is what the Architect
    // reads, and approving a comment without its text is signing a blank page.
    expect(gates[0]?.draft.body).toBe(DRAFT.body)
    expect(office.pending()).toHaveLength(1)
    expect(logged.find((row) => row.event === 'outbound-held')).toMatchObject({ gate: 'gate-1' })
  })

  it('autonomous: posts, and the log says the autonomy permitted it', async () => {
    const { office, posted, gates, logged } = rig('autonomous')
    const disposition = await office.onDraft(draftMessage())

    expect(disposition).toEqual({ kind: 'post' })
    expect(posted).toHaveLength(1)
    expect(posted[0]?.granted).toBe('autonomy')
    // No gate: this is the rung where the Architect already said yes, once, in
    // the profile — which is exactly why it is worth being able to tell apart
    // from an approved post later.
    expect(gates).toEqual([])
    expect(logged.some((row) => row.event === 'outbound-held')).toBe(false)
  })

  it('an agent on no profile is treated as draft-only, not as trusted', async () => {
    const { office, posted } = rig(null)
    const disposition = await office.onDraft(draftMessage())
    // Null autonomy means nobody put this agent on a profile. It gets the
    // strictest rung, not the benefit of the doubt about speaking publicly.
    expect(disposition?.kind).toBe('file')
    expect(posted).toEqual([])
  })
})

describe('a draft-only profile has no code path that posts', () => {
  it('never calls the poster, for any draft, however many arrive', async () => {
    const { office, posted } = rig('manual')
    await office.onDraft(draftMessage())
    await office.onDraft(draftMessage({ ...DRAFT, ref: 413 }))
    await office.onDraft(draftMessage({ ...DRAFT, target: 'pull-request', ref: 99 }))
    expect(posted).toEqual([])
  })

  it('cannot be made to post by a verdict on a gate it never opened', async () => {
    const { office, posted } = rig('manual')
    await office.onDraft(draftMessage())
    // A forged or stale gate id must not find a draft to release.
    expect(await office.onVerdict('gate-1', true)).toBe(false)
    expect(posted).toEqual([])
  })

  it('tells the author the draft was filed, so a filed draft is not mistaken for a sent one', async () => {
    const { office, delivered } = rig('manual')
    await office.onDraft(draftMessage())
    const reply = delivered.at(-1)
    expect(reply?.act).toBe('agree')
    expect(reply?.to).toBe(AUTHOR)
    expect(reply?.body).toMatch(/nothing was sent/)
  })
})

describe('batching into the standup preserves the gate', () => {
  it('posts only after the Architect approves, and names the gate that permitted it', async () => {
    const { office, posted } = rig('supervised')
    await office.onDraft(draftMessage())
    expect(posted).toEqual([])

    expect(await office.onVerdict('gate-1', true)).toBe(true)
    expect(posted).toHaveLength(1)
    expect(posted[0]?.granted).toBe('architect-approval')
    expect(posted[0]?.gateId).toBe('gate-1')
    // Released from the pending set, so the next standup does not re-raise it.
    expect(office.pending()).toHaveLength(0)
  })

  it('drops the draft on rejection, and never posts it', async () => {
    const { office, posted, logged } = rig('supervised')
    await office.onDraft(draftMessage())

    expect(await office.onVerdict('gate-1', false)).toBe(true)
    expect(posted).toEqual([])
    expect(logged.find((row) => row.event === 'outbound-rejected')).toBeDefined()
    expect(office.pending()).toHaveLength(0)
  })

  it('cannot be approved twice into two posts', async () => {
    const { office, posted } = rig('supervised')
    await office.onDraft(draftMessage())
    expect(await office.onVerdict('gate-1', true)).toBe(true)
    // The second verdict finds nothing waiting — the draft is not re-sent.
    expect(await office.onVerdict('gate-1', true)).toBe(false)
    expect(posted).toHaveLength(1)
  })

  it('holds the draft when no gate could be opened, rather than sending it', async () => {
    const { office, posted, delivered } = rig('supervised')
    const noGate = new FrontOffice({
      outboundAutonomy: () => 'supervised',
      openGate: () => null,
      post: () => {
        throw new Error('the poster must not be reached when no gate exists')
      },
      deliver: (message) => delivered.push(message),
      onLogEvent: () => {}
    })
    const disposition = await noGate.onDraft(draftMessage())
    expect(disposition?.kind).toBe('hold')
    expect(posted).toEqual([])
    expect(delivered.at(-1)?.body).toMatch(/no gate could be opened/)
    void office
  })
})

describe('an unreadable draft is refused, never partly sent', () => {
  it('refuses a malformed body and tells the author why', async () => {
    const { office, posted, delivered, logged } = rig('autonomous')
    const disposition = await office.onDraft(draftMessage('not json at all'))

    expect(disposition).toBeNull()
    // Autonomous, and still nothing went out — the refusal comes first.
    expect(posted).toEqual([])
    expect(delivered.at(-1)?.act).toBe('refuse')
    expect(logged.find((row) => row.event === 'outbound-refused')).toBeDefined()
  })

  it('refuses an empty comment even at auto-post', async () => {
    const { office, posted } = rig('autonomous')
    await office.onDraft(draftMessage({ ...DRAFT, body: '' }))
    expect(posted).toEqual([])
  })
})

describe('a failed send is reported, never silently swallowed', () => {
  it('tells the author the post did not go out', async () => {
    const { office, delivered } = rig('autonomous', false)
    await office.onDraft(draftMessage())
    const reply = delivered.at(-1)
    expect(reply?.act).toBe('refuse')
    expect(reply?.body).toMatch(/could not send/)
  })
})
