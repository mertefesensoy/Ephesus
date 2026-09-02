# Dependency updates

A scheduled sweep to keep dependencies current without turning the review queue
into noise.

## 1. Survey

List what is outdated, with the current version, the available version, and the
kind of bump (patch, minor, major). Check the security advisories too — a patch
that closes a known vulnerability is not the same errand as a routine bump, and
it should not wait in the same batch.

## 2. Batch

Group related updates into one pull request. The batching rule is *what a
reviewer can judge in one sitting*:

- all patch-level bumps together — usually one PR
- minor bumps grouped by area (test tooling, build tooling, runtime deps)
- **every major bump on its own** — a major is a behavioural change wearing a
  version number
- **every security fix on its own, first** — it should be mergeable without
  waiting on anything else in the queue

Thirty single-package pull requests get rubber-stamped or ignored. One
seventy-package pull request gets ignored. Neither is review.

## 3. Verify — before proposing, not after

For each batch:

- install the updates
- run the full test suite
- run the build
- read the changelogs for anything that changed behaviour, not just version
  numbers

If the tests fail, do not open the pull request. Narrow it down to the offending
package, drop that one from the batch, and note it separately as needing real
work.

**Do not report tests you did not run.** This is the one failure here that a
follow-up commit cannot repair, because it spends the reviewer's trust in every
future batch you send.

## 4. Gates

- **Adding a new dependency requires a decision memo.** This profile's memo
  policy holds `new-dependency`, so the action is held until there is a verdict.
  Write the memo with real options — including "do not add it" — and wait.
- **Opening the pull request is not gated.** Push your own `agent/*` branch and
  open it. What is gated is what the batch CONTAINS — a new dependency still
  waits for its memo verdict, so open the PR for the upgrades that are clear and
  leave the held one out of the batch rather than holding the whole PR for it.
- A major bump that changes a public API is also an `api-or-schema-change`.
  A bump that changes how credentials or permissions are handled is a
  `security-posture` change. Both are held for a memo.

## 5. Report

Say what you updated, what you deliberately left alone and why, and what failed.

"Left alone" is as valuable as "updated". A package you skipped because its major
bump needs a migration is information the Architect needs; a batch that quietly
omits it looks like the work is finished when it is not.
