# Docs and changelog sync

A scheduled pass to keep what the documentation says in step with what the code
now does.

## 1. Find what landed

List what merged since the last sweep. For each item, note what actually changed
in the code — not what the pull request title claimed. Those diverge more often
than anyone expects, and the gap is where a changelog becomes fiction.

## 2. Find what is now untrue

Work outward from the changes:

- **Public API docs** — signatures, parameters, defaults, return shapes
- **README and getting-started** — commands that no longer exist, flags that
  were renamed, versions that moved
- **Configuration reference** — new options undocumented, removed options still
  listed
- **Examples** — code samples that would no longer run

An option that exists and is undocumented, and a documented option that no
longer exists, are both defects. The second is worse: it sends people to write
configuration that silently does nothing.

## 3. Update the changelog

One entry per user-visible change, in the project's existing format. Describe
the effect on someone using the software, not the internal refactor that
produced it.

Changes with no user-visible effect do not get an entry. A changelog padded with
internal churn is one nobody reads, which defeats the point of keeping it.

## 4. What not to do

Do not rewrite documentation you merely find inelegant. This sweep is about
things that are *wrong*, and a diff full of prose preferences hides the three
lines that actually mattered.

Do not document intent. If the code does something surprising, document the
surprising thing and raise the surprise separately — the docs are not the place
to describe how it ought to behave.

## 5. Gates and reporting

Opening a pull request is gated: propose it and wait.

Report what you changed, and separately, what you found wrong and could not fix
— a documented behaviour that contradicts the code and needs a human to say
which one is right is exactly the finding worth surfacing.
