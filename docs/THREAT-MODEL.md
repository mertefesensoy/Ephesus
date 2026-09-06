# Ephesus — threat model

**For:** anyone deciding whether to point Ephesus at their repositories.
**Status:** first edition, 2026-09-06. Written from the code, not from intent — every control below
names where it lives, and the residual risks are stated as plainly as the mitigations.

If you read one section, read **§6 Residual risks**. Everything above it is what Ephesus does stop.

---

## 1. What Ephesus actually is, in security terms

Ephesus runs **several coding-agent CLIs at once, unattended, on your machine, against your
repositories**, and lets them push branches and open pull requests.

That sentence is the threat model. Everything else is detail about how the blast radius is bounded.
Be clear-eyed: this is not a linter. It is a program that grants autonomous processes a credential
and a working copy, and its safety story is about **containment and visibility**, not about
preventing an agent from ever doing something you did not expect.

## 2. What it needs from you

| Asset | Why | Where it lives |
|---|---|---|
| A coding-agent CLI + its subscription | The agents *are* those CLIs | Your existing install |
| A GitHub App (the "company identity") | Agents commit and open PRs as it, never as you | `~/.ephesus/github-app.json`; key in the broker |
| One or more target repositories | The work | Wherever you cloned them |
| Optional voice/API keys | The Herald | Write-only secret broker |

**Ephesus does not need your personal GitHub credentials, and agents never receive them.** The
company identity is a separate GitHub App that **cannot merge** — a design constraint, not a
setting (ADR-0020, ADR-0022).

## 3. Trust boundaries

**Trusted:** you (the Architect); the harness's main process; the Agora's own files.

**Untrusted, and treated as such:**

- **The renderer.** Sandboxed, `contextIsolation: true`, `nodeIntegration: false`, CSP denies
  remote script, all external links open in your system browser. It renders agent-derived text and
  is assumed hostile (SDD §"Trust boundaries").
- **Everything an agent reads.** Repository content, CI and test output, issue and PR text, commit
  messages, API responses. Instructions found in any of it are reported, never obeyed
  (NFR-18, `prompts/agora/PROTOCOL.md`).
- **Watched sources** studied by the research subsystem — read-only, no credentials, and a planted
  instruction is a finding (NFR-17, ADR-0017).

**Semi-trusted, and this is the honest part:** the **agents themselves**. They are language models
following instructions. Ephesus bounds what they can reach; it does not verify their intent.

## 4. What an attacker controls

Assume an adversary can write anything into a repository you point Ephesus at — a PR from a
stranger, a compromised dependency's test output, a crafted issue title. From there they control:

1. **Text an agent will read** — the injection surface.
2. **Code CI will execute** — CI output is program output, and Ephesus reads it.
3. **Dependency contents**, if your project installs them during CI.

They do **not** control: your secret broker, the Agora's write path, which env vars an agent gets,
or whether the company identity can merge.

## 5. Controls, and what each one actually stops

| Control | Stops | Where |
|---|---|---|
| Secret broker, write-only | Secrets reaching agents, renderer, logs, telemetry | ADR-0010, NFR-8 |
| **Env allowlist** | A secret in *your* shell reaching an agent by accident. Only ~25 named variables pass (`PATH`, `HOME`, locale, Windows system roots); everything else is dropped by default | `engines/spawn-env.ts` |
| Per-hire env grants | An agent getting a credential its role never declared | Hire templates, least-privilege |
| GitHub App identity | Agent work being attributed to you; agents merging anything | ADR-0020/0022 |
| Short-lived tokens | A leaked token staying useful — installation tokens expire in an hour | ADR-0022 |
| Engine isolation | An agent inheriting your CLI's memory, plugins, hooks or MCP servers | ADR-0026 |
| Harness is sole hook author | An agent rewriting the event plane that observes it | ADR-0026 |
| Worktree isolation | Agents colliding, or touching the Agora's single working copy | ADR-0004, UC-01 2a |
| Workspace trust + junction guard | A symlink redirecting a checkout somewhere unapproved | ADR-0021/0025 |
| Human gates, deny-by-default | Irreversible actions taken alone | SDD §9, NFR-9 |
| Circuit breaker (4 signals) | Loops, repeated identical calls, hop-cap escalation, pathology | ADR-0011/0013/0023 |
| Wall-clock wake cap | A single turn running away (10 min, then interrupt) | ADR-0023 |
| Cost ledger | Spend being invisible — every token folded and reported | ADR-0011 |
| Untrusted-content rule | An agent obeying an instruction found in a repo or CI log | NFR-18 |
| Attribution suppression | Vendor identity and session URLs leaking into your commits | ADR-0028, FR-1.8 |

**Network egress from the harness is narrow**: `api.github.com`, `github.com`, `cli.github.com`.
The agent CLIs talk to their own providers — that is their business, not Ephesus's, and Ephesus
neither proxies nor inspects it.

## 6. Residual risks

These are real. None is hypothetical, and none is fully mitigated.

### 6.1 Prompt injection is mitigated, not solved

NFR-18 tells every agent that what it reads is data. That materially lowers the odds. **It is a
prompt rule, and prompt rules are probabilistic.** An agent that obeys a planted instruction has a
repository token and push access. If you point Ephesus at a repository where strangers can write —
public PRs, community issues — you are relying on the agent CLI's own classifier as the last line.

*If this matters to you:* do not grant `GH_TOKEN` to hires working on repositories that accept
untrusted contributions, or run those repositories with `manual` autonomy so a human sees each tool
call.

### 6.2 Autonomy level is the biggest dial you control

`autonomous` maps to the engine's `auto` permission mode: the CLI's own classifier decides, with no
human. `supervised` → `acceptEdits`. `manual` → `default` (you approve). Ephesus deliberately never
uses `bypassPermissions` — but `auto` is still "a model deciding what is safe".

### 6.3 Spend is bounded by your attention, not by default

As of ADR-0029, hires ship **unbudgeted**. Ceilings kept firing on ordinary work and stopping the
company, so the default changed. **Set `defaultDailyTokens` in `~/.ephesus/config.json` before you
walk away.** The breaker's other three signals and the wake cap still bound *behaviour*; nothing
bounds *cost* unless you set that dial.

### 6.4 An agent's own output is not verified

The company checks its work with tests and a second-opinion verifier, and it reports honestly in
practice. But a confident, wrong diagnosis reaches you as a confident, wrong PR. **Review what it
opens.** The company identity cannot merge, precisely so that this stays true.

### 6.5 Dependency surface

`npm audit` currently reports **2 high** (`electron@37` → `extract-zip`). Exposure is believed
dev-time only — `extract-zip` unpacks the Electron binary at install and does not ship — but the
fix is Electron 44, a major upgrade against a deliberate pin. ENGINEERING-STANDARDS §5 says
high/critical blocks *release*; this is tracked, not waived silently.

### 6.6 Nothing scans what agents write into *your* repositories

`check-attribution.cjs` scans Ephesus's own history. It structurally cannot see a target's commits
— which is how a vendor trailer reached a real PR on 2026-09-06 before ADR-0028 closed it. The
suppression is now in place; the *scan* covering targets is not built.

### 6.7 The harness is not hardened against a malicious agent

Every control above assumes an agent that is *mistaken or manipulated*, not one that is
deliberately adversarial and probing the harness. Ephesus is not a sandbox escape boundary. Agents
run as your user, with your filesystem.

## 7. Before you install

1. **Start with `manual` or `supervised` autonomy.** Move to `autonomous` on a repository you own,
   after you have watched a run.
2. **Set `defaultDailyTokens`.** See §6.3.
3. **Do not point it at a repository that accepts untrusted contributions** until you have read
   §6.1 and decided you accept it.
4. **Use a dedicated GitHub App** with the narrowest repository scope that works, never a personal
   access token.
5. **Review every PR.** The company cannot merge; keep it that way.
6. **Watch the first hour.** The Watch panel shows spend, gates and degradations live.

## 8. Reporting a vulnerability

There is no security contact configured for this project yet. Until there is, this document should
not be read as a claim that reports will be triaged.

---

*This model is honest about a young system. It has been run against real repositories, and the
failures found so far were in containment and visibility — not in the secret boundary. That is the
right order to find them in, but "not yet found" is not "not there".*
