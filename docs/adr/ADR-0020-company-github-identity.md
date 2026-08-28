# ADR-0020 — A company GitHub identity: agents co-author as themselves, never as the Architect

**Status:** accepted · **Date:** 2026-08-28

## Context
ADR-0019's delivery shape is a pull request, and a pull request needs an
author. Until now every commit in this repository is authored and committed by
the Architect (ENGINEERING-STANDARDS §2), with agent identity confined to an
`Agent:` trailer that names no account — a rule written for the build phase,
where the Architect's own sessions do the typing. The Architect's directive
(2026-08-28): give the company a GitHub account so agents can **co-author
themselves**.

Two lines must not blur while doing this:
- **Nothing the company writes may impersonate the Architect.** A PR that
  looks Architect-authored is a forged signature on the very change the
  Architect is supposed to be reviewing.
- **The anti-Claude/Anthropic-identity rule is not relaxed.** That rule exists
  so no vendor identity accrues credit on the contributor graph; it applies to
  the company identity exactly as before. The company account is an *Ephesus*
  identity, owned by the Architect.

## Decision
**One machine account for the whole company**, plus per-agent co-author
trailers.

- **The account.** The Architect creates a single GitHub machine account for
  the harness (e.g. `ephesus-crew`; GitHub's terms allow one machine account
  per user — one, which is itself a reason not to design for per-agent
  accounts). The Architect owns its credentials and its recovery.
- **Least privilege, enforced by the host.** The account gets `write` on the
  target repository, never admin; `main` stays protected (PRs only, review
  required — ENGINEERING-STANDARDS §2), so the account *cannot* merge or push
  `main` even if an agent tries. Merge authority remains the Architect's
  GitHub identity alone.
- **The credential rides the broker.** A fine-grained PAT (contents +
  pull-requests on the named repo only) is stored write-only in the secret
  broker (ADR-0010) and env-injected at spawn solely to roles whose hire
  template declares the grant — the improver role, not the researcher, whose
  spawns stay no-secrets by NFR-17. Rotation and revocation are one broker
  action; revoking the PAT disables delivery without touching the mission
  design (ADR-0019's separation).
- **Authorship.** Run-phase agent commits are authored and committed as the
  company account, with the individual agent co-authoring itself:
  `Co-authored-by: Mason (agent.mason) <ephesus-crew+agent.mason@users.noreply.github.com>`
  — the plus-suffix noreply form credits the machine account's graph while
  naming the agent, and the existing `Agent:` trailer stays for the harness's
  own forensics. The Architect's own commits are unchanged: solely the
  Architect, no trailers, exactly as §2 has always required.
- **Every remote act is on the record.** PR opens, pushes, and comments by the
  company account are logged like any Harbor action (FR-10.3's spirit:
  source-tagged in `log.jsonl`), so "what did the company do on GitHub?" is a
  ledger query.
- **Enforcement follows the rule.** `scripts/check-attribution.cjs` today
  asserts "no Claude/Anthropic identity" and "Architect authors everything";
  the first clause is unchanged and the second gains one carve-out —
  company-account authorship is legal **only** on `agent/*` branches. A
  company-account commit on `main` that did not arrive by an
  Architect-merged PR fails the job. (A code change, owed to the M7 package
  that first exercises the identity — this ADR is its specification.)

## Options considered
- **Per-agent GitHub accounts.** The literal reading of "co-author
  themselves". N accounts to create, secure, and rotate; against GitHub's
  one-machine-account allowance; and adds no review signal a trailer does not.
  The trailer names the agent; the account names the company.
- **Agents commit as the Architect (status quo stretched to the run phase).**
  Forges the Architect's word on work the Architect has not seen — the exact
  inversion of the accountability design. Rejected outright.
- **A GitHub App instead of a machine account.** Better token hygiene at real
  scale, but heavier to stand up and administer for a single-operator system;
  the broker + fine-grained PAT reaches the same least-privilege posture. A
  named candidate for post-v1 if the fleet outgrows one account.
- **Anonymous patches (no identity; Architect commits everything the agents
  produce).** Today's build-phase reality. Loses PR-native review and buries
  the company's labor in the Architect's name — the directive asks for the
  opposite.

## Consequences
- The contributor graph starts telling the truth: the Architect's commits are
  the Architect's, the company's are the company's, and each agent is visible
  in its co-author line — without any vendor identity anywhere.
- New standing duties for the Architect: one machine account to own, one PAT
  to rotate, branch protection to keep switched on. All one-time or
  broker-mediated.
- A compromised improver agent can at worst open branches and PRs as the
  company — visible, revertible, and revocable at the broker; it cannot merge,
  cannot touch `main`, and never held the Architect's identity.
- ENGINEERING-STANDARDS §2's attribution clause is amended (run-phase
  exception, this ADR); the change is ledgered as GYM-004 per §3's
  process-change rule.
- SRS gains FR-10.5; S-RECURSE asserts the identity boundaries alongside the
  profile's delivery flow.

## Prior art
ADR-0010 (write-only broker, env-grant least privilege — the credential path
this reuses); ADR-0005 (countersign-everything: the co-author line is a
countersignature made durable); ENGINEERING-STANDARDS §2's original
attribution rule, whose intent — nobody's name on work they did not do — is
what this ADR extends to the company itself; standard bot-account practice
(dependabot-style separate identity, review-gated).
