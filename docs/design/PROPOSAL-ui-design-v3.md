# Proposal — UI-DESIGN v3

**Status:** proposed · not canonical · **Date:** 2026-09-05
**Supersedes:** nothing. `docs/design/UI-DESIGN.md` remains the only canonical
design document until and unless the Architect accepts some or all of this.

This document exists because building the project website surfaced a small number
of decisions that appear to be improvements to the *application's* design system,
not merely choices for a web page. It proposes five changes. They are independent
— accepting one does not commit you to any other — and each is marked with how
well it is actually supported.

---

## 0. Evidence grading, stated first

This project's own rule is that a claim without evidence is not done, so every
proposal below carries one of three grades. Read the grade before the argument.

| Grade | Means |
|---|---|
| **Measured** | Counted or verified mechanically. Reproducible from the repository. |
| **Observed** | Seen in a small number of real screenshots. True of what I looked at; may not generalise. |
| **Asserted** | Design judgement with no measurement behind it. Treat as opinion. |

I want to be explicit about the weakest link: the observations in §4 come from
**four screenshots in `docs/demo/`, dated between 28 August and 1 September.** That
is a thin and possibly stale sample, and none of it was gathered by running the
current build. If §4 matters to you, the honest next step is to look at the app
rather than to trust this document.

---

## 1. What v3 does *not* change

Stated before the proposals, because the scope of what stays fixed is the reason
this is an extension rather than a rewrite.

- **Every hue in §2.2, §2.3 and §2.4 is untouched.** `ink-900` `#221A14`,
  `ink-700` `#4A3B2C`, `ink-500` `#7A6A55`, `ink-300` `#B3A68E`, `terracotta`
  `#C4552D`, `aegean` `#2E6F8E`, `olive` `#7A8B3D`, `gold` `#D9A441`, `laurel`,
  `wine`, and all ten status colours stay exactly as specified.
- **`terracotta` remains reserved for Artemis.** Nothing here spends it elsewhere.
- **Pixel-snapping, hard 2px offset shadows, no blur, no soft shadows, no
  half-pixels** (§1.1) — unchanged and not up for discussion.
- **The ≤5 colours per sprite rule** (§1.3) for floor sprites at 32×48 —
  unchanged. The site's ≤8 figure applies to a brand mark, which is not a sprite.
- **The floor's scene grammar** (§5) — untouched.

**Measured:** the website kept 7 of the app's tokens verbatim and introduced 11
new values. Of those 11, **8 are web-only** — a `soil` range and a gold leaf from
a monograph direction that was explored and rejected. They are not proposed here
and should not enter the app. Only the paper range is carried forward, in §2.

---

## 2. Cooler neutral ground

> `marble-100` `#F4EDE0` → `#EDECE6`, with `marble-50`, `-200`, `-300` shifted to
> match. **Grade: asserted.**

**The argument.** At small areas — a badge, a row stripe — the warm cream is
pleasant. Across a full-bleed application surface it accumulates, and terracotta
placed on it reads as *more of the same warm family* rather than as an accent.
Cooling the ground by roughly a tenth in the yellow channel makes terracotta,
gold and olive separate from it more sharply, at no cost to any of them.

**The counter-argument, which is strong.** §1's stated thesis is "a sun-lit Ionian
city… warm marble, terracotta, Aegean blue, olive groves." Cooling the ground
works directly against the adjective the whole aesthetic is built on. It is
entirely reasonable to reject this on those grounds alone.

**This is the change I am least confident in**, and it is the one with the widest
blast radius — every surface in the application changes. If only one item here is
rejected, it should probably be this one.

**Cost:** four token values. No component changes.

---

## 3. Press Start 2P stops being a title face

> §3 assigns Press Start 2P to "Display / panel titles" at 8 / 12 / 16 px.
> Proposal: it becomes an **identity-only** face — wordmark, section eyebrows,
> and large numerals — and panel titles move to Pixelify Sans 600, uppercase,
> with `.12em` tracking. **Grade: observed, with a measured component.**

**Measured.** Building five site pages, Press Start 2P earned a place in exactly
three roles: 8–9px eyebrow labels, the wordmark, and 20–22px numeric figures. Every
attempt to use it for anything a reader must *scan* rather than *notice* was
reverted during the build.

**The mechanism.** Press Start 2P has no lowercase, a uniform stroke weight and a
very wide advance. Those properties are exactly what make it excellent as an
identity mark and poor as a label: word shapes collapse toward a uniform
rectangle, so scanning a column of panel titles becomes reading rather than
recognising. The cost scales with how many titles are on screen at once — which,
in a Command Center with a tab strip and stacked panels, is many.

**Observed.** In `m5b-floor-limezu.png` the tab strip carries eleven titles in the
display face simultaneously. In `m5-odeon-meeting.png`, the ODEON panel title and
the TERMINAL panel title are near-identical silhouettes at a glance.

**Why this is a usability change and not a taste change.** The pixel identity is
preserved — arguably strengthened, because a face used in three deliberate places
reads as a decision, while a face used everywhere reads as a constraint.

**Cost:** one line in §3, plus the panel title-tab rule in §4. Both faces are
already bundled; nothing new is installed.

---

## 4. A prose face for Odeon artifacts

> §3 assigns "Data, terminals, logs, **Odeon artifacts**" to IBM Plex Mono.
> Proposal: split that. Data, terminals, logs and evidence keep Plex Mono. Odeon
> artifacts — briefs, memos, minutes, decks — get **IBM Plex Sans**.
> **Grade: asserted, with an observed prompt.**

**The argument.** The Odeon renders genuine multi-paragraph prose: a decision memo
with context and blast radius, a briefing, meeting minutes. Monospace is superb
for anything where character position carries meaning — a diff, a path, a hash, a
log line — and is a poor choice for sustained reading, because uniform advance
removes the word-shape cues readers rely on.

The current spec bundles Odeon artifacts with logs and terminals, which reads like
a grouping made by *where the text comes from* rather than by *how it is read*.

**Observed.** `m5b-stoa-brief.png` shows a full research brief set in mono. It is
legible. It is not comfortable, and briefs are the artifact the Architect is
expected to read most carefully.

**This one adds a dependency.** `@fontsource/ibm-plex-sans` is a new package, and
BUILD-PROMPT §3.10 requires a decision memo for any new dependency. That memo is
not written and this proposal does not substitute for it. It is the same vendor
and the same family as a package already installed, which is an argument, not an
exemption.

**Cost:** one new font package, one line in §3, and a rule about which Odeon
surfaces are prose and which are evidence.

---

## 5. Empty and degraded states get a specified anatomy

> §3's invariant is that **every degradation is visible**. Proposal: add that a
> visible degradation must also name **what happened, why, and the one control
> that resolves it**. **Grade: observed.**

This is the item with the most usability value and the least to do with tokens.

**Observed, in the demo screenshots:**

- `m5b-floor-limezu.png` — an agent panel reading `exited (1)` above a terminal
  showing *"The command line is too long."* The failure is visible. What to do
  about it is not, and no control sits next to it.
- The same capture's status strip reads `agora: 2 issues`. Visible. Not
  actionable, and not obviously clickable.
- `m5-odeon-meeting.png` — a large panel occupied entirely by `no agent selected`.
  An empty state that explains nothing and offers nothing.

**The gap in the rule.** "Visible" is satisfied by printing the condition. That is
a meaningfully lower bar than "the operator knows what to do next", and this
codebase has a documented habit of noticing exactly this class of difference —
a check that technically passes while doing nothing useful.

**Proposed anatomy** for every empty or degraded surface:

1. **What** — the condition, in the operator's vocabulary, not the system's.
2. **Why** — the cause, where known; explicitly "cause unknown" where not.
3. **The one thing to do** — a single control, or a copyable command, or an
   explicit statement that no action is available and it will clear on its own.

`needs-login` already does this well, and is worth reading as the reference
implementation: it names the state and prints the exact command to run.

**Cost:** a new §4 subsection, and a pass over each panel's empty state. This is
the largest implementation cost in the proposal and, I would argue, the largest
return.

---

## 6. Status strip: label above value

> Proposal: status strip entries become a small uppercase mono label above the
> value, in bordered cells, rather than a single run of `key: value · key: value`.
> **Grade: observed.**

**Observed.** The current strip reads
`bridge: ready · config schema v1 · events: live · fonts: bundled · gates: none open · agora: 2 issues · mode: directed`
as one continuous line of same-weight mono. Finding one field means reading the
whole line, and the warning (`agora: 2 issues`) has the same visual weight as the
routine (`fonts: bundled`).

**Proposal:** each field is a cell with a `9.5px` uppercase label above a `12px`
value; the cell carries the status colour on its label when the field is not
nominal. The site build uses exactly this pattern and it survived several passes.

**Cost:** one component. No token changes. **Portable to a pixel grid** — the
pattern is rectangles and text, with nothing that needs anti-aliasing.

---

## 7. If you want to evaluate this cheaply

Do not adopt this document. Test the two cheapest items and let the result decide:

1. Apply **§3** (title face) to one panel behind a flag. Capture the same view
   before and after. It is a one-line change and reverts cleanly.
2. Apply **§6** (status strip) to the real strip. Same before-and-after.

Both are reversible in a single commit and neither touches a colour token. If
they land well, §2 and §4 are worth arguing about. If they do not, §5 still
stands on its own — it is about behaviour rather than appearance and is
independent of every other item here.

---

## 8. Open questions for the Architect

1. **§2 is the risky one.** Does cooling the ground fight "sun-lit" fatally, or is
   the thesis about light and warmth of *hue* rather than of the neutral?
2. **§4 needs a dependency memo** before it can proceed. Worth writing, or should
   Odeon prose stay in mono?
3. **Does §5 belong here at all?** It is a behavioural rule, not a design token.
   It may deserve to be an ADR against `ENGINEERING-STANDARDS` rather than a
   change to `UI-DESIGN`.
4. **Is the screenshot evidence good enough?** Four captures, up to eight days
   old. I would not accept this standard of evidence from a research brief, and
   you should not accept it here without checking the live app.

---

## Related

- [`docs/design/UI-DESIGN.md`](./UI-DESIGN.md) — canonical, unchanged by this document
- [`docs/ENGINEERING-STANDARDS.md`](../ENGINEERING-STANDARDS.md) — §6, definition of done
- [`BUILD-PROMPT.md`](../../BUILD-PROMPT.md) — §3.10 on new dependencies, §3.12 on tokens
- `site/src/styles/tokens.css` — where these values are already in use on the web
