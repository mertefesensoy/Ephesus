# ADR-0021 — The Architect's activation is the answer to the engine's trust prompt

**Status:** accepted · **Date:** 2026-09-01

## Context
Claude Code asks, once per working directory, whether a human trusts it there.
The prompt is a first-run gate: it appears **before any session begins**, its
highlighted default is `No, exit`, and the engine remembers the answer in its
own store (`~/.claude.json` → `projects[<cwd>].hasTrustDialogAccepted`).

Because it precedes the session, no engine hook can fire for it. Ephesus
therefore could not see it at all. On the live SRS §6.1 run against
`mertefesensoy/MUSAHIT` this was not a theoretical gap: all three Skeleton Crew
agents spawned into a fresh clone, parked on that screen, and died the moment
the wake nudge wrote to them — five separate runs, every time. The floor showed
them as spawned. `~/.claude/projects/` shows they never opened a session once.
Detection worked all evening; the action half never ran, and this is why.

Four facts were established by experiment rather than assumed, because the first
three attempts to reason about it from the outside were wrong:

1. the prompt is **per-workspace and once-only** — no `settings.local.json`
   content triggers it, and none re-triggers it after an answer;
2. the engine matches the project key on the path with **forward slashes**. A
   backslash key — the form Windows hands you, and the form this harness spawns
   with — sits in the file being ignored;
3. the content warnings ("this folder pre-approves 21 tool permissions") change
   the *text* and not the trigger. They were, however, our own doing: three
   agents sharing one working directory each appended their hooks to the same
   file, so the folder appeared to be arming itself;
4. the prompt is answerable over the PTY, and the engine then remembers.

Fact 4 is the dangerous one, and the reason this is an ADR. Two standing
verdicts (DECISIONS-LOG, M4 close) pinned codex and gemini at `pty-heuristic`
fidelity rather than pass `--dangerously-bypass-hook-trust` or `--skip-trust`,
on the grounds that *"the harness lowering a trust default on the Architect's
behalf is what the Watch exists to prevent."* Typing the answer is that same
act by a mechanism with **less** of a trace: a bypass flag at least appears in
argv and on the agent card, and a synthesised keystroke appears in neither.

## Decision
**Ephesus records the Architect's approval in the engine's own trust store at
activation time, and never answers the prompt at run time.**

- **The activation is the consent.** `trustWorkspace(cwd)` is called from a
  profile activation the Architect performed, with that activation's own
  target, and from nowhere else. It is never called from spawn, respawn, or a
  wake. The click that hires a crew for a directory is the same click that says
  the directory is theirs to work in.
- **It is an adapter capability, not a core one** (NFR-12). `trustWorkspace` is
  optional on `EngineAdapter`. Only the Claude adapter implements it, because
  only Claude Code keeps a per-workspace record that a human decision can be
  written into. **Codex and gemini do not get it**, and the M4 verdicts stand
  for them unchanged: their only route past their own prompt is a bypass flag,
  which is a different thing from a record of a decision.
- **Nothing is answered at run time.** No PTY detector, no synthesised
  keystroke, no auto-answer. The engine's own memory means the record written
  at activation is consulted once and the prompt never appears.
- **The write is narrow and canonical.** One key, one field. The path is
  resolved through `realpath` first, so the record names the directory that was
  actually approved rather than a junction that can be repointed at another one
  afterwards. An unreadable `~/.claude.json` is a refusal, never a repair — it
  is the engine's file and rewriting it from a guess would cost the Architect
  every project setting in it.
- **It is never silent.** Every call appends a `profile / workspace-trusted`
  event carrying the engine, the target, the canonical path, and whether the
  grant was newly made or already held. A failure is additionally a visible
  degradation.

## Options considered
- **Show it, never answer it.** Ephesus detects the parked agent and marks it
  blocked; the Architect answers in the agent's own terminal pane, once per
  repository. Conflicts with no prior verdict and needs no ADR. **Rejected by
  the Architect (2026-09-01)** as friction they do not want on every new
  target; recorded here because it remains the most conservative option and the
  one to return to if this decision proves wrong.
- **A `workspace-trust` gate the Architect approves, after which Ephesus types
  the keystroke.** Keeps a human in the loop per workspace but puts keystroke
  synthesis into a code path a repository can influence: a repo that prints the
  dialog's text mid-session could aim a confirmation at a real permission
  prompt. Rejected on that ground, and because it needs an eighth gate kind to
  express something the activation already expresses.
- **Pre-trust at spawn rather than activation.** Simpler to wire, and wrong: it
  would trust a directory on every respawn and wake, long after the Architect
  had left, and would cover cwds no activation ever named.

## Consequences
- The two M4 verdicts are **narrowed, not overturned.** The rule they defend —
  the harness does not lower an engine's trust default on its own initiative —
  survives, because this writes a decision the Architect made rather than a
  default the harness chose. It is nonetheless a real relaxation for the
  reference engine, and it is written down here rather than left implicit.
- A malicious target repository benefits from one specific thing: the engine's
  trust prompt is the only component that reviews a repo-committed
  `.claude/settings.json`, and it will no longer be shown. Ephesus reads
  `settings.local.json` and merges into it, but reads the committed
  `settings.json` never. **This is an accepted, unmitigated exposure of this
  decision**, and the natural next work is for the activation preview to show
  what a target's committed settings would grant, so the Architect approves
  content rather than only a path.
- Trust is keyed by directory while the risk lives in content, so a `git pull`
  that adds a `.claude/settings.json` after approval is not re-reviewed.
- The Architect's standing duties gain nothing. There is no new file to
  maintain: the record lives in the engine's own store, so there is no second
  copy to drift out of agreement with it.
- A Claude Code process running elsewhere may rewrite `~/.claude.json` from its
  own in-memory copy and drop the key. The failure is visible rather than
  dangerous — the prompt returns and the agent parks — and cannot be closed
  from this side.

## Prior art
ADR-0009 (adapters own every engine-specific fact; the reference engine is the
only one that may gate a release); DECISIONS-LOG M4 close (the codex/gemini
trust verdicts this narrows); ADR-0013 (autonomy is opt-in per profile — the
same shape: a standing decision the Architect makes once, applied by the
harness thereafter); FR-10.4 (import pre-fills, a human always confirms).
