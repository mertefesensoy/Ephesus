/**
 * Base environment for a spawned agent (SDD §3: `env = base ∪ role-declared
 * secret grants ∪ EPH_AGENT_ID/EPH_HOOK_TOKEN`).
 *
 * "base" is an **allowlist**, not `process.env`. ADR-0010 gives agents
 * credentials only through declared grants; handing a semi-trusted,
 * prompt-injectable process the harness's whole environment would defeat that
 * on the first spawn, whatever the grant table said. So the base carries only
 * what a CLI needs to run — where to find binaries, where its home and temp
 * directories are, and locale — and everything else has to be granted by name.
 *
 * Windows environment variable names are case-insensitive and arrive in mixed
 * case (`Path`, `SystemRoot`), so matching is case-insensitive and the original
 * name is preserved when passing the value through.
 */
const BASE_ENV_ALLOWLIST = [
  // Where to find executables.
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SHELL',
  // Where "home" and scratch space are.
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'APPDATA',
  'LOCALAPPDATA',
  // Windows system roots a child process needs to start at all.
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  // Identity and locale (no credentials).
  'USER',
  'USERNAME',
  'USERDOMAIN',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PROCESSOR_ARCHITECTURE'
] as const

const ALLOWED = new Set<string>(BASE_ENV_ALLOWLIST)

/** The allowlist, for tests and for showing the Architect what an agent inherits. */
export const AGENT_BASE_ENV_KEYS: readonly string[] = BASE_ENV_ALLOWLIST

/**
 * Contract: returns only allowlisted variables from `source`, preserving each
 * variable's original name and value. Never returns a variable that is not on
 * the list, so a new secret in the harness's environment cannot reach an agent
 * by accident.
 */
export function baseAgentEnv(
  source: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (ALLOWED.has(name.toUpperCase())) env[name] = value
  }
  return env
}
