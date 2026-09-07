import fs from 'node:fs'
import path from 'node:path'
import { formatLogLine, parseLogLine, type LogEntry, type LogEntryDraft } from '../shared/log'

/**
 * The append-only event log (`agora/log.jsonl`, SDD §4.3; invariant §5).
 *
 * Append-only is not a style preference here — the Odeon's "book of record"
 * claim (NFR-13) and every forensic path depend on nothing ever rewriting this
 * file. So:
 *
 *  - writes are `appendFile` with `O_APPEND`, never a read-modify-write;
 *  - a torn final line from a killed harness is **ignored on read and left
 *    alone on disk**. Truncating it would be a rewrite, and the next append
 *    lands on its own line anyway;
 *  - `seq` is recovered from the file at open, so numbering survives a restart.
 *
 * Only main writes it (ADR-0004), so appends are already serialised by the
 * single-threaded event loop; `O_APPEND` covers the case of a second harness
 * process pointed at the same home — **for the bytes, and only for the bytes**.
 * It does not serialise `seq`, which is an in-memory counter each process
 * recovers for itself at `open()`. Two harness instances on one home therefore
 * both stamp `highest + 1` and the numbering collides; the Architect's own log
 * carries one such pair from 2026-08-29 (`seq: 143` at lines 142 and 177).
 * `read` tolerates it explicitly (see below) and the README says to stop
 * Electron by process rather than by the `npm run dev` wrapper, which is how
 * two instances came to share a home in the first place (F2, M8.12).
 *
 * ## Rotation (D3, M8.10)
 *
 * The log is a file that only grows, and every read parsed it from byte zero.
 * Measured on a synthetic overnight run: **28.4 MB and 306 ms per parse, on the
 * main loop** — the loop that carries PTY bytes and hook events (SDD §11,
 * NFR-1/NFR-2). `tailOf` is the worst shape of it: the Activity feed asks for
 * the newest handful of entries on every poll and pays for the whole history to
 * get them.
 *
 * So the log is now a SEQUENCE of files: sealed archive segments under
 * `log-archive/`, plus the live `log.jsonl` at the end.
 *
 * **Append-only still means append-only, across the boundary.** Rotation is a
 * `rename` and nothing else: no rewrite, no compaction, no truncation, not one
 * byte of an entry altered or dropped. The concatenation of the segments and
 * the live file IS the file that used to be there, byte for byte, in the same
 * order. What changes is only which file a given byte lives in.
 *
 * **No reader loses history.** `read`/`all` span segments and live, so
 * `readLogAll()` returns exactly what it returned before rotation existed. That
 * is a requirement, not an optimisation: the incident board, the standup, the
 * org metrics, the Gymnasium history and the degradation replay are all folds
 * over this log, and `incident-view.ts` in particular DROPS an incident whose
 * `raised` row it cannot see. A rotation that quietly shrank those surfaces
 * would make the company's own history unreadable, which is worse than no
 * rotation at all.
 *
 * The win is therefore not "read less history" — it is:
 *
 *  1. **A bounded live file.** Appends stay cheap, and git stops storing a
 *     whole new multi-megabyte blob on every commit: a sealed segment is one
 *     blob, once, forever.
 *  2. **Segment skipping, with no I/O to decide it.** Each segment is named for
 *     the first `seq` it holds, so the range it covers is known from the
 *     filenames alone. `read(afterSeq)` skips every segment that ends at or
 *     before the cursor without opening it, and `tailOf` walks backwards from
 *     the live file and stops as soon as it has enough. The per-poll reader
 *     stops paying for the whole history.
 */

/**
 * How large the live file may get before the next append seals it.
 *
 * Derived from the measurement rather than chosen: 28.4 MB parsed in 306 ms,
 * so ~11 ms per MB on the Architect's machine. At 4 MB a whole-live-file parse
 * costs roughly 45 ms, which is the same order as the `slowReadMs` threshold
 * the Agora already treats as the edge of acceptable on the main loop.
 */
export const ROTATE_AT_BYTES = 4 * 1024 * 1024

/** Directory holding sealed segments, beside the live file. */
export const ARCHIVE_DIR = 'log-archive'

/**
 * Width of the zero-padded `seq` in a segment name. Twelve digits sorts
 * correctly to a trillion entries; `segmentsOf` also sorts numerically, so the
 * padding is for humans reading a directory listing, not for correctness.
 */
const SEQ_PAD = 12

/** A sealed segment: its path, and the first `seq` it contains. */
interface Segment {
  readonly file: string
  readonly firstSeq: number
}

/** Contract: the segment file name that starts at `firstSeq`. */
export function segmentName(firstSeq: number): string {
  return `log-${String(firstSeq).padStart(SEQ_PAD, '0')}.jsonl`
}

/** Contract: the `firstSeq` a segment name encodes, or null if it is not one. */
export function segmentFirstSeq(name: string): number | null {
  const match = /^log-(\d+)\.jsonl$/.exec(name)
  if (!match?.[1]) return null
  const seq = Number(match[1])
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null
}

/** Construction options. Only the threshold, and only so tests can move it. */
export interface EventLogOptions {
  /**
   * Bytes the live file may reach before the next append seals it. Defaults
   * to `ROTATE_AT_BYTES`.
   *
   * Injectable for the same reason the Agora injects `slowReadMs`: a suite
   * that had to write four megabytes to see one rotation would take a minute
   * and a half, which is a suite nobody runs. The production default is
   * pinned by its own test so lowering it here cannot quietly become the
   * shipped value.
   */
  readonly rotateAtBytes?: number
}

export class EventLog {
  private seq = 0
  private opened = false
  private readonly rotateAtBytes: number

  constructor(
    private readonly filePath: string,
    options: EventLogOptions = {}
  ) {
    this.rotateAtBytes = options.rotateAtBytes ?? ROTATE_AT_BYTES
  }

  /**
   * Recovers the next sequence number from what is already on disk. Contract:
   * never throws on a damaged file — the highest readable `seq` wins, and an
   * unreadable tail is simply not counted.
   *
   * Reads the ARCHIVE too when the live file has nothing to say. A restart that
   * landed just after a rotation would otherwise recover `seq = 0` from an
   * empty live file and start renumbering from 1 — every new entry colliding
   * with an archived one, and every cursor-based reader (`readLogSince`, the
   * standup's brief cursor) silently rewound to the beginning of time.
   */
  open(): void {
    if (this.opened) return
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    this.seq = this.highestSeq()
    this.opened = true
  }

  /** The seq the next appended entry will carry. */
  nextSeq(): number {
    return this.seq + 1
  }

  /**
   * Appends one event. Contract: returns the entry as written, with `ts` and
   * `seq` stamped by the log rather than the caller — a caller-supplied seq
   * could collide, and a caller-supplied timestamp could reorder history.
   *
   * Rotation happens HERE, before the write, so a segment is only ever sealed
   * at an entry boundary: the file is renamed exactly as it stands and the new
   * entry begins a fresh one. Sealing mid-write is not possible because this is
   * the only writer and it is synchronous (ADR-0004).
   */
  append(draft: LogEntryDraft): LogEntry {
    this.open()
    this.rotateIfFull()
    const entry: LogEntry = { ...draft, ts: Date.now(), seq: this.seq + 1 }
    // If the previous run died mid-line, start on a clean one. The torn line is
    // left exactly as it is: unreadable to the parser, untouched on disk.
    const prefix = this.endsMidLine() ? '\n' : ''
    fs.appendFileSync(this.filePath, prefix + formatLogLine(entry), { encoding: 'utf8' })
    this.seq = entry.seq
    return entry
  }

  /**
   * Seals the live file into the archive once it has grown past
   * `ROTATE_AT_BYTES`.
   *
   * Contract: a pure `rename`. Nothing is read back, rewritten, compacted or
   * dropped, so invariant §5 holds across the boundary — the bytes that were in
   * `log.jsonl` are the bytes that are now in the segment, in the same order.
   *
   * A failure here must NOT cost the caller its event. The book of record
   * carrying on in one large file is a performance problem; an append that
   * threw because housekeeping failed would be a lost event, which is a
   * correctness one. So a rotation that cannot happen is skipped and the append
   * proceeds into the file that is already there.
   */
  private rotateIfFull(): void {
    let size: number
    try {
      size = fs.statSync(this.filePath).size
    } catch {
      return
    }
    if (size < this.rotateAtBytes) return
    const firstSeq = this.firstSeqOf(this.filePath)
    // A live file with no readable entry at all has no range to name a segment
    // by, and sealing it would put bytes somewhere no reader looks for them.
    if (firstSeq === null) return
    try {
      const dir = this.archiveDir()
      fs.mkdirSync(dir, { recursive: true })
      const target = path.join(dir, segmentName(firstSeq))
      // Never seal onto an existing segment: that would be a rewrite of history
      // rather than an addition to it.
      if (fs.existsSync(target)) return
      fs.renameSync(this.filePath, target)
    } catch {
      // Skipped, not fatal — see the contract above.
    }
  }

  /**
   * Reads entries after `afterSeq`, up to `limit` (SDD §5 `agora.log`).
   * Contract: skips anything unreadable. A log with a torn tail still yields
   * every intact event before it.
   *
   * Spans the archive and the live file, oldest first, so what this returns
   * does not depend on how many times the log has rotated.
   */
  read(afterSeq = 0, limit = 500): readonly LogEntry[] {
    const out: LogEntry[] = []
    /**
     * Whether the walk has passed the cursor's POSITION (F1, M8.12).
     *
     * This was `entry.seq > afterSeq`, applied to every line, which is correct
     * only while `seq` strictly increases in file order. The Architect's own
     * `log.jsonl` shows it does not: `seq: 143` appears twice, at line 142 and
     * again at line 177. The cause is in this class rather than in the data —
     * `this.seq` is an in-memory counter recovered at `open()`, so two harness
     * processes pointed at one home each recover the same high-water mark and
     * both stamp `highest + 1`. `O_APPEND` makes their WRITES atomic; it does
     * nothing for their counters.
     *
     * Under the old rule a reader paging from 143 skipped BOTH rows, so the
     * later one — an `exit` — was invisible to every cursor-based consumer,
     * including `BriefingJob.gather(sinceSeq)`. That is SRS §6.1's own "the
     * next briefing narrates the incident accurately from the log", so this is
     * not a cosmetic wart in the record.
     *
     * The cursor is therefore a position: skip the leading run of entries at or
     * behind it, and once the walk has begun returning, return everything after
     * it in FILE order — which is the order history actually happened in. On a
     * strictly increasing log (every log this harness will write from now on,
     * absent a second process) the two rules agree line for line.
     *
     * Two residuals, stated so nobody assumes otherwise. A cursor sitting on
     * the row IMMEDIATELY BEFORE the duplicate still misses it, because the
     * position is found by the first entry ahead of the cursor and there is
     * none until after the duplicate — one cursor value, down from three.
     * Closing that too costs three interacting conditions in the reader every
     * consumer shares, to recover one row; a consumer paging continuously gets
     * the row in an earlier batch and never holds that cursor. And
     * `sourcesFrom` skips whole segments by filename, so a duplicate inside a
     * segment the cursor has already passed is still lost — opening segments to
     * find out is exactly the cost rotation exists to avoid. Both trades are
     * taken deliberately and pinned in `test/main/log-duplicate-seq.test.ts`.
     */
    let past = false
    for (const file of this.sourcesFrom(afterSeq)) {
      for (const line of linesOf(file)) {
        const entry = parseLogLine(line)
        if (!entry) continue
        if (!past) {
          if (entry.seq <= afterSeq) continue
          past = true
        }
        out.push(entry)
        if (out.length >= limit) return out
      }
    }
    return out
  }

  /**
   * The LAST `limit` readable entries.
   *
   * `read` pages FORWARD from a cursor, which is right for a consumer that is
   * catching up and wrong for one that wants to know what is true now. The boot
   * replay wants the newest degradations, and asking `read` for them would hand
   * back the oldest — register item B3, which M8.3 closes at the callers that
   * made that mistake.
   *
   * Walks the sources BACKWARDS and stops as soon as it has enough. This is the
   * reader rotation exists for: the Activity feed asks for the newest handful
   * on every poll, and before D3 that parsed the entire history each time. It
   * now reads the live file, and reaches back into the archive only when the
   * live file holds fewer than `limit` entries.
   */
  tailOf(limit: number): readonly LogEntry[] {
    if (limit <= 0) return []
    const collected: LogEntry[][] = []
    let have = 0
    for (const file of [...this.sources()].reverse()) {
      const entries: LogEntry[] = []
      for (const line of linesOf(file)) {
        const entry = parseLogLine(line)
        if (entry) entries.push(entry)
      }
      collected.unshift(entries)
      have += entries.length
      if (have >= limit) break
    }
    const all = collected.flat()
    return all.length <= limit ? all : all.slice(all.length - limit)
  }

  /**
   * Bytes on disk, for reporting what a whole-log read cost (M8.3).
   *
   * The WHOLE book of record, archive included — that is what a `readLogAll`
   * actually parsed, and a figure that counted only the live file would report
   * a rotated 28 MB history as a few kilobytes and make the slow-read
   * degradation lie about its own cause.
   */
  sizeBytes(): number {
    let total = 0
    for (const file of this.sources()) {
      try {
        total += fs.statSync(file).size
      } catch {
        // A source that vanished between listing and stat contributes nothing.
      }
    }
    return total
  }

  /** Every readable entry. For tests and small logs only. */
  all(): readonly LogEntry[] {
    return this.read(0, Number.MAX_SAFE_INTEGER)
  }

  /** Sealed segments, oldest first — for the tests and the forensic reader. */
  segments(): readonly string[] {
    return this.segmentsOf().map((segment) => segment.file)
  }

  private archiveDir(): string {
    return path.join(path.dirname(this.filePath), ARCHIVE_DIR)
  }

  private segmentsOf(): readonly Segment[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.archiveDir())
    } catch {
      return []
    }
    const found: Segment[] = []
    for (const name of names) {
      const firstSeq = segmentFirstSeq(name)
      if (firstSeq !== null) found.push({ file: path.join(this.archiveDir(), name), firstSeq })
    }
    return found.sort((a, b) => a.firstSeq - b.firstSeq)
  }

  /** Every file that holds part of the log, oldest first. */
  private sources(): readonly string[] {
    const files = this.segmentsOf().map((segment) => segment.file)
    if (fs.existsSync(this.filePath)) files.push(this.filePath)
    return files
  }

  /**
   * The sources that can still hold an entry after `afterSeq`.
   *
   * Decided from the FILENAMES alone — a segment named for its first `seq` ends
   * where the next one begins, so a segment is entirely behind the cursor when
   * the next segment starts at or before `afterSeq + 1`. No file is opened to
   * find that out, which is what makes a cursor-based read cheap on a long
   * history. The newest segment has no successor to bound it, so it is always
   * read; it is bounded by `ROTATE_AT_BYTES`, so that costs at most one
   * segment.
   */
  private sourcesFrom(afterSeq: number): readonly string[] {
    const segments = this.segmentsOf()
    const files: string[] = []
    for (let i = 0; i < segments.length; i += 1) {
      const next = segments[i + 1]
      if (next && next.firstSeq <= afterSeq + 1) continue
      const segment = segments[i]
      if (segment) files.push(segment.file)
    }
    if (fs.existsSync(this.filePath)) files.push(this.filePath)
    return files
  }

  /** The first readable `seq` in `file`, or null when it holds none. */
  private firstSeqOf(file: string): number | null {
    for (const line of linesOf(file)) {
      const entry = parseLogLine(line)
      if (entry) return entry.seq
    }
    return null
  }

  private highestSeq(): number {
    // Newest first: the highest seq is in the newest source that has one, and
    // an empty live file after a rotation must not read as "no history".
    for (const file of [...this.sources()].reverse()) {
      let highest = 0
      for (const line of linesOf(file)) {
        const entry = parseLogLine(line)
        if (entry && entry.seq > highest) highest = entry.seq
      }
      if (highest > 0) return highest
    }
    return 0
  }

  /** True when the file's last byte is not a newline — i.e. a torn final line. */
  private endsMidLine(): boolean {
    if (!fs.existsSync(this.filePath)) return false
    const size = fs.statSync(this.filePath).size
    if (size === 0) return false
    const fd = fs.openSync(this.filePath, 'r')
    try {
      const tail = Buffer.alloc(1)
      fs.readSync(fd, tail, 0, 1, size - 1)
      return tail[0] !== 0x0a
    } finally {
      fs.closeSync(fd)
    }
  }
}

/** Lines of a log file, or none when it cannot be read. */
function linesOf(file: string): readonly string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }
}
