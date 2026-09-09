import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ENDPOINT_CONTRACTS, endpointContract } from '../../src/shared/endpoints'
import { RESERVED_AGENT_IDS } from '../../src/shared/reserved'
import { SPEECH_ACTS, type SpeechAct } from '../../src/shared/message'

/**
 * Every act a shipped prompt tells an agent to send must be one the endpoint
 * it names actually accepts (M8b.4 — Finding 12).
 *
 * ## The run this comes from
 *
 * Artemis tried to end a meeting and was bounced (seq 439–440):
 *
 * > the odeon endpoint takes "propose", "inform", "agree", "refuse" or "done"
 * > acts; got "request"
 *
 * She recovered by re-sending as `refuse`, so it cost a round trip rather than
 * a deadlock — and it is only invisible BECAUSE the agent worked around it.
 * The refusal itself is good: it enumerates the accepted acts and is recorded
 * as `hermes/bounce`. What was missing is anything that would have stopped the
 * mismatch being written down in the first place.
 *
 * ## Why this is asserted against the contract and not a list
 *
 * M8b.4's acceptance is exact: *"asserted against the endpoint's own schema
 * rather than against a copy of it."* A test carrying its own table of
 * accepted acts is a second place to be wrong, and it would agree with
 * `ENDPOINT_CONTRACTS` right up until somebody narrowed one of them.
 *
 * So this reads the SHIPPED prompt files, extracts the act each one instructs
 * beside the endpoint it names, and checks that act against
 * `endpointContract(id).accepts`. Both halves come from the tree; neither is
 * typed here.
 *
 * ## What it deliberately does not do
 *
 * It does not check acts agents invent for themselves. Artemis's `request` was
 * self-composed — there was no adjourn mechanism to instruct her toward, which
 * is M8b.2's subject rather than this one. This closes the half that IS
 * mechanisable: a prompt that ships an act the endpoint refuses.
 */

const PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))

/** Every `.md` under `prompts/`, relative to it, sorted. */
function promptFiles(dir: string = PROMPTS, prefix = ''): readonly string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) return promptFiles(path.join(dir, entry.name), rel)
      return entry.isFile() && entry.name.endsWith('.md') ? [rel] : []
    })
    .sort()
}

/** One instruction found in a prompt: "send `<act>` to `<endpoint>`". */
interface Instruction {
  readonly file: string
  readonly act: SpeechAct
  readonly endpoint: string
  readonly line: string
}

/**
 * The two shapes the shipped prompts actually use, and only those.
 *
 * Deliberately narrow. A looser scan would match prose ABOUT an act — the
 * bounce message quoted in a comment, a paragraph explaining why `done` is an
 * aside — and a test that fails on documentation is a test people delete.
 */
const PATTERNS: readonly RegExp[] = [
  // Reply as a `propose` message to `agent.odeon`
  /as an? `(\w+)` message to `(agent\.[a-z-]+)`/gi,
  // Answer `agent.odeon` with `act: "refuse"`
  /`(agent\.[a-z-]+)` with `act: "(\w+)"`/gi
]

function instructionsIn(file: string): readonly Instruction[] {
  const text = fs.readFileSync(path.join(PROMPTS, file), 'utf8')
  const found: Instruction[] = []
  for (const [index, pattern] of PATTERNS.entries()) {
    for (const match of text.matchAll(pattern)) {
      const act = (index === 0 ? match[1] : match[2]) ?? ''
      const endpoint = (index === 0 ? match[2] : match[1]) ?? ''
      if (!SPEECH_ACTS.includes(act as SpeechAct)) continue
      found.push({ file, act: act as SpeechAct, endpoint, line: match[0] })
    }
  }
  return found
}

const ALL: readonly Instruction[] = promptFiles().flatMap(instructionsIn)

describe('a prompt never instructs an act its endpoint refuses (M8b.4)', () => {
  it('finds instructions at all, or this suite proves nothing', () => {
    // The guard that keeps this file honest. A regex that stops matching would
    // otherwise turn every assertion below into a pass over an empty list —
    // which is the vacuous-green shape this build has paid for before.
    expect(ALL.length).toBeGreaterThanOrEqual(4)
    expect(new Set(ALL.map((row) => row.endpoint)).size).toBeGreaterThan(0)
  })

  it('every instruction names an endpoint that exists', () => {
    for (const row of ALL) {
      expect(
        RESERVED_AGENT_IDS,
        `${row.file} tells an agent to write to "${row.endpoint}", which is not a reserved id`
      ).toContain(row.endpoint)
    }
  })

  it('every instructed act is one the endpoint ACCEPTS', () => {
    for (const row of ALL) {
      const contract = endpointContract(row.endpoint)
      expect(contract, `${row.file} names ${row.endpoint}, which has no contract`).toBeDefined()
      expect(
        contract?.accepts,
        `${row.file} instructs "${row.act}" to ${row.endpoint} — ` +
          `it takes ${contract?.accepts.join('/') ?? 'nothing'}. ` +
          `That is Finding 12: the bounce Artemis met at seq 439.`
      ).toContain(row.act)
    }
  })

  it('every instructed act is one the endpoint HANDLES, not merely tolerates', () => {
    // Accepted-but-unhandled is recorded as an aside and acted on by nobody.
    // A prompt that instructs one is telling an agent to do something that
    // will be filed and ignored — which is exactly what happened to the
    // declined floor before M8b.2 moved `refuse` into the odeon's `handles`.
    for (const row of ALL) {
      const contract = endpointContract(row.endpoint)
      expect(
        contract?.handles,
        `${row.file} instructs "${row.act}" to ${row.endpoint}, which ACCEPTS it ` +
          `but does not HANDLE it — the agent's message would be recorded as an ` +
          `aside and acted on by nobody`
      ).toContain(row.act)
    }
  })
})

describe('the odeon’s own vocabulary is the one the run met', () => {
  it('takes exactly the acts its bounce message enumerated', () => {
    // The literal sentence from seq 439–440, pinned. If the accept-set ever
    // narrows, the refusal an agent reads and this assertion move together.
    const odeon = ENDPOINT_CONTRACTS.find((contract) => contract.name === 'odeon')
    expect([...(odeon?.accepts ?? [])].sort()).toEqual(
      ['agree', 'done', 'inform', 'propose', 'refuse'].sort()
    )
  })

  it('does not accept `request`, which is what Artemis sent', () => {
    // Kept as an explicit negative rather than left implicit in the set above:
    // this is the act the orchestrator reached for when she wanted to adjourn,
    // and M8b.2's answer was to give her `refuse` and a verb rather than to
    // widen the endpoint until anything is acceptable.
    const odeon = ENDPOINT_CONTRACTS.find((contract) => contract.name === 'odeon')
    expect(odeon?.accepts).not.toContain('request')
  })
})
