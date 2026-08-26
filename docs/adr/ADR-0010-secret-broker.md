# ADR-0010 — Write-only secret broker with env injection at spawn

**Status:** accepted · **Date:** 2026-08-26

## Context
Ephesus holds real credentials: voice provider keys, BYOK model keys, chat bridge
tokens, webhook secrets. The renderer is the largest attack surface (it renders
agent-produced and internet-derived content); agents themselves are LLMs that can be
prompt-injected into exfiltrating anything readable in their environment.

## Decision
A **write-only broker** in the main process:

- The UI can *set*, *rotate*, *delete*, and *test* a credential — never read one back.
  IPC exposes `secret:set(name, value)`, `secret:status(name) → {present, lastRotated}`,
  `secret:test(name) → ok|fail`, and nothing that returns a value.
- Storage uses the OS keychain where available (Keychain/DPAPI/libsecret), falling back
  to an encrypted file keyed per-machine; plaintext never touches the Agora, SQLite,
  logs, or telemetry (NFR-8).
- Agents receive credentials **only via environment injection at spawn**, and only the
  variables their role's hire template *declares* — a triage agent gets the GitHub
  token, not the ElevenLabs key. Scope is least-privilege by construction.
- The Harbor's outbound calls (voice, chat, webhooks) are made by the main process,
  which reads from the broker directly; renderer and agents see only results.
- A redaction filter scrubs known secret values from PTY streams before they reach the
  renderer or logs (defense-in-depth for agents that `echo $TOKEN`).

## Options considered
- **Settings-file storage (plaintext or lightly obfuscated).** Simple, and exactly the
  thing that ends up in a screen-share or a committed dotfile. Rejected.
- **Readable secret store with permissioned reads.** Every read path is a future leak;
  write-only removes the class.
- **No broker; user exports env vars.** Punts scoping — every agent inherits everything.

## Consequences
- "Show me my key" is impossible by design; the Architect re-pastes from the provider
  console when in doubt. This is the accepted UX cost.
- Per-role env declaration adds a field to hire templates and one more review point in
  memo policy (a role asking for new credentials is a security-posture change → memo).
- The redaction filter can produce false positives in terminals (masked strings); the
  filter marks masks visibly (`•••eph-masked•••`) so confusion is diagnosable.

## Prior art
Munder Difflin's write-only secret broker for BYOK keys; standard secret-manager
practice (write-only + injection) from CI systems.
