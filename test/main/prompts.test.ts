import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PromptStore } from '../../src/main/prompts'
import { removeTempDir } from '../tmpdir'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function rig(): { home: string; bundled: string; store: PromptStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-prompts-'))
  temps.push(root)
  const home = path.join(root, 'home', 'prompts')
  const bundled = path.join(root, 'bundled')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(bundled, 'engines'), { recursive: true })
  fs.writeFileSync(
    path.join(bundled, 'engines', 'greeting.md'),
    'Hello {{name}}, you are {{role}}.\n',
    'utf8'
  )
  return { home, bundled, store: new PromptStore(home, bundled) }
}

describe('PromptStore (invariant §8: prompt text is config)', () => {
  it('seeds the home copy from the bundled default on first read', () => {
    const { home, store } = rig()
    const seeded = path.join(home, 'engines', 'greeting.md')

    expect(fs.existsSync(seeded)).toBe(false)
    expect(store.read(path.join('engines', 'greeting.md'))).toContain('Hello {{name}}')
    expect(fs.existsSync(seeded)).toBe(true)
  })

  it('reads the Architect-edited home copy, not the bundled one', () => {
    const { home, store } = rig()
    const rel = path.join('engines', 'greeting.md')
    fs.mkdirSync(path.join(home, 'engines'), { recursive: true })
    fs.writeFileSync(path.join(home, 'engines', 'greeting.md'), 'Tuned {{name}}.\n', 'utf8')

    expect(store.read(rel)).toBe('Tuned {{name}}.\n')
  })

  it('fills every placeholder', () => {
    const { store } = rig()
    expect(store.render(path.join('engines', 'greeting.md'), { name: 'Mason', role: 'ci' })).toBe(
      'Hello Mason, you are ci.\n'
    )
  })

  it('throws rather than shipping an unfilled placeholder to a model', () => {
    const { store } = rig()
    expect(() => store.render(path.join('engines', 'greeting.md'), { name: 'Mason' })).toThrow(
      /needs a value for \{\{role\}\}/
    )
  })

  it('names both paths when a prompt is missing entirely', () => {
    const { store } = rig()
    expect(() => store.read('nope.md')).toThrow(/missing from both/)
  })

  it('exposes the editable path for a prompt', () => {
    const { home, store } = rig()
    expect(store.pathOf('a/b.md')).toBe(path.join(home, 'a/b.md'))
  })
})
