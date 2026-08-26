import fs from 'node:fs'
import path from 'node:path'

/**
 * PATH resolution for spawn plans.
 *
 * Engine adapters name their binary logically (`claude`), because an adapter
 * should not know what an installation looks like on any particular OS. Turning
 * that name into something the OS can start is a platform concern, and it is
 * not optional on Windows: a PTY spawn there does not walk `PATH`/`PATHEXT` the
 * way a shell does, so a bare `claude` — which npm installs as a `.cmd` shim
 * beside a `.exe` — fails with ERROR_FILE_NOT_FOUND rather than running.
 *
 * (Found by running the real thing: the first live spawn of a real `claude`
 * through the app died on exactly this.)
 */

/** Extensions tried on Windows, in `PATHEXT` order, when the name has none. */
function windowsExtensions(env: Readonly<Record<string, string | undefined>>): string[] {
  const pathext = env['PATHEXT'] ?? env['Pathext'] ?? '.COM;.EXE;.BAT;.CMD'
  return pathext
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0)
}

function pathEntries(env: Readonly<Record<string, string | undefined>>): string[] {
  const raw = env['PATH'] ?? env['Path'] ?? ''
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0)
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Contract: returns an absolute path to `command` when it can be found on
 * `env`'s PATH, and otherwise returns `command` unchanged — so the spawn still
 * happens and fails with the OS's own error, rather than this function
 * inventing a different one. A `command` that already contains a separator is
 * returned as given; the caller meant that exact file.
 */
export function resolveExecutable(
  command: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  if (command.includes('/') || command.includes('\\')) return command

  const extensions =
    process.platform === 'win32' && path.extname(command) === '' ? windowsExtensions(env) : ['']

  for (const dir of pathEntries(env)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`)
      if (isFile(candidate)) return candidate
    }
  }
  return command
}
