import { describe, expect, it } from 'vitest'
import { deriveRepo, githubSlug } from '../../src/shared/repo-remote'
import { repoRemoteSchema } from '../../src/shared/harbor'
import { activationRequestSchema, watchedRepos } from '../../src/shared/profile-activation'

/**
 * Which repository a checkout is (M8.5, B7).
 *
 * Both shipped bundles carry `repos: []` and the bundle was the only source of
 * that list, so activating the Skeleton Crew against a real repository watched
 * nothing: no CI run, issue or pull request ingested, therefore no incident
 * ever raised. The flagship mission was inert on first use and this machine
 * only worked because `harbor.json` had been hand-edited.
 *
 * The package's risk line is what most of this file is about: **deriving the
 * repo from the target guesses a remote — refuse and say so when the target has
 * no unambiguous remote, rather than inventing one.** A wrong slug is worse
 * than no slug, because the company would then watch somebody else's
 * repository and raise incidents about it.
 */

describe('reading owner/repo out of a git remote', () => {
  it('reads every URL form git actually writes', () => {
    const forms = [
      'https://github.com/mertefesensoy/Ephesus.git',
      'https://github.com/mertefesensoy/Ephesus',
      'https://github.com/mertefesensoy/Ephesus/',
      'http://github.com/mertefesensoy/Ephesus.git',
      'git@github.com:mertefesensoy/Ephesus.git',
      'git@github.com:mertefesensoy/Ephesus',
      'ssh://git@github.com/mertefesensoy/Ephesus.git',
      'git://github.com/mertefesensoy/Ephesus.git',
      'https://www.github.com/mertefesensoy/Ephesus.git'
    ]
    for (const url of forms) {
      expect(githubSlug(url), url).toEqual({ ok: true, slug: 'mertefesensoy/Ephesus' })
    }
  })

  it('produces a slug the Harbor will accept', () => {
    // Two regexes that drift are how a value validated on one screen is
    // rejected by the subsystem that consumes it. `gh` is handed this string.
    const parsed = githubSlug('git@github.com:owner/my.repo-2.git')
    if (!parsed.ok) throw new Error('expected a slug')
    expect(parsed.slug).toBe('owner/my.repo-2')
    expect(repoRemoteSchema.safeParse(parsed.slug).success).toBe(true)
  })

  it('refuses a host this build cannot ingest from, and names only the host', () => {
    for (const url of [
      'https://gitlab.com/owner/repo.git',
      'git@bitbucket.org:owner/repo.git',
      'https://github.mycorp.example/owner/repo.git'
    ]) {
      const parsed = githubSlug(url)
      expect(parsed.ok, url).toBe(false)
    }
    expect(githubSlug('https://gitlab.com/owner/repo.git')).toEqual({
      ok: false,
      host: 'gitlab.com'
    })
    // GitHub Enterprise is a different host and `gh` is not pointed at it here.
    expect(githubSlug('https://github.mycorp.example/o/r.git')).toEqual({
      ok: false,
      host: 'github.mycorp.example'
    })
  })

  it('NEVER returns any part of a remote that could carry a credential', () => {
    // `gh` itself writes remotes of this shape. ENGINEERING-STANDARDS §5: a
    // token must not reach a log line, a screen, or a degradation.
    // Deliberately NOT a real provider prefix:  refuses a
    // secret-shaped string anywhere in the tree, including a fixture, and a
    // test that had to be exempted from that rule would be teaching the wrong
    // lesson. What is under test is that the URL's credential POSITION never
    // reaches the output, whatever is sitting in it.
    const secret = 'REDACTED-CREDENTIAL-VALUE-0000000000'
    const withToken = `https://x-access-token:${secret}@github.com/owner/repo.git`
    const parsed = githubSlug(withToken)
    expect(parsed).toEqual({ ok: true, slug: 'owner/repo' })
    expect(JSON.stringify(parsed)).not.toContain(secret)
    expect(JSON.stringify(parsed)).not.toContain('x-access-token')

    // And on the refusal path, where the reason is built from parts.
    const foreign = githubSlug(`https://user:${secret}@gitlab.com/owner/repo.git`)
    expect(foreign).toEqual({ ok: false, host: 'gitlab.com' })
    expect(JSON.stringify(foreign)).not.toContain(secret)
  })

  it('says it could not find a host at all rather than guessing one', () => {
    for (const url of ['', '   ', 'C:\\repos\\myapp', 'not a url', '/srv/git/repo.git']) {
      const parsed = githubSlug(url)
      expect(parsed.ok, url).toBe(false)
      if (!parsed.ok) expect(parsed.host, url).toBeNull()
    }
  })

  it('refuses a github URL that is not two path segments', () => {
    for (const url of [
      'https://github.com/owner',
      'https://github.com/',
      'https://github.com/owner/repo/tree/main'
    ]) {
      expect(githubSlug(url).ok, url).toBe(false)
    }
  })
})

describe('deriving the ONE repository a checkout is', () => {
  const remote = (name: string, url: string): { name: string; url: string } => ({ name, url })

  it('reads the answer off a single origin', () => {
    expect(deriveRepo([remote('origin', 'https://github.com/owner/app.git')])).toEqual({
      ok: true,
      slug: 'owner/app',
      from: 'origin'
    })
  })

  it('is not confused by fetch and push lines for the same remote', () => {
    // `git remote -v` prints one line per direction; `readRemotes` deduplicates
    // by (name, url), but a differently-written pair still resolves here.
    expect(
      deriveRepo([
        remote('origin', 'https://github.com/owner/app.git'),
        remote('origin', 'git@github.com:owner/app.git')
      ])
    ).toEqual({ ok: true, slug: 'owner/app', from: 'origin' })
  })

  it('resolves several remotes that all name the SAME repository', () => {
    // One answer written down twice is not ambiguity.
    const derived = deriveRepo([
      remote('mirror', 'https://github.com/owner/app.git'),
      remote('origin', 'git@github.com:owner/app.git')
    ])
    expect(derived).toEqual({ ok: true, slug: 'owner/app', from: 'origin' })
  })

  it('REFUSES a fork, and names both candidates', () => {
    // The case the risk line is about. `origin` is the Architect's fork and
    // `upstream` the canonical repository; which one a mission should watch is
    // a real decision with different consequences, and preferring `origin`
    // would make it silently and be right often enough that the times it was
    // wrong would be baffling.
    const derived = deriveRepo([
      remote('origin', 'git@github.com:me/app.git'),
      remote('upstream', 'https://github.com/canonical/app.git')
    ])
    expect(derived.ok).toBe(false)
    if (derived.ok) throw new Error('unreachable')
    expect(derived.because).toContain('more than one')
    expect(derived.because).toContain('origin → me/app')
    expect(derived.because).toContain('upstream → canonical/app')
    // And it tells the Architect what to do about it.
    expect(derived.because).toContain('name the one to watch')
  })

  it('says a checkout has no remote at all', () => {
    const derived = deriveRepo([])
    expect(derived).toEqual({ ok: false, because: 'the target has no git remote' })
  })

  it('says a checkout has remotes but none on github.com, and which hosts', () => {
    const derived = deriveRepo([
      remote('origin', 'https://gitlab.com/owner/app.git'),
      remote('backup', '/srv/git/app.git')
    ])
    expect(derived.ok).toBe(false)
    if (derived.ok) throw new Error('unreachable')
    expect(derived.because).toContain('no github.com remote')
    expect(derived.because).toContain('origin → gitlab.com')
    expect(derived.because).toContain('backup → not a URL')
  })

  it('ignores an unusable remote when a usable one is unambiguous', () => {
    // A gitlab mirror beside a github origin is not two answers to this
    // question: only one of them is a repository this build can ingest from.
    expect(
      deriveRepo([
        remote('origin', 'git@github.com:owner/app.git'),
        remote('gitlab', 'https://gitlab.com/owner/app.git')
      ])
    ).toEqual({ ok: true, slug: 'owner/app', from: 'origin' })
  })

  it('names a non-origin remote when that is the only one', () => {
    expect(deriveRepo([remote('upstream', 'git@github.com:canonical/app.git')])).toEqual({
      ok: true,
      slug: 'canonical/app',
      from: 'upstream'
    })
  })
})

/**
 * The Architect's typed override and the Harbor's own list are the same string
 * (M8.5). Two regexes that drift are how a value validated on one screen is
 * rejected by the subsystem that consumes it — the activation screen would
 * accept `owner/repo!`, the instance would carry it, and `gh` would be handed
 * something nobody checked.
 */
describe('the override is validated the way the Harbor validates', () => {
  const ask = (slug: string): { screen: boolean; harbor: boolean } => ({
    screen: activationRequestSchema.safeParse({
      profile: 'skeleton-crew',
      target: { kind: 'repo', id: 'myapp', path: '/repos/myapp' },
      repos: [slug]
    }).success,
    harbor: repoRemoteSchema.safeParse(slug).success
  })

  it('accepts and refuses exactly the same slugs', () => {
    const cases = [
      'owner/repo',
      'owner/my.repo-2',
      'Owner/Repo_1',
      'o/r',
      'owner/repo!',
      'owner repo',
      'owner/repo/extra',
      'owner',
      '/repo',
      'owner/',
      `${'a'.repeat(120)}/${'b'.repeat(120)}`
    ]
    for (const slug of cases) {
      const answer = ask(slug)
      expect(answer.screen, slug).toBe(answer.harbor)
    }
  })

  it('refuses an override that is not a list of slugs at all', () => {
    const request = {
      profile: 'skeleton-crew',
      target: { kind: 'repo', id: 'myapp', path: '/repos/myapp' }
    }
    expect(activationRequestSchema.safeParse({ ...request, repos: 'owner/repo' }).success).toBe(
      false
    )
    expect(activationRequestSchema.safeParse({ ...request, repos: [1] }).success).toBe(false)
    // …and accepts a request that names none, which is the normal path.
    expect(activationRequestSchema.safeParse(request).success).toBe(true)
  })
})

/**
 * `watchedRepos` — one function for two questions that must never disagree:
 * what the Harbor ingests from, and whether the ingest cadence is armed at all
 * (M8.5). They were two inlined expressions in `index.ts`, and an inlined
 * resolver is untestable: the only assertion available would be a COPY that
 * stays green while the original rots, which is exactly how the incident path
 * lost its whole production life in M7.4.
 */
describe('the repositories every live instance watches', () => {
  const live = (repos: readonly string[]): { plan: { repos: readonly string[] } } => ({
    plan: { repos }
  })

  it('ingests a repository ONCE when two instances watch it', () => {
    // Two profiles on one floor pointed at the same repository is normal —
    // triage and CI babysitting on one codebase. Ingesting it twice would
    // raise every incident twice.
    expect(watchedRepos([live(['owner/app']), live(['owner/app'])])).toEqual(['owner/app'])
    expect(watchedRepos([live(['a/one', 'b/two']), live(['b/two', 'c/three'])])).toEqual([
      'a/one',
      'b/two',
      'c/three'
    ])
  })

  it('does not let activation ORDER decide ingest order', () => {
    // Otherwise one machine's log is unlike another's for no reason anybody
    // can see, which is the kind of difference that wastes a forensic hour.
    const forwards = watchedRepos([live(['zzz/last']), live(['aaa/first'])])
    const backwards = watchedRepos([live(['aaa/first']), live(['zzz/last'])])
    expect(forwards).toEqual(['aaa/first', 'zzz/last'])
    expect(forwards).toEqual(backwards)
  })

  it('is empty for no instances and for instances watching nothing', () => {
    // The cadence's arming condition reads this, so the empty answer is the
    // one that decides whether `gh` is shelled out to every ten minutes.
    expect(watchedRepos([])).toEqual([])
    expect(watchedRepos([live([]), live([])])).toEqual([])
  })
})
