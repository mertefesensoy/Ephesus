import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Agora } from '../../src/main/agora'
import { PromptStore } from '../../src/main/prompts'
import type { LogEntry } from '../../src/shared/log'
import { removeTempDir } from '../tmpdir'

/**
 * The surfaces that read `log.jsonl` (M8.3).
 *
 * Every case here runs against a log LARGER than the old default window,
 * because that window is the defect: `readLog()` returns the OLDEST 500
 * entries, and every fixture in this repository was smaller than that, so
 * nothing could see it. On the Architect's machine 676 of 1,177 entries were
 * invisible to the standup, the org metrics were folded from 500 rows, and the
 * company-mode proof gate could not reach evidence older than the window.
 *
 * The other half is the publish/subscribe seam: `appendLog` is the single
 * writer, so a subscriber there hears about every append that will ever
 * happen — where the old arrangement asked each appender to also notify the
 * renderer, and Hermes (a quarter of everything recorded) never did.
 */

const BUNDLED_PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url))
/** Bigger than `readLog`'s default window, which is the whole point. */
const BEYOND_THE_WINDOW = 640

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function agora(options: Partial<ConstructorParameters<typeof Agora>[0]> = {}): Agora {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-logsurf-'))
  temps.push(home)
  return new Agora({
    root: path.join(home, 'agora'),
    prompts: new PromptStore(path.join(home, 'prompts'), BUNDLED_PROMPTS),
    backoffMs: 1,
    ...options
  })
}

/** Fills the log past the old window and returns the seq of the last entry. */
function fill(store: Agora, count = BEYOND_THE_WINDOW): number {
  let last = 0
  for (let i = 0; i < count; i += 1) last = store.appendLog({ kind: 'message', n: i }).seq
  return last
}

describe('reading the whole book', () => {
  it('readLogAll returns every entry, where readLog stops at its window', async () => {
    const store = agora()
    await store.ensureRepo()
    fill(store)

    const windowed = store.readLog()
    expect(windowed).toHaveLength(500)
    expect(windowed.at(-1)?.['n']).toBe(499)

    const everything = store.readLogAll()
    expect(everything).toHaveLength(BEYOND_THE_WINDOW)
    expect(everything.at(-1)?.['n']).toBe(BEYOND_THE_WINDOW - 1)
  })

  it('readLogSince returns everything after the cursor, not a head that is then filtered', async () => {
    // This is the standup's exact defect: it read the oldest 500 and THEN
    // filtered `seq > cursor`, so once the cursor passed 500 every brief was
    // compiled from an empty fact set.
    const store = agora()
    await store.ensureRepo()
    fill(store)

    const cursor = 500
    const theOldWay = store.readLog().filter((entry) => entry.seq > cursor)
    expect(theOldWay).toEqual([])

    const since = store.readLogSince(cursor)
    expect(since).toHaveLength(BEYOND_THE_WINDOW - cursor)
    expect(since[0]?.seq).toBe(cursor + 1)
  })

  it('reports what a whole-log read cost when it is slow', async () => {
    const seen: { entries: number; bytes: number; ms: number }[] = []
    const store = agora({ slowReadMs: 0, onSlowRead: (info) => seen.push(info) })
    await store.ensureRepo()
    fill(store, 10)

    store.readLogAll()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.entries).toBe(10)
    // The size is what M8.10 needs to size its fix against.
    expect(seen[0]?.bytes).toBeGreaterThan(0)
  })

  it('says nothing when the read is quick', async () => {
    const seen: unknown[] = []
    const store = agora({ slowReadMs: 60_000, onSlowRead: (info) => seen.push(info) })
    await store.ensureRepo()
    fill(store, 10)
    store.readLogAll()
    expect(seen).toEqual([])
  })
})

describe('the log publishes what it appends', () => {
  it('delivers every entry, in order, to every subscriber', async () => {
    const store = agora()
    await store.ensureRepo()
    const first: number[] = []
    const second: string[] = []
    store.onAppend((entry) => first.push(entry.seq))
    store.onAppend((entry) => second.push(entry.kind))

    store.appendLog({ kind: 'delivery', from: 'agent.mason' })
    store.appendLog({ kind: 'bounce', from: 'agent.tess' })

    expect(first).toEqual([1, 2])
    expect(second).toEqual(['delivery', 'bounce'])
  })

  it('delivers only AFTER the entry is on disk', async () => {
    // A subscriber that re-reads the log must find what it was just told about;
    // the Activity panel does exactly that.
    const store = agora()
    await store.ensureRepo()
    const foundOnDisk: boolean[] = []
    store.onAppend((entry) => {
      foundOnDisk.push(store.readLogAll().some((row) => row.seq === entry.seq))
    })
    store.appendLog({ kind: 'delivery', from: 'agent.mason' })
    expect(foundOnDisk).toEqual([true])
  })

  it('one subscriber failing never costs another its event, nor the append', async () => {
    const faults: { seq: number; kind: string; reason: string }[] = []
    const store = agora({ onSubscriberError: (fault) => faults.push(fault) })
    await store.ensureRepo()
    const survivor: number[] = []
    store.onAppend(() => {
      throw new Error('panel is gone')
    })
    store.onAppend((entry) => survivor.push(entry.seq))

    expect(() => store.appendLog({ kind: 'delivery' })).not.toThrow()
    expect(survivor).toEqual([1])
    expect(store.readLogAll()).toHaveLength(1)
    expect(faults).toEqual([{ seq: 1, kind: 'delivery', reason: 'panel is gone' }])
  })

  it('stops delivering once unsubscribed', async () => {
    const store = agora()
    await store.ensureRepo()
    const seen: number[] = []
    const off = store.onAppend((entry) => seen.push(entry.seq))
    store.appendLog({ kind: 'delivery' })
    off()
    store.appendLog({ kind: 'delivery' })
    expect(seen).toEqual([1])
  })

  it('unsubscribing DURING delivery cannot break the walk', async () => {
    const store = agora()
    await store.ensureRepo()
    const seen: string[] = []
    const off = store.onAppend(() => {
      seen.push('first')
      off()
    })
    store.onAppend(() => seen.push('second'))
    store.appendLog({ kind: 'delivery' })
    expect(seen).toEqual(['first', 'second'])
  })

  it('a subscriber added DURING delivery does not receive the entry it arrived after', async () => {
    // The other half of "delivery walks a snapshot", and the half a Set does
    // NOT give for free: deleting during iteration is safe in JavaScript, but
    // ADDING is not — a listener appended to the live set is visited in the
    // same pass. It would then be handed an entry that was already on its way
    // before it existed, which is a duplicate for anything that also reads the
    // log when it subscribes (the Activity panel does exactly that), and a
    // listener that subscribes on every delivery would never terminate.
    const store = agora()
    await store.ensureRepo()
    const late: number[] = []
    let arrived = false
    store.onAppend(() => {
      if (arrived) return
      arrived = true
      store.onAppend((entry) => late.push(entry.seq))
    })

    store.appendLog({ kind: 'delivery' })
    expect(late).toEqual([])
    store.appendLog({ kind: 'delivery' })
    expect(late).toEqual([2])
  })

  it('covers an appender that never notified anybody by hand', async () => {
    // The point of publishing at the single writer: a module that appends and
    // knows nothing about the renderer is covered anyway. Hermes appends in
    // thirteen places and had no push at all — 282 of 1,177 entries on the
    // Architect's machine, none of which reached the Activity panel.
    const store = agora()
    await store.ensureRepo()
    const heard: LogEntry[] = []
    store.onAppend((entry) => heard.push(entry))

    // Written the way Hermes writes it: straight to the Agora, no callback.
    store.appendLog({
      kind: 'delivery',
      msgId: 'm-1',
      from: 'agent.mason',
      to: 'agent.tess',
      act: 'inform'
    })
    expect(heard.map((entry) => entry['msgId'])).toEqual(['m-1'])
  })
})
