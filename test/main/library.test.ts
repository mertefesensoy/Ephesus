import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Library } from '../../src/main/library'
import { PromptStore } from '../../src/main/prompts'
import { parseMemorySections } from '../../src/shared/memory'

/**
 * The Library's layer 1 (ADR-0006, FR-6.1) against a real filesystem — the
 * mechanism under test *is* the file, so nothing here is mocked.
 *
 * The bundled prompts are the repo's own, not fixtures: the seed header and the
 * elision notice are agent-facing text (invariant §8), and a test with its own
 * copies would go green while the shipped ones were broken.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function rig(): { library: Library; agoraRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-library-'))
  temps.push(root)
  const agoraRoot = path.join(root, 'agora')
  const prompts = new PromptStore(path.join(root, 'prompts'), path.join(REPO, 'prompts'))
  return { library: new Library({ agoraRoot, prompts }), agoraRoot }
}

describe('Library.seed (FR-6.1: memory seeded at hire)', () => {
  it('writes memory.md and the archive directory for a new hire', () => {
    const { library } = rig()
    expect(library.seed('agent.mason')).toBe(true)
    expect(fs.existsSync(library.memoryPath('agent.mason'))).toBe(true)
    expect(fs.existsSync(library.archiveDir('agent.mason'))).toBe(true)
    expect(library.read('agent.mason')).toContain('agent.mason')
  })

  it('never touches an existing memory — the respawn case', () => {
    const { library } = rig()
    library.seed('agent.mason')
    library.note('agent.mason', 'agent.mason', 'The staging DB resets at 03:00.')
    const before = library.read('agent.mason')

    expect(library.seed('agent.mason')).toBe(false)
    expect(library.read('agent.mason')).toBe(before)
  })
})

describe('Library.append (append-only, NFR-7)', () => {
  it('leaves every earlier byte in place as a strict prefix', () => {
    const { library } = rig()
    library.note('agent.a', 'agent.a', 'first learning')
    const after1 = library.read('agent.a')
    library.note('agent.a', 'agent.a', 'second learning')
    const after2 = library.read('agent.a')

    expect(after2.startsWith(after1.replace(/\s+$/, ''))).toBe(true)
    expect(after2).toContain('first learning')
    expect(after2).toContain('second learning')
  })

  it('keeps sections in the order they were written', () => {
    const { library } = rig()
    library.append('agent.a', { at: '2026-08-26T10:00:00Z', author: 'agent.a', body: 'older' })
    library.append('agent.a', { at: '2026-08-27T10:00:00Z', author: 'agent.a', body: 'newer' })
    const dated = parseMemorySections(library.read('agent.a')).filter((s) => s.date !== null)
    expect(dated.map((s) => s.date)).toEqual(['2026-08-26', '2026-08-27'])
  })

  it('seeds on first append, so an agent that was never seeded still remembers', () => {
    const { library } = rig()
    library.note('agent.late', 'harness', 'hired mid-run')
    expect(library.read('agent.late')).toContain('hired mid-run')
  })

  it('refuses a malformed entry rather than writing half of one', () => {
    const { library } = rig()
    expect(() => library.append('agent.a', { at: '2026-08-27', author: 'a', body: '' })).toThrow(
      /malformed memory entry/
    )
    expect(library.read('agent.a')).toBe('')
  })

  it('writes atomically — no temp file survives the append', () => {
    const { library } = rig()
    library.note('agent.a', 'agent.a', 'something worth keeping')
    const entries = fs.readdirSync(path.dirname(library.memoryPath('agent.a')))
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(entries).toContain('memory.md')
  })

  it('imposes no schema on the prose (ADR-0006)', () => {
    const { library } = rig()
    const prose = 'I was wrong on 2026-08-26: it is not the DB.\n\n```sql\nSELECT 1;\n```'
    library.note('agent.a', 'agent.a', prose)
    expect(library.read('agent.a')).toContain(prose)
  })
})

describe('Library.layer (the memory a spawn carries)', () => {
  it('is empty for a hire that has written nothing', () => {
    const { library } = rig()
    library.seed('agent.new')
    expect(library.layer('agent.new').text).toBe('')
  })

  it('carries the agent’s own words to its next spawn', () => {
    const { library } = rig()
    library.note('agent.a', 'agent.a', 'The checkout suite is flaky under load.')
    const layer = library.layer('agent.a')
    expect(layer.text).toContain('The checkout suite is flaky under load.')
    expect(layer.facts.includedSections).toBe(1)
    expect(layer.facts.truncated).toBe(false)
  })

  it('tells the agent out loud when the budget elided older sections', () => {
    const { library } = rig()
    for (let i = 0; i < 400; i += 1) {
      library.note('agent.a', 'agent.a', `learning ${String(i)} — ${'x'.repeat(200)}`)
    }
    const layer = library.layer('agent.a')
    expect(layer.facts.truncated).toBe(true)
    expect(layer.facts.includedSections).toBeLessThan(layer.facts.totalSections)
    // Invariant §7: the degradation is visible to the party it affects.
    expect(layer.text).toMatch(/longer than one session can carry/)
    expect(layer.text).toContain(String(layer.facts.totalSections))
    expect(layer.text).toContain('learning 399')
  })

  it('says nothing about eliding when nothing was elided', () => {
    const { library } = rig()
    library.note('agent.a', 'agent.a', 'one short thing')
    expect(library.layer('agent.a').text).not.toMatch(/longer than one session can carry/)
  })

  it('reports an unreadable memory instead of pretending it is empty', () => {
    const degradations: string[] = []
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-library-'))
    temps.push(root)
    const library = new Library({
      agoraRoot: path.join(root, 'agora'),
      prompts: new PromptStore(path.join(root, 'prompts'), path.join(REPO, 'prompts')),
      onDegraded: (detail) => degradations.push(detail)
    })
    // A directory where the file should be: readFileSync throws EISDIR.
    fs.mkdirSync(library.memoryPath('agent.a'), { recursive: true })

    expect(library.read('agent.a')).toBe('')
    expect(degradations.join(' ')).toContain('memory.md for agent.a unreadable')
  })
})
