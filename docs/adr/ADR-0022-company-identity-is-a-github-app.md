# ADR-0022 — The company identity is a GitHub App, not a machine user

**Status:** accepted · **Date:** 2026-09-01
**Supersedes:** ADR-0020's option choice and its authorship address. ADR-0020's
*intent* — the company signs its own work, no vendor identity anywhere, the
Architect's name never on work they have not seen — is unchanged and is why this
exists.

## Context
ADR-0020 chose a machine user holding a fine-grained PAT, and listed a GitHub
App as "heavier to stand up and administer for a single-operator system… a named
candidate for post-v1". Two things have changed since.

**The weight was in a part Ephesus does not need.** What makes an App heavy is
normally the webhook endpoint — a public URL, a listener, a secret to verify
signatures. The Harbor polls: `src/main/harbor/github.ts` shells out to `gh`,
and the MUSAHIT incidents on the 2026-09-01 run arrived that way. With no
webhook, an App is a signing key, a JWT, and one exchange call.

**The Architect asked how Claude and Cursor do it.** They do it with a GitHub
App. That is where the `[bot]` suffix comes from, and it is not available to a
machine user at all — a machine user is an ordinary account with a name that
sounds like a robot.

There is also an error in ADR-0020 to correct. It specified the trailer
`Co-authored-by: Mason (agent.mason) <ephesus-crew+agent.mason@users.noreply.github.com>`,
reasoning that the plus-suffix form "credits the machine account's graph while
naming the agent". It does not: GitHub resolves a noreply address only in the
form `<numeric user id>+<login>@users.noreply.github.com`. The part before the
`+` must be the account's id. As written, every agent co-author line would have
credited nobody.

## Decision
**The company is a GitHub App. Its credential is minted, never stored.**

- **Configuration is not a credential.** `<harness home>/github-app.json` holds
  the App id, the installation id and optionally the slug — all public, all
  visible in URLs. The signing key is a secret and lives in the broker under
  `GH_APP_PRIVATE_KEY` (ADR-0010: the config names which credential, the broker
  holds it).
- **The key never leaves the process.** It signs a short-lived RS256 JWT
  locally; only the JWT is sent, and only to exchange it for an installation
  token. `node:crypto` and `fetch`, no new dependency.
- **Agents receive a token that expires.** The installation token lasts an hour
  and is refreshed at fifty minutes, so no spawn is handed a credential with
  minutes left on it — SRS §6.1's acceptance window is itself an hour, and a
  credential expiring mid-run would present as a permissions bug.
- **The broker still answers first.** If the Architect stored a `GH_TOKEN` by
  hand they meant it, and a minted token silently overriding it would make the
  stored one impossible to test. The App fills a gap; it does not take over.
- **Authorship, corrected.** Commits are authored and committed as
  `<slug>[bot] <id+<slug>[bot]@users.noreply.github.com>`, where the id is READ
  BACK from the API rather than assumed. Each agent co-authors itself through
  `$EPH_COAUTHOR`, composed at spawn and handed to the agent ready-made, because
  an agent cannot know the address. Identity travels as environment, never as
  git config written into the Architect's checkout.
- **An unconfigured Ephesus is unchanged.** `configured()` is false until both
  the config file exists and the broker holds the key; `commitIdentity` is then
  null, no `GIT_AUTHOR_*` is set, and agents commit as whoever git already
  thought they were — visible, rather than as a name the harness invented.

## Options considered
- **Machine user + fine-grained PAT (ADR-0020 as written).** Still viable and
  simpler to stand up. Rejected on the failure mode: a leaked PAT is valid until
  somebody notices, and rotating it is a standing duty ADR-0020 itself lists as a
  new burden on the Architect. An installation token that leaks is dead within
  the hour and there is nothing long-lived to rotate.
- **Machine user now, App later.** Offered and declined. Migrating after commits
  exist under a machine account's name means a contributor graph split across two
  identities for the same work.
- **Per-agent GitHub accounts.** Rejected in ADR-0020 and still rejected: the
  trailer names the agent, the account names the company.

## Consequences
- The `[bot]` suffix is real, so a reader of the repository can tell company work
  from human work at a glance without knowing any convention.
- The Architect's standing duties **shrink**: no PAT to rotate. What replaces it
  is a private key to keep, which is a file to back up rather than a secret to
  re-issue on a schedule.
- Revocation is uninstalling the App, which is one click and immediate, rather
  than deleting a token and hoping nothing else used it.
- A compromised agent can at worst open branches and PRs as the company for at
  most an hour on a token it holds — visible, revertible, and it never held the
  Architect's identity.
- **Still owed, and not delivered here:** ADR-0020's enforcement clause, that
  company authorship is legal only on `agent/*` branches and a company-authored
  commit on `main` that did not arrive by an Architect-merged PR fails the job.
  `scripts/check-attribution.cjs` today bans only Claude/Anthropic identities and
  would accept a company-authored commit anywhere. It cannot fire until agents
  commit, so it is recorded as owed rather than half-built.
- ENGINEERING-STANDARDS §2's attribution clause is amended as ADR-0020 described;
  the anti-vendor-identity clause is untouched and remains absolute.

## Prior art
ADR-0020 (this supersedes its option choice and its address, keeps its
intent); ADR-0010 (write-only broker, env-injected by name); ADR-0009 (adapters
own engine-specific facts — the identity is handed to them, never derived by
them); GitHub's own App installation-token flow.
