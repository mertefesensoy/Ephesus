# site/

The Ephesus website — [ephesushq.com](https://ephesushq.com). **A separate
workspace by design.**

It has its own `package.json` and its own lockfile, and it is excluded from the
application's install, lint, typecheck and test. Nothing the app ships depends on
anything in here, so Astro is not a dependency of Ephesus — it is a dependency of
the site that describes Ephesus. That distinction is why this did not need a
decision memo under BUILD-PROMPT §3.10.

```bash
cd site
npm install
npm run dev      # http://localhost:4321
npm run build    # -> site/dist
npm run preview  # serve the built output
```

Static output. No server, no adapter, no runtime.

## Structure

```
src/
  layouts/Base.astro        header, footer, fonts, meta
  components/Mark.astro     the column mark, inline SVG
  styles/tokens.css         the palette and type scale
  pages/                    index · city · record · contribute · blog
  content/blog/*.md         posts, schema-validated in content.config.ts
public/img/                 screenshots, served as-is
```

## Design rules this site follows

Colour and type come from [`../docs/design/UI-DESIGN.md`](../docs/design/UI-DESIGN.md)
§2 and §3. `ink`, `terracotta`, `aegean`, `olive` and `gold` are that document's
values verbatim.

**One deliberate departure:** the neutral ground is a cooler marble (`#EDECE6`)
than the app's `#F4EDE0`. That and four other observations from building this site
are written up as a proposal in
[`../docs/design/PROPOSAL-ui-design-v3.md`](../docs/design/PROPOSAL-ui-design-v3.md).
The proposal is not accepted; the app is unchanged.

`Press Start 2P` is used **only** for identity moments — small uppercase eyebrows
and large numerals. It is not a body face and not a heading face here, for reasons
argued in §3 of that proposal.

## Deploying to Vercel

The site lives in a subdirectory, so the one setting that matters is the root:

1. Import the repository at [vercel.com/new](https://vercel.com/new)
2. **Set Root Directory to `site`** — without this the build will not find
   `package.json` and will fail
3. Framework preset: Astro. Build command and output directory come from
   `vercel.json` and need no changes
4. Add the domain `ephesushq.com` under the project's Domains tab, then point the
   registrar's nameservers or an ALIAS/CNAME record at Vercel as it instructs

Pushes to `main` deploy to production; pushes to any other branch get a preview
URL, which is useful for reviewing copy changes before they are live.

`vercel.json` sets `cleanUrls`, a one-year immutable cache on `/img/*`, and three
security headers (`nosniff`, `strict-origin-when-cross-origin`, `DENY` framing).

## Adding a post

Create `src/content/blog/<slug>.md` with this frontmatter — the schema in
`src/content.config.ts` enforces it, so a missing field fails the build rather
than rendering a broken card:

```yaml
---
title: 'Sentence case, no trailing period'
date: 2026-09-05
tag: 'method'          # method · defect · design · decision
reading: '5 min read'
summary: 'One or two sentences. Shown on the index and used as the meta description.'
---
```

The URL is the filename. Posts sort by `date`, newest first.

**The house rule for posts:** everything is grounded in this repository's own
records. If a post describes a defect, that defect was real, it was found on a
stated date, and the fix is in the tree. No invented anecdotes.
