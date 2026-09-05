# Security Policy

## Supported versions

Ephesus is **pre-alpha**. There are no releases and no supported versions yet — the
only thing that exists is the `main` branch. Security reports are still very welcome
and will be taken seriously.

| Version | Supported |
|---|---|
| `main` | Yes — report anything you find |
| Any release | None exist yet |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through
[GitHub's private vulnerability reporting](https://github.com/mertefesensoy/Ephesus/security/advisories/new),
or by email to **sensoymertefe@gmail.com** with `SECURITY` in the subject.

Please include what you found, how to reproduce it, and what you think the impact is.
A proof of concept helps enormously.

You can expect an acknowledgement within a few days. Since this is a solo-maintained
pre-alpha project, please be patient with fix timelines — but you will get a real
answer, not silence.

## What is in scope

Ephesus runs real terminal agent CLIs as child processes on your machine, holds
credentials for them, and writes to a coordination directory on disk. The interesting
attack surface follows from that:

- **Renderer escape** — anything that gets Node or filesystem access into the renderer
  process, or defeats `contextIsolation` / `sandbox`.
- **IPC validation gaps** — a typed IPC handler in the main process that accepts input
  it should have rejected.
- **Secret leakage** — a secret value reachable over IPC, written into logs, fixtures,
  the Agora, or an agent's transcript. Secrets are supposed to be write-only and reach
  agents only as declared environment variables.
- **Prompt injection through watched sources.** The Stoa reads external repositories
  the user registers. That content is data, never instructions. A path where text from
  a watched source reaches code, prompts, or config without passing through a gated,
  human-approved proposal is a vulnerability, not a bug.
- **Agent boundary escape** — an agent writing outside its own
  `agora/agents/<id>/` directory, or committing to the Agora directly.
- **Gate bypass** — anything that lets work proceed past a human approval gate, a
  budget, or the circuit breaker without the human.

## What is out of scope

- Vulnerabilities in the third-party agent CLIs themselves (`claude`, `codex`,
  `gemini`, …) — report those to their vendors.
- Anything requiring an attacker who already has local code execution as your user.
  Ephesus is a desktop app that deliberately runs commands on your behalf; an attacker
  at that level has already won.
- The absence of signing on builds. There are no builds yet; signed packaging is a
  planned milestone.

## Disclosure

Please give a reasonable window to ship a fix before publishing. Credit will be given
in the advisory unless you would rather stay anonymous.
