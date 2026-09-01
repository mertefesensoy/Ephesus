import { z } from 'zod'

/**
 * The company's GitHub identity, as configuration
 * (`<harness home>/github-app.json`, ADR-0022).
 *
 * ADR-0020 chose a machine user holding a fine-grained PAT and named a GitHub
 * App as a post-v1 candidate, judging the App "heavier to stand up". What made
 * an App heavy in that reading was the webhook endpoint — and the Harbor polls
 * (`src/main/harbor/github.ts` shells out to `gh`), so Ephesus never needed
 * one. ADR-0022 supersedes that option choice.
 *
 * Nothing here is a credential. The App id and the installation id are public
 * identifiers that appear in URLs; the private key is a secret and lives in the
 * broker under `GH_APP_PRIVATE_KEY`, never in this file (ADR-0010: the config
 * says which credential, the broker holds it).
 */
export const GITHUB_APP_SCHEMA_VERSION = 1

/** The name the broker holds the App's signing key under. */
export const GITHUB_APP_KEY_SECRET = 'GH_APP_PRIVATE_KEY'

/** The grant name a hire declares to receive a working GitHub credential. */
export const GITHUB_TOKEN_GRANT = 'GH_TOKEN'

export const githubAppConfigSchema = z
  .object({
    schemaVersion: z.literal(GITHUB_APP_SCHEMA_VERSION),
    /** The App's numeric id, from its settings page. */
    appId: z.number().int().positive(),
    /** The installation on the account or repository, from the install URL. */
    installationId: z.number().int().positive(),
    /**
     * The App's slug, used to derive the bot's git identity. Optional: it can
     * be read back from the API, and a config that guessed it wrongly would
     * author commits under a name that credits nobody.
     */
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'the App slug as it appears in its URL')
      .optional()
  })
  .strict()

export type GitHubAppConfig = z.infer<typeof githubAppConfigSchema>

/**
 * Contract: pure. The git author identity for a GitHub App's bot user.
 *
 * GitHub resolves a noreply address of the form `<numeric id>+<login>@…`, and
 * ONLY that form. ADR-0020's `ephesus-crew+agent.mason@users.noreply.github.com`
 * would have credited nothing — the part before the `+` must be the account's
 * numeric id, not a name — which is why the id is fetched rather than assumed.
 */
export function botIdentity(slug: string, userId: number): { name: string; email: string } {
  const login = `${slug}[bot]`
  return { name: login, email: `${String(userId)}+${login}@users.noreply.github.com` }
}

/**
 * Contract: pure. The co-author trailer naming the agent that did the work
 * (ADR-0020's authorship rule, with ADR-0022's corrected address).
 *
 * The company account authors; the agent co-authors itself. Both lines are the
 * bot's address because the agent has no GitHub account of its own and inventing
 * one would put a name on the contributor graph that no human owns.
 */
export function coAuthorTrailer(
  agentId: string,
  identity: { name: string; email: string }
): string {
  return `Co-authored-by: ${agentId} <${identity.email}>`
}
