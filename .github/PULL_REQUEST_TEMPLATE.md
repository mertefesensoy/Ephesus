# What this changes

<!-- One paragraph. Describe the behavior that is different now, not the files you touched. -->

Closes #

## Why

<!-- What problem does this solve? If a document required it, link the section. -->

## Evidence

<!--
  REQUIRED. A claim without evidence is not done here.
  Paste terminal output, attach a screenshot, or show the failing-then-passing test.
  "Tests pass" is not evidence; the output is.
-->

```
```

## The production call path

<!--
  A wiring seam with no test is a defect, not a gap. Name the file and line where
  this code is actually reached from an application entry point — or state plainly
  that there is none yet, and why that is acceptable.
-->

## Definition of Done

See [`docs/ENGINEERING-STANDARDS.md`](../docs/ENGINEERING-STANDARDS.md) §6.

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes with zero warnings
- [ ] `npm test` passes
- [ ] New behavior has tests at the right level; any fixed bug has a regression test
- [ ] Evidence is attached above
- [ ] Docs updated in this PR — SDD if design changed, README if the surface changed,
      a new ADR if policy demanded one
- [ ] Degradation paths are implemented and visible in the UI, never silent
- [ ] No new lint-boundary violations, no schema without a version, no hex literals in
      components
- [ ] The seam is tested, or its absence is recorded above

## Invariants

I have checked this diff against [`BUILD-PROMPT.md`](../BUILD-PROMPT.md) §3:

- [ ] Strict TypeScript; no `any` outside a validated boundary
- [ ] The renderer touches no Node API and no filesystem
- [ ] Atomic writes (temp + rename) for anything another process reads
- [ ] Only the main process runs git in the Agora
- [ ] Append-only files stay append-only
- [ ] No secret value is returned over IPC, logged, or committed
- [ ] Every degradation is visible in the UI
- [ ] No LLM-facing prose added as a string literal in code (it belongs in `prompts/`)
- [ ] No new dependency — or a decision memo exists and is linked here
- [ ] UI values come only from the design tokens
- [ ] No agent, session, or model name anywhere in this diff or its commit messages

## Anything the reviewer should push back on

<!--
  Optional but valued. What did you feel unsure about? What did you not test?
  Naming your own weak spot is treated as a strength here, not an admission.
-->
