# Google had no favicon to show

## Problem / motivation

The search result for `ephesushq.com` renders the generic globe placeholder
instead of the Ephesus mark. The question put was whether the favicon had been
implemented at all, or whether something else was wrong.

It had been implemented — for browsers. Measured against production before any
change in this session:

| path | status |
|---|---|
| `/favicon.svg` | 200 · `image/svg+xml` · 1459 B |
| `/favicon-32.png` | 200 · `image/png` · 221 B |
| `/favicon-16.png` | 200 · `image/png` · 170 B |
| `/apple-touch-icon.png` | 200 · `image/png` · 802 B |
| `/site.webmanifest` | 200 · `application/manifest+json` |
| **`/favicon.ico`** | **404** |

The `<link rel="icon">` tags were present in the live home page `<head>`,
`robots.txt` allows every user agent, and a request carrying a Google favicon
user agent got 200 on both the home page and the SVG. Nothing was blocked and
nothing was misconfigured for a browser.

Google, however, held nothing at all. Its favicon cache was probed against two
controls — a site whose favicon Google certainly has, and a domain that does not
exist:

```text
ephesushq.com                          726B  md5=b8a0bf372c76
github.com                             519B  md5=81addaa40650
totally-nonexistent-domain-xyz123.com  726B  md5=b8a0bf372c76
```

`ephesushq.com` is **byte-identical to a domain that does not exist**. That is
the placeholder, so this is not a rendering quirk in one search result: Google
has no icon on file for the host. The control proves the probe can tell the two
apart.

## Why: the rules the head was not written against

Read from Google's own favicon documentation rather than from memory:

- Supported formats are **BMP, GIF, ICO, PNG, JPEG, PPM and TIFF**. SVG is not
  among them.
- The icon must be square and at least 8×8; **larger than 48×48 is recommended**.
- Google reads the `<link>` on the **home page**. It does **not** read the web
  app manifest for this purpose.
- Crawling "can take anywhere from several days to several weeks".

Against those four rules the head had three weaknesses:

1. It **led with `/favicon.svg`** — the one declared format Google does not take.
2. The only rasters it declared were **16×16 and 32×32** — legal, but under the
   recommended size.
3. The large icons that do exist, `icon-192.png` and `icon-512.png`, were
   referenced **only from `site.webmanifest`**, which Google does not read. They
   were invisible to it.

And there was no `/favicon.ico`, so the universal fallback every other crawler
probes was a 404.

## What this change does not claim

**Two causes are stacked here and this change does not separate them.**

`site/` was first committed on 2026-09-05, one day before this work. Google's own
documentation says days to weeks, so a host this new having no favicon on file is
the expected state rather than evidence of a defect. Working against that: the
page is already indexed — the search result carries the real title and meta
description — so Googlebot has certainly visited. The favicon is fetched by a
separate crawl on its own schedule, so an indexed page with no favicon is still
consistent with "not yet fetched".

So this change is **not proven to be the thing that makes the icon appear**. What
it does is make sure that when the favicon crawl arrives, it finds an icon in a
format Google accepts, at a size it prefers, declared where it looks. If the icon
appears after the next crawl, that is consistent with this fix and also
consistent with simply having waited. The honest statement of the gap it closes
is the counterfactual: left alone, the crawler would have had only an unsupported
SVG, two undersized PNGs and a 404 to work with.

## What changed

| File | Change |
|---|---|
| `site/public/favicon.ico` | New. A three-frame icon (16, 32, 48) built from the committed PNG artwork; retires the 404. |
| `site/src/layouts/Base.astro` | `/favicon.ico` and `/icon-192.png` are declared first, ahead of the SVG, so a crawler taking the first supported format finds one. A comment records why the order is what it is. |

`site/dist/` is git-ignored, so the build output is not part of the diff.

## Implementation approach

### The .ico carries three renderings, not one image resized

The obvious way to build the file is to take one source and let the encoder
resize it. That would have been wrong here, because **the mark is drawn
differently at different sizes**. Downscaling `icon-192.png` to 32 and comparing
it to the shipped `favicon-32.png`:

```text
icon-192 downscaled to 32 vs favicon-32: 882/1024 pixels differ
favicon-32.png   centre pixel = (211,196,165)   <- light column shaft
icon-192.png     centre pixel = (74,59,44)      <- dark keyline
```

They are the same mark, but the 16px is chunky pixel art, the 32px carries more
detail, and the 192/512 pair has fluted columns and small dark squares in the
entablature. The centre pixel lands on a different feature in each family. Ship
one resized source and two of the three frames are the wrong rendering.

So each frame is taken from the family it belongs to:

| frame | source | how |
|---|---|---|
| 16×16 | `favicon-16.png` | as-is |
| 32×32 | `favicon-32.png` | as-is |
| 48×48 | `icon-192.png` | exact 4× decimation, LANCZOS |

48 is sourced from the 192 family rather than the 32 one for two reasons: 48 sits
in the detailed size range where the fluted rendering is legible, and 192 ÷ 48 is
exactly 4, so the decimation lands on integer pixel boundaries.

### Ordering, and why the redundant links stay

`.ico` and the 192px PNG lead. Browsers are unaffected by that: they select a
favicon on the `type` attribute, not on document order, so an SVG-capable browser
still takes `/favicon.svg`.

The `favicon-32.png` and `favicon-16.png` links are now redundant — they are
byte-identical to two of the three `.ico` frames, verified below. They are kept
anyway. Removing them would orphan two committed files for no gain, and keeping
them preserves the exact current browser behaviour, which is the conservative
choice on a change whose real target is a crawler.

## Design decisions

**The `.ico` is a committed asset, not a build step.** No icon-generation script
exists in `site/` — every other icon is a committed binary. Adding an icon
pipeline to the Astro build would be a larger change than the problem justifies
and would introduce a build-time dependency. The generation command is recorded
under Verification so the file can be rebuilt from the artwork on demand.

**No new dependency.** `npm run check` (`astro check`) offers to install
`@astrojs/check` and `typescript`. It was declined — new dependencies need a
decision memo. `npm run build` is green and is the gate used here.

**Nothing was deleted.** The 16 and 32 PNGs, the SVG and the manifest entries all
stay as they are. The change is additive.

**The manifest was left alone.** Adding icons there would not help, because
Google does not read it for search-result favicons. Its icons are already correct
for their actual purpose, which is installability.

## Verification

Rebuild the icon from the committed artwork:

```bash
cd site/public && python -c "from PIL import Image; f16=Image.open('favicon-16.png').convert('RGBA'); f32=Image.open('favicon-32.png').convert('RGBA'); f48=Image.open('icon-192.png').convert('RGBA').resize((48,48), Image.LANCZOS); f48.save('favicon.ico', format='ICO', sizes=[(48,48),(32,32),(16,16)], append_images=[f32,f16])"
```

Build the site:

```bash
cd site && npm run build
```

### The frames are the intended artwork, and the check can fail

Each frame was read back out of the encoded file and compared to the source it
was supposed to come from:

```text
declared sizes: [(16, 16), (32, 32), (48, 48)]
  16x16 frame vs favicon-16.png   -> 0 px differ  MATCH
  32x32 frame vs favicon-32.png   -> 0 px differ  MATCH
  48x48 frame vs icon-192@48      -> 0 px differ  MATCH
  control: 48 frame vs 16px-upscaled -> 2148 px differ (must be >0)
```

The last line is the point. A comparison that only ever reports MATCH proves
nothing about the comparison, so the 48px frame was also compared against what it
would have been had the lazy path been taken — one source upscaled from the 16px
art. That differs by 2148 pixels, so the check distinguishes the two cases, which
is what makes the three MATCH lines above load-bearing.

### The 404 is gone, in the built output

`dist/` was served over HTTP and probed the same way production was:

| path | before (production) | after (built output) |
|---|---|---|
| `/favicon.ico` | **404** · `text/html` | **200** · `image/x-icon` · 2295 B |
| `/icon-192.png` | 200, undeclared in head | 200, declared in head |

The served bytes were compared against `site/public/favicon.ico` and are
identical, so nothing in the build rewrites the file.

The built `<head>` on the home page, and on a blog page, carries the links in the
intended order:

```html
<link rel="icon" href="/favicon.ico" sizes="48x48 32x32 16x16">
<link rel="icon" href="/icon-192.png" sizes="192x192" type="image/png">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/site.webmanifest">
```

### What has not been verified, and cannot be here

**This has not been verified against production**, because it is not deployed.
The check that actually settles the question is the favicon-cache probe from the
top of this document, re-run after deploy and after Google has re-crawled:

```bash
for d in ephesushq.com totally-nonexistent-domain-xyz123.com; do curl -sL -o "$d.png" "https://www.google.com/s2/favicons?sz=64&domain=$d"; printf "%-42s md5=%s\n" "$d" "$(md5sum "$d.png" | cut -c1-12)"; done
```

The fix has landed when those two hashes stop matching. Until then the icon is
correct in the build and unproven in search.

## Follow-up, not done here

- **Deploy, then request a re-crawl of the home page in Search Console.** That
  needs the Architect's account; it is the one step that can shorten "days to
  weeks".
- **Re-run the favicon-cache probe after the next crawl** and record the result,
  so the claim in this document is either confirmed or retired rather than left
  open indefinitely.

## Related docs

- `site/README.md` — the site as a separate workspace
- `docs/implementations/2026-09-05-*` — the site's own build-out, including the
  SEO infrastructure this change sits alongside
