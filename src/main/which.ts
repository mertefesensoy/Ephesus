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
 *
 * ## Why the shim is unwrapped, and not merely found
 *
 * Finding `claude.cmd` is not enough. A `.cmd` runs under `cmd.exe`, whose
 * command line is capped at **8,191 characters** — and Claude Code takes an
 * agent's whole identity on the command line (`--append-system-prompt`).
 *
 * That cap is not theoretical. Pointed at a real repository at M7.7, the
 * orchestrator's identity came to 10,908 bytes and every spawn died with
 * `cmd.exe` printing "The command line is too long." and exiting 1 — five
 * times, until the harness gave up on her. The three crew agents survived on
 * 7,934–7,979 bytes, inside 250 bytes of the same cliff, and `memory.md` is
 * append-only, so they were going to cross it too.
 *
 * Spawning the executable the shim WRAPS skips `cmd.exe` and gets
 * `CreateProcess`'s 32,767-character limit instead — four times the headroom,
 * for a payload whose only unbounded part (memory) is already budgeted.
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
 * Contract: the executable a Windows `.cmd`/`.bat` shim invokes, or null.
 * Pure apart from reading the shim; never throws.
 *
 * npm writes shims that call the real binary with `%dp0%` (the shim's own
 * directory) as the prefix, so the path is resolved against that rather than
 * against the working directory. Anything unrecognised returns null and the
 * caller keeps the shim — a spawn through `cmd.exe` is limited, but a spawn of
 * a path this function guessed wrong would not run at all.
 */
export function unwrapWindowsShim(shimPath: string): string | null {
  const ext = path.extname(shimPath).toLowerCase()
  if (ext !== '.cmd' && ext !== '.bat') return null
  let body: string
  try {
    body = fs.readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  const dir = path.dirname(shimPath)
  // Quoted paths first: npm always quotes, and an unquoted match would stop at
  // the first space in "Program Files".
  for (const match of body.matchAll(/"([^"\r\n]*\.exe)"/gi)) {
    const raw = match[1]
    if (raw === undefined) continue
    const expanded = raw.replace(/%~?dp0%?/gi, `${dir}${path.sep}`).replace(/[\\/]{2,}/g, path.sep)
    const candidate = path.isAbsolute(expanded) ? expanded : path.join(dir, expanded)
    // Never return a path that is not there: the shim would at least have run.
    if (isFile(candidate)) return candidate
  }
  return null
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
      // The shim's target beats the shim: see the header on the 8,191-character
      // `cmd.exe` cap. Falls back to the shim whenever unwrapping is not
      // certain.
      if (isFile(candidate)) return unwrapWindowsShim(candidate) ?? candidate
    }
  }
  return command
}
