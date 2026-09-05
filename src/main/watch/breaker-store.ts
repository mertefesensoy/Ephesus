import fs from 'node:fs'
import path from 'node:path'
import { breakerStopsSchema, type BreakerStop } from '../../shared/breaker'
import { writeFileAtomic } from '../fsx'

export interface BreakerStopStore {
  load(): readonly BreakerStop[]
  save(stops: readonly BreakerStop[]): void
}

/** App-local state. Malformed or unreadable records must never mean no stops. */
export class FileBreakerStopStore implements BreakerStopStore {
  constructor(private readonly file: string) {}

  load(): readonly BreakerStop[] {
    let text: string
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return breakerStopsSchema.parse(JSON.parse(text)).stops
  }

  save(stops: readonly BreakerStop[]): void {
    const record = breakerStopsSchema.parse({ schemaVersion: 1, stops })
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileAtomic(this.file, `${JSON.stringify(record, null, 2)}\n`)
  }
}
