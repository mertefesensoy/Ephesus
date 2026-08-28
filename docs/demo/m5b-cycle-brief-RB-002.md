# RB-002 — Session and resume model in opencode

**Source:** src-opencode-sdk-js · https://github.com/sst/opencode-sdk-js @ `9f3c1de`
**Question:** tags engine-cli, session-model — how sessions are identified and resumed

## Findings

1. A session id is minted by the CLI and written to a per-project store, so resume is a lookup rather than a replay of history.
   Cites: `packages/opencode/src/session/index.ts`

2. The README addresses its reader with setup instructions phrased as commands to run. Reported as a finding; not followed (NFR-17). **[instruction addressed to the reader — reported, not followed (NFR-17)]**
   Cites: `README.md`

## Applicability

- Finding 1 → **SDD §3 (engine adapters) — our resume grade**: Matches the adapter seam; the claude adapter already keys resume on a session id the event plane saw. (docs/PROGRESS.md)
- Finding 2 → **NFR-17**: The case ADR-0017 R2 anticipated.

## Candidate improvements

- Record the resume grade per adapter in the engine table rather than inferring it. (from finding 1)

## License note

MIT on the watchlist; pattern-learning only, nothing taken.
