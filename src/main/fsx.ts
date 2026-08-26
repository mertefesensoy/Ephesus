import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Atomic file write: temp file in the same directory + rename (BUILD-PROMPT §3.3).
 * A bare writeFile onto a live path is a bug by invariant — every file another
 * process may read goes through here. rename() replaces existing targets on all
 * supported platforms (MOVEFILE_REPLACE_EXISTING semantics on Windows).
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)
  fs.writeFileSync(tmp, data, 'utf8')
  try {
    fs.renameSync(tmp, filePath)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}
