import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventLog } from '../../src/main/eventlog'
import { formatLogLine, type LogEntry } from '../../src/shared/log'
import { removeTempDir } from '../tmpdir'

/**
 * A duplicate `seq` in the book of record (F1, M8.12).
 *
 * ## The fact
 *
 * The Architect's own `agora/log.jsonl` carries `seq: 143` twice: a `spawn` at
 * line 142 and an `exit` at line 177, where 178 was expected. Pre-existing and
 * bounded — the 82 rows written on 2026-09-07 are contiguous with zero
 * out-of-order entries.
 *
 * ## The cause, established rather than guessed
 *
 * `EventLog.seq` is an in-memory counter recovered at `open()`. Two harness
 * processes pointed at one home each recover the same high-water mark and both
 * stamp `highest + 1`. `O_APPEND` makes their writes atomic at the byte level
 * and does nothing at all for their counters — which the class comment used to
 * over-claim. F2 is the mechanism that produced it: killing `npm run dev`
 * leaves Electron alive, so a second boot ran against the same home.
 *
 * ## The decision
 *
 * Readers tolerate it explicitly. `log.jsonl` is append-only (invariant §5), so
 * rewriting history is not on the table, and the alternative — accept it as a
 * scar — was refused because of who loses the row: `BriefingJob.gather` pages
 * from a cursor, so a hidden row is a hidden event in the standup, and SRS §6.1
 * asks for "the next briefing narrates the incident accurately from the log".
 *
 * **This suite fails under the other choice.** Under "accept as a scar" the
 * second row stays invisible to a cursor sitting on the duplicate, which is
 * exactly what the first test asserts must not happen.
 */

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

/**
 * A log written BY HAND, because this shape cannot be produced by one
 * `EventLog`: the class stamps a strictly increasing seq, and a rig that could
 * only build what the writer builds would never reach the case.
 */
function logWithDuplicate(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-dupseq-'))
  temps.push(dir)
  const file = path.join(dir, 'log.jsonl')
  const rows: LogEntry[] = [
    { ts: 1, seq: 141, kind: 'message', event: 'a' },
    { ts: 2, seq: 142, kind: 'message', event: 'b' },
    // The pair. Process A stamped 143 at 15:15…
    { ts: 3, seq: 143, kind: 'spawn', event: 'first-143' },
    { ts: 4, seq: 144, kind: 'message', event: 'c' },
    { ts: 5, seq: 145, kind: 'message', event: 'd' },
    // …and process B, holding its own counter, stamped 143 again at 17:31.
    { ts: 6, seq: 143, kind: 'exit', event: 'second-143' },
    { ts: 7, seq: 146, kind: 'message', event: 'e' }
  ]
  fs.writeFileSync(file, rows.map((row) => formatLogLine(row)).join(''), 'utf8')
  return file
}

const events = (rows: readonly { readonly [k: string]: unknown }[]): unknown[] =>
  rows.map((row) => row['event'])

describe('a cursor sitting on a duplicate seq', () => {
  it('still delivers the LATER row — no appended event is silently dropped', () => {
    const log = new EventLog(logWithDuplicate())
    log.open()
    // A consumer that had read up to the first 143 asks for what came after.
    expect(events(log.read(143))).toEqual(['c', 'd', 'second-143', 'e'])
  })

  it('returns them in FILE order, which is the order history happened in', () => {
    const log = new EventLog(logWithDuplicate())
    log.open()
    const seqs = log.read(142).map((entry) => entry.seq)
    expect(seqs).toEqual([143, 144, 145, 143, 146])
  })

  it('does not resurrect the rows BEFORE the cursor', () => {
    // The tolerance is forward-only: passing the cursor's position does not
    // mean re-delivering everything behind it.
    const log = new EventLog(logWithDuplicate())
    log.open()
    expect(events(log.read(144))).toEqual(['d', 'second-143', 'e'])
  })

  it('delivers it at MOST once, so a consumer cannot loop on it', () => {
    // The property that decided the shape of the rule. A tolerance keyed on
    // "this row is out of order, return it" would return it to every cursor
    // forever — and `BriefingJob` would narrate the same exit at every standup.
    // Once a consumer has paged past it, it is gone.
    const log = new EventLog(logWithDuplicate())
    log.open()
    expect(events(log.read(146))).toEqual([])
  })

  /**
   * The residual, pinned rather than hidden.
   *
   * The rule finds the cursor's position by the first entry ahead of it, so a
   * cursor sitting on the row IMMEDIATELY BEFORE the duplicate — 145 here — has
   * no such entry until after the duplicate, and skips it. That is one cursor
   * value out of the whole log; before this change 143, 144 and 145 all lost it.
   *
   * Closing it too means "begin returning when the file's seq goes backwards",
   * which re-delivers the row to every later cursor as well unless it is
   * qualified by the highest seq seen so far — three interacting conditions to
   * recover one row on one cursor value, in the reader every consumer shares.
   * The trade is recorded here and in the implementation doc, and it is bounded
   * in practice: a consumer paging continuously receives 143→146 in one batch
   * and never holds 145 as a cursor at all.
   */
  it('still misses it for a cursor on the row immediately before it', () => {
    const log = new EventLog(logWithDuplicate())
    log.open()
    expect(events(log.read(145))).toEqual(['e'])
  })

  it('honours the limit unchanged', () => {
    const log = new EventLog(logWithDuplicate())
    log.open()
    expect(events(log.read(142, 2))).toEqual(['first-143', 'c'])
  })
})

describe('the ordinary log is not changed by the tolerance', () => {
  function ordinary(): EventLog {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-dupseq-ok-'))
    temps.push(dir)
    const log = new EventLog(path.join(dir, 'log.jsonl'))
    for (const event of ['a', 'b', 'c', 'd']) log.append({ kind: 'message', event })
    return log
  }

  it('pages forward exactly as it did', () => {
    expect(events(ordinary().read(2))).toEqual(['c', 'd'])
    expect(events(ordinary().read(0))).toEqual(['a', 'b', 'c', 'd'])
    expect(events(ordinary().read(4))).toEqual([])
  })

  it('still skips a leading entry at or behind the cursor', () => {
    // seq 0 is a valid parse (`z.number().int().nonnegative()`), and a row
    // carrying it must not start being returned by `read(0)` as a side effect
    // of the F1 change.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-dupseq-zero-'))
    temps.push(dir)
    const file = path.join(dir, 'log.jsonl')
    fs.writeFileSync(
      file,
      [
        formatLogLine({ ts: 1, seq: 0, kind: 'message', event: 'zero' }),
        formatLogLine({ ts: 2, seq: 1, kind: 'message', event: 'one' })
      ].join(''),
      'utf8'
    )
    const log = new EventLog(file)
    log.open()
    expect(events(log.read(0))).toEqual(['one'])
  })

  it('reads around a torn line without treating it as the cursor', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-dupseq-torn-'))
    temps.push(dir)
    const file = path.join(dir, 'log.jsonl')
    fs.writeFileSync(
      file,
      [
        formatLogLine({ ts: 1, seq: 1, kind: 'message', event: 'a' }),
        '{"ts":2,"seq":2,"kind":"mess\n',
        formatLogLine({ ts: 3, seq: 3, kind: 'message', event: 'c' })
      ].join(''),
      'utf8'
    )
    const log = new EventLog(file)
    log.open()
    expect(events(log.read(1))).toEqual(['c'])
  })
})
