import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ARCHIVE_DIR,
  EventLog,
  ROTATE_AT_BYTES,
  segmentFirstSeq,
  segmentName
} from '../../src/main/eventlog'
import { parseLogLine, type LogEntry } from '../../src/shared/log'
import { removeTempDir } from '../tmpdir'

/**
 * D3 (M8.10) — log rotation, on a real filesystem.
 *
 * ## Why this suite generates a large log instead of using a fixture
 *
 * Every defect this milestone fixes is invisible at fixture scale: a unit test
 * over a ten-line log passes against all of them. The register therefore owes a
 * SYNTHETIC MULTI-DAY LOG, and these tests generate one rather than assert
 * against a hand-written stub.
 *
 * **The shape and size of the generated log, so every number below carries its
 * condition:** entries are the real `LogEntry` shape written through the real
 * `EventLog.append`, each carrying a `because` string padded to 512 bytes so
 * the size on disk is predictable. The suite rotates at 64 KiB rather than the
 * shipped 4 MiB (see `ROTATE_AT` below) and writes a little over three times
 * that — about **1 500 entries across three sealed segments plus a live
 * file**, which is the shape of a multi-day run in miniature. At the shipped
 * threshold the identical suite took 99 seconds; the mechanism under test is a
 * function of the boundary, not of where the boundary sits.
 *
 * ## The property that matters most
 *
 * Rotation must not shrink what anything can read. `readLogAll` folds the
 * incident board, the standup, the org metrics, the Gymnasium history and the
 * degradation replay, and `incident-view.ts` DROPS an incident whose `raised`
 * row it cannot see — so a rotation that quietly moved history out of view
 * would silently empty the company's own surfaces. That is asserted here
 * against the concatenation of the files on disk, not against a count.
 */

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) removeTempDir(dir)
})

function logFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eph-rotate-'))
  temps.push(dir)
  return path.join(dir, 'log.jsonl')
}

/** Roughly how many bytes one padded entry costs on disk. */
const PAD = 512

/**
 * The threshold these tests rotate at.
 *
 * NOT the shipped 4 MiB: writing four megabytes per rotation made this file
 * take 99 seconds, and a suite nobody runs defends nothing. The production
 * value is pinned by its own case below, so a small number here cannot quietly
 * become the shipped one. Everything else about the mechanism — the rename,
 * the naming, the skipping, the seq recovery — is a function of the boundary,
 * not of where the boundary sits.
 */
const ROTATE_AT = 64 * 1024

/**
 * Writes `count` entries through the real append path.
 *
 * `day` only varies the payload — rotation is driven by bytes, and stamping a
 * date here would suggest otherwise.
 */
function writeEntries(log: EventLog, count: number): void {
  for (let i = 0; i < count; i += 1) {
    log.append({
      kind: 'hook',
      event: 'wake',
      agentId: `agent.${String(i % 7)}`,
      because: `entry ${String(i)} ${'.'.repeat(PAD)}`
    })
  }
}

/** Enough entries to seal `segments` files and leave a live one behind. */
function entriesFor(segments: number): number {
  return Math.ceil(((segments + 0.4) * ROTATE_AT) / PAD)
}

/** The seqs held by the LIVE file alone. */
function liveSeqs(file: string): ReadonlySet<number> {
  if (!fs.existsSync(file)) return new Set()
  const seqs = new Set<number>()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const entry = parseLogLine(line)
    if (entry) seqs.add(entry.seq)
  }
  return seqs
}

/** Every line on disk, in file order: the archive oldest first, then live. */
function everyLineOnDisk(file: string): readonly string[] {
  const dir = path.dirname(file)
  const archive = path.join(dir, ARCHIVE_DIR)
  const names = fs.existsSync(archive) ? fs.readdirSync(archive).sort() : []
  const parts = names.map((name) => fs.readFileSync(path.join(archive, name), 'utf8'))
  if (fs.existsSync(file)) parts.push(fs.readFileSync(file, 'utf8'))
  return parts
    .join('')
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

describe('D3 — the shipped threshold', () => {
  it('is 4 MiB, whatever these tests rotate at', () => {
    // The suite below rotates at 64 KiB for speed. This is the assertion that
    // stops that convenience from quietly becoming the value the harness runs
    // with, and it is why `rotateAtBytes` is an option rather than an edit.
    expect(ROTATE_AT_BYTES).toBe(4 * 1024 * 1024)
    expect(ROTATE_AT).toBeLessThan(ROTATE_AT_BYTES)
  })

  it('is what an EventLog uses when nothing says otherwise', () => {
    const file = logFile()
    const log = new EventLog(file)
    // Well past the test threshold and nowhere near the shipped one: a log
    // built with no options must NOT have rotated.
    writeEntries(log, Math.ceil((4 * ROTATE_AT) / PAD))
    expect(log.segments()).toEqual([])
    expect(fs.statSync(file).size).toBeGreaterThan(ROTATE_AT)
  })
})

describe('D3 — segment names carry the range, so a skip needs no I/O', () => {
  it('round-trips a first seq through the name', () => {
    expect(segmentName(1)).toBe('log-000000000001.jsonl')
    expect(segmentName(90_210)).toBe('log-000000090210.jsonl')
    expect(segmentFirstSeq(segmentName(90_210))).toBe(90_210)
  })

  it('refuses a name that is not a segment', () => {
    expect(segmentFirstSeq('log.jsonl')).toBeNull()
    expect(segmentFirstSeq('log-.jsonl')).toBeNull()
    expect(segmentFirstSeq('log-000000000000.jsonl')).toBeNull()
    expect(segmentFirstSeq('notes.md')).toBeNull()
    // Sorting the names sorts the segments, which is what the read path relies
    // on before it has opened a single file.
    expect([segmentName(2), segmentName(11), segmentName(1)].sort()).toEqual([
      segmentName(1),
      segmentName(2),
      segmentName(11)
    ])
  })
})

describe('D3 — a multi-day log rotates, and loses nothing (invariant §5)', () => {
  it('seals segments and keeps the live file under the threshold', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(log, entriesFor(3))

    const segments = log.segments()
    expect(segments.length).toBeGreaterThanOrEqual(3)
    // The live file is what every append and every tail now pays for.
    expect(fs.statSync(file).size).toBeLessThan(ROTATE_AT)
    // And the history really is multi-megabyte, or this proves nothing.
    expect(log.sizeBytes()).toBeGreaterThan(3 * ROTATE_AT)
  })

  it('is a rename and nothing else — the bytes are the same bytes', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    const count = entriesFor(2)
    writeEntries(log, count)

    // Every line that was ever written is still on disk exactly once, in the
    // order it was written. This is invariant §5 across a rotation boundary:
    // not "the same entries", the same LINES.
    const lines = everyLineOnDisk(file)
    expect(lines).toHaveLength(count)
    const seqs = lines.map((line) => parseLogLine(line)?.seq)
    expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i + 1))
  })

  it('readLogAll returns exactly what it returned before rotation existed', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    const count = entriesFor(2)
    writeEntries(log, count)
    expect(log.segments().length).toBeGreaterThanOrEqual(2)

    const all = log.all()
    // Nothing is missing, nothing is duplicated, and the order is the order.
    expect(all).toHaveLength(count)
    expect(all[0]?.seq).toBe(1)
    expect(all.at(-1)?.seq).toBe(count)
    expect(all.map((entry) => entry.seq)).toEqual(Array.from({ length: count }, (_, i) => i + 1))

    // The parse of the concatenated files agrees with the reader, so the reader
    // is not quietly filtering something the archive still holds.
    const onDisk = everyLineOnDisk(file)
      .map((line) => parseLogLine(line))
      .filter((entry): entry is LogEntry => entry !== null)
    expect(onDisk.map((entry) => entry.seq)).toEqual(all.map((entry) => entry.seq))
  })
})

describe('D3 — the readers rotation exists for', () => {
  it('tailOf reads the newest entries without touching the whole history', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    const count = entriesFor(3)
    writeEntries(log, count)

    const tail = log.tailOf(50)
    expect(tail).toHaveLength(50)
    expect(tail.at(-1)?.seq).toBe(count)
    expect(tail[0]?.seq).toBe(count - 49)
  })

  it('tailOf reaches into the archive when the live file is too short', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(log, entriesFor(1))
    const liveEntries = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0).length

    // Ask for more than the live file holds: the answer must span the boundary
    // rather than stop at it.
    const wanted = liveEntries + 20
    const tail = log.tailOf(wanted)
    expect(tail).toHaveLength(wanted)
    expect(tail.at(-1)?.seq).toBe(log.all().length)
  })

  it('a cursor read skips the segments it is already past', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(log, entriesFor(3))
    const total = log.all().length

    // A cursor near the end returns only what follows it — and the answer is
    // identical to filtering the whole history, which is the property that
    // makes the skip safe rather than merely fast.
    const cursor = total - 10
    const since = log.read(cursor, Number.MAX_SAFE_INTEGER)
    expect(since.map((entry) => entry.seq)).toEqual(
      log
        .all()
        .filter((entry) => entry.seq > cursor)
        .map((entry) => entry.seq)
    )
    expect(since).toHaveLength(10)
  })

  it('a cursor of zero still yields the whole history across segments', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    const count = entriesFor(2)
    writeEntries(log, count)
    expect(log.read(0, Number.MAX_SAFE_INTEGER)).toHaveLength(count)
  })

  it('honours its limit while spanning segments', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(log, entriesFor(2))
    const page = log.read(0, 5)
    expect(page.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('D3 — the boot reconcile handles a rotated file', () => {
  it('recovers the sequence from the archive when the live file is gone', () => {
    const file = logFile()
    const first = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(first, entriesFor(1))

    // The exact restart this guards: the harness is stopped with an archive on
    // disk and no `log.jsonl` beside it. The live file is REMOVED rather than
    // emptied, so the only place a sequence can come from is the archive — and
    // the entries it held are genuinely gone, which is why the expectation
    // below is the archive's own highest and not the total ever written.
    const archived = first.all().filter((entry) => !liveSeqs(file).has(entry.seq))
    const archivedHighest = Math.max(...archived.map((entry) => entry.seq))
    fs.rmSync(file)
    expect(fs.existsSync(file)).toBe(false)

    const reopened = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    reopened.open()
    // Without an archive-aware recovery this is 1, and every new entry
    // collides with an archived one.
    expect(archivedHighest).toBeGreaterThan(1)
    expect(reopened.nextSeq()).toBe(archivedHighest + 1)

    // Numbering continues rather than colliding — the seq the next entry takes
    // is one nobody has used.
    const appended = reopened.append({ kind: 'hook', event: 'wake', agentId: 'agent.a' })
    expect(appended.seq).toBe(archivedHighest + 1)
    expect(reopened.all().map((entry) => entry.seq)).toContain(archivedHighest + 1)
  })

  it('recovers the sequence across a rotation on a normal restart', () => {
    const file = logFile()
    const first = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(first, entriesFor(2))
    const highest = first.all().length

    const reopened = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    reopened.open()
    expect(reopened.nextSeq()).toBe(highest + 1)
  })

  it('an empty log still starts at one', () => {
    const log = new EventLog(logFile(), { rotateAtBytes: ROTATE_AT })
    log.open()
    expect(log.nextSeq()).toBe(1)
    expect(log.all()).toEqual([])
    expect(log.segments()).toEqual([])
    expect(log.sizeBytes()).toBe(0)
  })
})

describe('D3 — rotation never costs an event', () => {
  it('appends into the existing file when the archive cannot be written', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(log, entriesFor(1))
    const before = log.all().length

    // A file where the archive directory should be: `mkdir` fails, so rotation
    // cannot happen. The append must still land — a lost event is worse than a
    // large file.
    const archive = path.join(path.dirname(file), ARCHIVE_DIR)
    fs.rmSync(archive, { recursive: true, force: true })
    fs.writeFileSync(archive, 'not a directory', 'utf8')

    // Grow past the threshold again so rotation is attempted and refused.
    writeEntries(log, Math.ceil(ROTATE_AT / PAD) + 10)
    expect(log.all().length).toBeGreaterThan(before)
    expect(fs.statSync(file).size).toBeGreaterThan(ROTATE_AT)
  })

  it('leaves a torn line alone across a rotation', () => {
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(log, 3)
    // A killed harness: half a line, no newline.
    fs.appendFileSync(file, '{"kind":"hook","seq":', 'utf8')

    const appended = log.append({ kind: 'hook', event: 'wake', agentId: 'agent.a' })
    expect(appended.seq).toBe(4)
    // The torn bytes are still there, untouched, and the reader reads around
    // them exactly as it did before rotation existed.
    expect(fs.readFileSync(file, 'utf8')).toContain('{"kind":"hook","seq":')
    expect(log.all().map((entry) => entry.seq)).toEqual([1, 2, 3, 4])
  })
})

/**
 * Both cases here were written because a mutation SURVIVED the suite above,
 * and each one was read before a line of test was added (M8.0's rule).
 */
describe('D3 — the two cases the first suite missed', () => {
  /** The first seq of every sealed segment, oldest first. */
  function boundaries(log: EventLog): readonly number[] {
    return log
      .segments()
      .map((file) => segmentFirstSeq(path.basename(file)))
      .filter((seq): seq is number => seq !== null)
  }

  it('reads a cursor that lands exactly on a segment boundary', () => {
    // The survivor: widening the skip to `afterSeq + 2` drops a segment whose
    // LAST entry is the very next one the caller asked for. It survived because
    // every cursor in the suite above sat in the middle of a segment, and the
    // standup's cursor is wherever the last brief ended — an arbitrary seq that
    // lands on a boundary as readily as anywhere else.
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(log, entriesFor(3))
    const every = log.all()
    const starts = boundaries(log)
    expect(starts.length).toBeGreaterThanOrEqual(3)

    // Around EVERY boundary, not one chosen cursor: the answer must equal
    // filtering the whole history, which is the property that makes the skip
    // safe rather than merely fast.
    for (const start of starts) {
      for (const cursor of [start - 2, start - 1, start, start + 1]) {
        if (cursor < 0) continue
        expect(log.read(cursor, Number.MAX_SAFE_INTEGER).map((entry) => entry.seq)).toEqual(
          every.filter((entry) => entry.seq > cursor).map((entry) => entry.seq)
        )
      }
    }
  })

  it('refuses to seal onto a segment that already exists', () => {
    // The survivor: `renameSync` replaces its destination silently, so without
    // this guard a rotation onto an existing name would destroy a sealed
    // segment — history rewritten, which invariant §5 forbids outright.
    //
    // The harness cannot reach this state on its own: `seq` only rises, so a
    // second rotation never computes a name it has already used. It can arrive
    // from OUTSIDE — a restore from backup, a file-sync client putting a
    // deleted segment back, or the second process pointed at the same home that
    // this module's own contract takes seriously. The state is therefore built
    // directly rather than provoked, because how it arises is not what the
    // guard is responsible for.
    const file = logFile()
    const log = new EventLog(file, { rotateAtBytes: ROTATE_AT })
    writeEntries(log, 4)

    // A segment named for the seq the live file starts at, holding something
    // that is nobody's business to lose.
    const archive = path.join(path.dirname(file), ARCHIVE_DIR)
    fs.mkdirSync(archive, { recursive: true })
    const clash = path.join(archive, segmentName(1))
    const precious = '{"kind":"memo","seq":1,"ts":1,"event":"do not lose me"}\n'
    fs.writeFileSync(clash, precious, 'utf8')

    // Now push the live file past the threshold, so rotation is attempted and
    // computes exactly that name.
    writeEntries(log, Math.ceil(ROTATE_AT / PAD) + 4)

    // The sealed segment is untouched, byte for byte.
    expect(fs.readFileSync(clash, 'utf8')).toBe(precious)
    // And the live file still holds its own entries — refused, not lost.
    expect(fs.existsSync(file)).toBe(true)
    expect(liveSeqs(file).has(1)).toBe(true)
  })
})
