import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SECRET_SHAPE_SOURCES, secretShapeIn } from '../../src/shared/secret-shapes'

/**
 * The runtime secret-shape list, and its agreement with the build gate.
 *
 * `scripts/check-invariants.cjs` is a standalone `.cjs` gate that runs before
 * anything is compiled, so it cannot import the module under test. That leaves
 * two copies of a security-relevant list, which is normally how a check quietly
 * stops catching things: somebody adds a pattern to one side, and the other
 * side silently keeps passing.
 *
 * This suite is the mechanism that makes the duplication safe rather than
 * merely regrettable. It reads the checker as TEXT and compares the lists
 * element by element, so drift fails here, by name, in the same commit that
 * causes it.
 */

const CHECKER = path.join(__dirname, '..', '..', 'scripts', 'check-invariants.cjs')

/** Pulls the checker's `SECRET_SHAPED` array out of its source, as strings. */
function checkerPatterns(): string[] {
  const source = fs.readFileSync(CHECKER, 'utf8')
  const block = /const SECRET_SHAPED = new RegExp\(\s*\[([\s\S]*?)\]\s*\.join/.exec(source)
  if (block === null) {
    throw new Error(
      'check-invariants.cjs no longer declares SECRET_SHAPED as a joined array — ' +
        'this test can no longer verify the two lists agree, which is worse than a mismatch'
    )
  }
  return [...(block[1] ?? '').matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) =>
    (match[1] ?? '').replace(/\\'/g, "'")
  )
}

describe('the runtime list and the build gate agree', () => {
  it('carries exactly the same patterns, in the same order', () => {
    // Element-wise, so a failure names the pattern that differs rather than
    // printing two long arrays and leaving the reader to diff them.
    expect(checkerPatterns()).toEqual([...SECRET_SHAPE_SOURCES])
  })

  it('fails loudly if the checker stops declaring the list in a readable shape', () => {
    // The extractor throwing is the point: silently finding nothing would make
    // this suite pass forever against an empty list.
    const source = fs.readFileSync(CHECKER, 'utf8')
    expect(source).toContain('const SECRET_SHAPED = new RegExp(')
  })
})

/**
 * Synthetic fixtures, assembled at runtime from halves.
 *
 * A test for a credential detector necessarily needs credential-shaped inputs,
 * and `check-invariants.cjs` — correctly — forbids one written as a literal
 * anywhere under `test/`. Joining two halves keeps the tripwire intact and
 * unmodified rather than punching an allowlist hole through it for this file,
 * which would leave a place a REAL credential could later sit unnoticed.
 *
 * Nothing here is a real credential: every body is `abcdef…`/digits.
 */
const shaped = (prefix: string, body: string): string => `${prefix}${body}`

describe('secretShapeIn names what it found, never quotes it', () => {
  const planted: readonly [string, string][] = [
    [shaped('sk' + '-', 'abcdefghijklmnopqrstuvwx'), 'an OpenAI-style key'],
    [shaped('ghp' + '_', 'abcdefghijklmnopqrstuvwxyz0123'), 'a GitHub token'],
    [shaped('github' + '_pat_', 'abcdefghijklmnopqrstuvwxyz012345'), 'a GitHub fine-grained token'],
    [shaped('xoxb' + '-', '1234567890-abcdefghij'), 'a Slack token'],
    [shaped('AKI' + 'A', 'ABCDEFGHIJKLMNOP'), 'an AWS access key id'],
    [shaped('AIz' + 'a', 'SyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456'), 'a Google API key'],
    [shaped('-----BEGIN ' + 'RSA ', 'PRIVATE KEY-----'), 'a PEM private key']
  ]

  for (const [secret, name] of planted) {
    it(`catches ${name}`, () => {
      expect(secretShapeIn(`the value is ${secret} and that is all`)).toBe(name)
    })
  }

  it('never returns the matched text itself', () => {
    const secret = shaped('ghp' + '_', 'abcdefghijklmnopqrstuvwxyz0123')
    const found = secretShapeIn(secret)
    // A refusal that quoted the credential would copy it into the log, the UI,
    // and any bug report the Architect pastes it into — turning a caught leak
    // into a wider one.
    expect(found).not.toContain(secret)
    expect(found).toBe('a GitHub token')
  })

  it('finds nothing in ordinary bundle text', () => {
    expect(secretShapeIn('')).toBeNull()
    expect(secretShapeIn('GH_TOKEN')).toBeNull()
    expect(secretShapeIn('Follow playbooks/incident.md and report the severity.')).toBeNull()
    // An env grant NAME is the legal thing to carry (ADR-0010); only a VALUE is not.
    expect(secretShapeIn('{"envGrants":["GH_TOKEN","AWS_SECRET_ACCESS_KEY"]}')).toBeNull()
  })

  it('is honest about its reach: an unshaped password matches nothing', () => {
    // Pinned so nobody later reads a clean result as a safety guarantee. The
    // import path says "no known credential shape found", not "safe".
    expect(secretShapeIn('hunter2correcthorsebatterystaple9182736455')).toBeNull()
  })
})
