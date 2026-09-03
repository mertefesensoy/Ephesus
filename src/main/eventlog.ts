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
 * process pointed at the same home.
 */
export class EventLog {
  private seq = 0
  private opened = false

  constructor(private readonly filePath: string) {}

  /**
   * Recovers the next sequence number from what is already on disk. Contract:
   * never throws on a damaged file — the highest readable `seq` wins, and an
   * unreadable tail is simply not counted.
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
   */
  append(draft: LogEntryDraft): LogEntry {
    this.open()
    const entry: LogEntry = { ...draft, ts: Date.now(), seq: this.seq + 1 }
    // If the previous run died mid-line, start on a clean one. The torn line is
    // left exactly as it is: unreadable to the parser, untouched on disk.
    const prefix = this.endsMidLine() ? '\n' : ''
    fs.appendFileSync(this.filePath, prefix + formatLogLine(entry), { encoding: 'utf8' })
    this.seq = entry.seq
    return entry
  }

  /**
   * Reads entries after `afterSeq`, up to `limit` (SDD §5 `agora.log`).
   * Contract: skips anything unreadable. A log with a torn tail still yields
   * every intact event before it.
   */
  read(afterSeq = 0, limit = 500): readonly LogEntry[] {
    if (!fs.existsSync(this.filePath)) return []
    const out: LogEntry[] = []
    for (const line of fs.readFileSync(this.filePath, 'utf8').split('\n')) {
      const entry = parseLogLine(line)
      if (entry && entry.seq > afterSeq) {
        out.push(entry)
        if (out.length >= limit) break
      }
    }
    return out
  }

  /**
   * The LAST `limit` readable entries.
   *
   * `read` pages FORWARD from a cursor, which is right for a consumer that
   * is catching up and wrong for one that wants to know what is true now.
   * The boot replay wants the newest degradations, and asking `read` for
   * them would hand back the oldest — register item B3, which M8.3 closes
   * at the callers that made that mistake.
   */
  tailOf(limit: number): readonly LogEntry[] {
    if (limit <= 0) return []
    const all = this.all()
    return all.length <= limit ? all : all.slice(all.length - limit)
  }

  /** Every readable entry. For tests and small logs only. */
  all(): readonly LogEntry[] {
    return this.read(0, Number.MAX_SAFE_INTEGER)
  }

  private highestSeq(): number {
    if (!fs.existsSync(this.filePath)) return 0
    let highest = 0
    for (const line of fs.readFileSync(this.filePath, 'utf8').split('\n')) {
      const entry = parseLogLine(line)
      if (entry && entry.seq > highest) highest = entry.seq
    }
    return highest
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
