---
title: 'Why the crew works in its own checkout'
date: 2026-09-04
tag: 'design'
reading: '5 min read'
summary: 'Running several agents in the architect’s working tree is fine until it isn’t. The fix was a worktree each — and the interesting part was what that broke.'
---

For most of the build, every agent worked in the same place: the repository you had open. It is the obvious first implementation, it demonstrates well, and it is wrong in a way that only shows up once more than one agent is doing real work.

Two agents editing the same tree collide. One rebases while another has files open. A test run reads a half-written file. And underneath all of it, the architect — you — is also editing that tree, which means the company can destroy your uncommitted work while you are looking at it.

## A worktree each

Git worktrees are the right primitive. One repository, several checked-out working directories, each on its own branch, sharing one object store. An agent gets a directory that is genuinely its own: it can edit, build, run tests, and switch branches without touching anyone else.

That is the easy half.

## What it broke

**Trust.** The agent CLI maintains a notion of which directories it is allowed to operate in. A freshly created worktree is a path that has never been seen before, so the engine treated every activation as untrusted and stalled waiting for a confirmation nobody was there to give. Workspace trust had to be extended to cover the worktrees an activation creates — which needed a decision record, because widening what the harness trusts is not a detail.

**Engine installs.** Agents sharing one engine installation share its state: settings, session files, caches. One agent's configuration change became every agent's. Each hire now runs its own engine install, which is more disk and considerably less mystery.

**Cleanup.** A worktree that outlives its agent is a directory full of someone else's branch. Removing one is also where an unglamorous platform detail lives: on this machine the repository sits in a synced folder, and the sync client holds read-only handles that make `git worktree remove` fail intermittently. That is recorded rather than fixed, because a recorded platform quirk is a known condition and an unrecorded one is a recurring mystery.

**Shutdown ordering.** With several worktrees live, quitting means unwinding them in an order. The respawn ladders — the machinery that brings a dead agent back — had to be disarmed *before* the unwind rather than after, or the shutdown helpfully resurrected the thing it was shutting down.

## The pattern underneath

Every one of those is the same shape: **a piece of state that was implicitly shared, becoming explicit when it stopped being shared.**

The trust list was implicitly one directory. The engine install was implicitly one instance. Cleanup was implicitly unnecessary. Shutdown ordering was implicitly trivial, because there was only one of everything.

Isolation does not create these problems. It reveals them. They were all present in the single-tree design as latent assumptions, and they would have surfaced eventually in far more confusing circumstances — as an agent mysteriously inheriting another's settings, or an architect losing an afternoon's uncommitted work.

## What it is worth

The concrete gain is that you can leave the company running and still use your own computer. That was the milestone's whole purpose: a company you can leave running is one that is not competing with you for the filesystem.

The less concrete gain is that four implicit assumptions are now four explicit mechanisms, each with a test at the seam. That is the trade isolation usually offers — you pay in machinery and are repaid in things that can no longer silently go wrong.

---

*Worktree isolation landed in M8.6 and the trust decision is ADR-0025. The record is in [`docs/implementations/`](https://github.com/mertefesensoy/Ephesus/tree/main/docs/implementations).*
