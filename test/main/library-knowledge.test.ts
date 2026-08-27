import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Library } from '../../src/main/library'
import { PromptStore } from '../../src/main/prompts'

/**
 * The knowledge shelf (FR-6.4) and the Memory panel's view (SDD §5
 * `agora.memory(id)`).
 *
 * The rule under test that actually bites: **the renderer is untrusted**
 * (invariant §2). A document name arrives from a text box, so the path it
 * resolves to is checked here, at the boundary that writes, and not only in the
 * IPC schema — a traversal that one refactor away from the schema would be
 * possible again is not prevented, it is postponed.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function rig(): { library: Library; agoraRoot: string; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-shelf-'))
  temps.push(home)
  const agoraRoot = path.join(home, 'agora')
  const prompts = new PromptStore(path.join(home, 'prompts'), path.join(REPO, 'prompts'))
  return { library: new Library({ agoraRoot, prompts }), agoraRoot, home }
}

describe('the knowledge shelf (FR-6.4)', () => {
  it('starts empty and is not an error', () => {
    expect(rig().library.knowledge()).toEqual([])
  })

  it('registers a document, adds .md, and lists it', () => {
    const { library, agoraRoot } = rig()
    const shelf =
      (library.registerKnowledge('release-runbook', '# Release runbook\n\nTag first.'),
      library.knowledge())

    expect(shelf).toHaveLength(1)
    expect(shelf[0]?.name).toBe('release-runbook.md')
    expect(shelf[0]?.text).toContain('Tag first.')
    expect(shelf[0]?.bytes).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(agoraRoot, 'knowledge', 'release-runbook.md'))).toBe(true)
  })

  it('keeps an explicit .md rather than doubling it', () => {
    const { library } = rig()
    library.registerKnowledge('style-guide.md', 'x')
    expect(library.knowledge().map((doc) => doc.name)).toEqual(['style-guide.md'])
  })

  it('replaces a document registered again under the same name', () => {
    const { library } = rig()
    library.registerKnowledge('runbook', 'first')
    library.registerKnowledge('runbook', 'second')
    expect(library.knowledge()).toHaveLength(1)
    expect(library.knowledge()[0]?.text).toContain('second')
  })

  it('refuses a name that would write outside the shelf', () => {
    const { library, home } = rig()
    for (const name of ['../escape', '/etc/passwd', 'sub/dir', '..', '.hidden', '']) {
      expect(() => library.registerKnowledge(name, 'x')).toThrow(/not a legal knowledge document/)
    }
    // Nothing was written anywhere.
    expect(fs.existsSync(path.join(home, 'escape.md'))).toBe(false)
    expect(library.knowledge()).toEqual([])
  })

  it('writes atomically — no temp file survives', () => {
    const { library, agoraRoot } = rig()
    library.registerKnowledge('runbook', 'body')
    expect(
      fs.readdirSync(path.join(agoraRoot, 'knowledge')).filter((n) => n.endsWith('.tmp'))
    ).toEqual([])
  })

  it('never commits: the single committer owns that (ADR-0004)', () => {
    const { library, agoraRoot } = rig()
    library.registerKnowledge('runbook', 'body')
    // The Library made a file and no repository.
    expect(fs.existsSync(path.join(agoraRoot, '.git'))).toBe(false)
  })

  it('is searchable by any agent as soon as it is registered', async () => {
    const { library } = rig()
    library.registerKnowledge('release-runbook', '# Release runbook\n\nPromote staging last.')
    const answer = await library.recall('promote staging')
    expect(answer.hits[0]?.source).toBe('knowledge')
    expect(answer.hits[0]?.scope).toBe('release-runbook')
  })
})

describe('the memory view (SDD §5 agora.memory(id))', () => {
  it('carries the text, the section count and the reflection state', () => {
    const { library } = rig()
    library.note('agent.mason', 'agent.mason', 'The checkout suite is flaky.')
    const view = library.memoryView('agent.mason')

    expect(view.agentId).toBe('agent.mason')
    expect(view.path).toContain(path.join('agents', 'agent.mason', 'memory.md'))
    expect(view.text).toContain('The checkout suite is flaky.')
    // Preamble + the one written section.
    expect(view.sections).toBe(2)
    expect(view.reflection.due).toBe(false)
    expect(view.reflection.because).toContain('under the')
    expect(view.reflection.chars).toBeGreaterThan(0)
  })

  it('carries the archive, so the panel can browse it', () => {
    const { library, agoraRoot } = rig()
    library.seed('agent.mason')
    fs.writeFileSync(
      path.join(agoraRoot, 'agents', 'agent.mason', 'memory-archive', '2026-08-01-001.md'),
      '# Archive\n\nolder things\n',
      'utf8'
    )
    const view = library.memoryView('agent.mason')
    expect(view.archive).toHaveLength(1)
    expect(view.archive[0]?.name).toBe('2026-08-01-001.md')
    expect(view.archive[0]?.text).toContain('older things')
  })

  it('answers for an agent with no memory at all, rather than throwing', () => {
    const view = rig().library.memoryView('agent.nobody')
    expect(view.text).toBe('')
    expect(view.sections).toBe(0)
    expect(view.archive).toEqual([])
    expect(view.reflection.due).toBe(false)
  })
})
