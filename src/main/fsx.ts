import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Atomic file write: temp file in the same directory + rename (BUILD-PROMPT §3.3).
 * A bare writeFile onto a live path is a bug by invariant — every file another
 * process may read goes through here. rename() replaces existing targets on all
 * supported platforms (MOVEFILE_REPLACE_EXISTING semantics on Windows).
 */
export function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options: { readonly mode?: number } = {}
): void {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)
  // A Buffer is written verbatim: restoring a backed-up settings file must not
  // re-encode it (ADR-0009 uninstall restores byte-for-byte).
  // `mode` is applied to the TEMP file, before the rename: a secret store that
  // is world-readable for even the width of a chmod is a leak (ADR-0010).
  const write = options.mode === undefined ? {} : { mode: options.mode }
  if (typeof data === 'string') fs.writeFileSync(tmp, data, { encoding: 'utf8', ...write })
  else fs.writeFileSync(tmp, data, write)
  try {
    fs.renameSync(tmp, filePath)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}
