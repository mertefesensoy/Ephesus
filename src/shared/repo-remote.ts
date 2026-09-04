/**
 * Which repository a checkout on this machine actually is (M8.5, B7).
 *
 * A mission profile is activated against a TARGET — a directory the Architect
 * names — and the Harbor ingests from a list of `owner/repo` slugs. Until now
 * the only source of that list was the bundle's `harbor.json`, and both shipped
 * bundles carry `repos: []`. So activating the Skeleton Crew against a real
 * repository watched nothing: no CI run, issue or pull request was ever
 * ingested, therefore no incident could ever be raised, and the flagship
 * mission was inert on first use. This machine only worked because
 * `harbor.json` had been hand-edited.
 *
 * The checkout already knows what repository it is. This module reads that
 * answer out of its git remotes.
 *
 * ## Refusing is a first-class answer
 *
 * The package's own risk line: *deriving the repo from the target guesses a
 * remote — refuse and say so when the target has no unambiguous remote, rather
 * than inventing one.* A wrong slug is worse than no slug, because the company
 * would then watch somebody else's repository and raise incidents about it. So
 * every function here returns either an answer or a SENTENCE saying why there
 * is none, and the sentence is written to be shown to a human.
 *
 * ## Never echo a remote URL
 *
 * A remote can carry a credential — `https://x-access-token:ghp_…@github.com/…`
 * is what `gh` itself writes. So a refusal names the remote and its HOST, never
 * the URL. ENGINEERING-STANDARDS §5, and the reason `because` is built from
 * parts rather than interpolating the input.
 */

/** One line of `git remote -v`, already split. */
export interface GitRemote {
  /** `origin`, `upstream`, … */
  readonly name: string
  readonly url: string
}

export type SlugParse =
  | { readonly ok: true; readonly slug: string }
  /** `host` is null when the URL had no recognisable host at all. */
  | { readonly ok: false; readonly host: string | null }

export type RepoDerivation =
  | {
      readonly ok: true
      readonly slug: string
      /** The remote the slug came from, for the screen. */
      readonly from: string
    }
  | { readonly ok: false; readonly because: string }

/** The hosts this build can ingest from — the Harbor speaks to `gh` (FR-10.1). */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/**
 * `owner/repo` is two path segments, and `.git` is optional. Owner and repo
 * follow GitHub's own character set; anything else is not a slug we should
 * hand to `gh`.
 */
const SLUG_PATH = /^\/?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/

/**
 * Contract: the `owner/repo` a git remote URL points at on GitHub, or a refusal
 * carrying only the host. Never throws, and never returns any part of the URL
 * beyond the host and the slug — a remote may carry a credential.
 *
 * Handles the four forms git actually writes: `https://host/owner/repo(.git)`,
 * `ssh://git@host/owner/repo(.git)`, `git://host/owner/repo(.git)` and the scp
 * shorthand `git@host:owner/repo(.git)`. A filesystem path is not a remote we
 * can name, and says so with a null host.
 */
export function githubSlug(url: string): SlugParse {
  const trimmed = url.trim()
  if (trimmed.length === 0) return { ok: false, host: null }

  // The scp shorthand (`git@github.com:owner/repo.git`) is not a URL and
  // `new URL()` does not parse it, so it is matched before anything else.
  //
  // The one-character guard is git's own rule about Windows: `C:\repos\myapp`
  // parses as scp-with-host-`c` otherwise, and a local path would be reported
  // as "not a github.com remote (c)" — a sentence that tells the Architect
  // nothing and would send them looking for a host called `c`.
  const scp = /^(?:([^@/]+)@)?([^:/]{2,}):(?!\/)(.+)$/.exec(trimmed)
  if (scp) {
    const host = (scp[2] ?? '').toLowerCase()
    return finish(host, scp[3] ?? '')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, host: null }
  }
  return finish(parsed.hostname.toLowerCase(), parsed.pathname)
}

function finish(host: string, pathPart: string): SlugParse {
  if (!GITHUB_HOSTS.has(host)) return { ok: false, host: host.length > 0 ? host : null }
  const match = SLUG_PATH.exec(pathPart)
  const owner = match?.[1]
  const repo = match?.[2]
  if (owner === undefined || repo === undefined) return { ok: false, host }
  return { ok: true, slug: `${owner}/${repo}` }
}

/**
 * Contract: the ONE repository this checkout unambiguously is, or a sentence
 * saying why there is no such answer. Pure; never throws.
 *
 * The ambiguity rule, and why it is not "prefer origin": a fork has `origin`
 * pointing at the Architect's copy and `upstream` at the canonical repository,
 * and which of those a mission should watch is a real decision with different
 * consequences — incidents raised on the wrong one are noise nobody asked for.
 * Preferring `origin` would make that decision silently and be right often
 * enough that the times it was wrong would be baffling. So two distinct
 * repositories is a refusal that NAMES BOTH, and the Architect picks one on the
 * activation screen.
 *
 * Several remotes pointing at the SAME repository is not ambiguity — that is
 * one answer written down twice — so it resolves, preferring `origin`'s name
 * for the report.
 */
export function deriveRepo(remotes: readonly GitRemote[]): RepoDerivation {
  if (remotes.length === 0) {
    return { ok: false, because: 'the target has no git remote' }
  }

  /** slug → the remote names that point at it, in the order they were seen. */
  const bySlug = new Map<string, string[]>()
  const foreign: string[] = []
  for (const remote of remotes) {
    const parsed = githubSlug(remote.url)
    if (parsed.ok) {
      const names = bySlug.get(parsed.slug) ?? []
      if (!names.includes(remote.name)) names.push(remote.name)
      bySlug.set(parsed.slug, names)
      continue
    }
    const where = parsed.host === null ? 'not a URL' : parsed.host
    const line = `${remote.name} → ${where}`
    if (!foreign.includes(line)) foreign.push(line)
  }

  if (bySlug.size === 0) {
    return {
      ok: false,
      because: `the target has no github.com remote (${foreign.join(', ')})`
    }
  }

  if (bySlug.size > 1) {
    const candidates = [...bySlug.entries()]
      .map(([slug, names]) => `${names.join('/')} → ${slug}`)
      .sort()
      .join(', ')
    return {
      ok: false,
      because: `the target has more than one github.com remote (${candidates}) — name the one to watch`
    }
  }

  const only = [...bySlug.entries()][0]
  if (only === undefined) return { ok: false, because: 'the target has no git remote' }
  const [slug, names] = only
  return { ok: true, slug, from: names.includes('origin') ? 'origin' : (names[0] ?? 'origin') }
}
