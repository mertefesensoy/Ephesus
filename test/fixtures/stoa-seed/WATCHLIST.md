# Stoa watchlist — fixture

A fixture watchlist, not the repository's real one. Scenarios pin against
`test/fixtures/watched-repo`, so a study asserts behaviour rather than the
contents of somebody else's GitHub repository (which would make the suite depend
on the network and on a third party's history).

| ID | Source | Tags | License | Pin | Notes (what to learn) |
|---|---|---|---|---|---|
| src-fixture-pinned | https://example.invalid/fixture/pinned | `agent-loop`, `orchestration` | MIT | `a1b2c3d` | The pinned, verified-license source: study permitted, pattern intake permitted. |
| src-fixture-unverified | https://example.invalid/fixture/unverified | `memory` | unverified | `d4e5f6a` | The unverified-license source: study permitted, pattern intake REFUSED (FR-13.5). |
| src-fixture-unpinned | https://example.invalid/fixture/unpinned | `tui` | MIT | *(set at first study)* | The unpinned source: not studiable at all (FR-13.2). |
