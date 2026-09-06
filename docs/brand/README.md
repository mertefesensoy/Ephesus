# Brand marks

The Ephesus mark is an Ionic column — the one still standing at the Artemision.
Terracotta capital, marble shaft, drawn to [`../design/UI-DESIGN.md`](../design/UI-DESIGN.md).

| File | Use |
|---|---|
| `ephesus-16.svg` | Favicon, and anywhere under 24 px |
| `ephesus-32.svg` | Small UI, list rows, tab strips |
| `ephesus-64.svg` | The master drawing |
| `ephesus-128.svg` | README header, docs, anywhere large |
| `ephesus-column-52.svg` | The column alone, no field — for anywhere the host supplies the background |
| `ephesus-column-520.png` | Upload-ready: GitHub **App logos**, where GitHub paints the badge behind it |
| `ephesus-round-64.svg` | The round mark, for anywhere nothing supplies a background |
| `ephesus-round-512.png` | Upload-ready: **org and profile avatars**, which are shown as-is |
| `ephesus-social-card.svg` | 1280×640 GitHub social preview |

## Each size is redrawn, not scaled

This is the part to know before editing any of them.

The 64-unit master has **1-unit flute grooves** and a 2×2 volute eye. Render it at
32 px and one unit is half a pixel: the grooves land between pixels, the renderer
averages them into the flutes, and the shaft goes flat — losing precisely the
detail that makes it read as a cylinder rather than a bar. At 16 px the capital
collapses entirely.

So each size has a detail budget it can actually spend:

| Grid | Capital | Shaft | Base |
|---|---|---|---|
| 64 | abacus, paired volutes with recessed eyes, echinus | 4 flutes + 3 grooves | torus, scotia, plinth |
| 32 | volutes as solid blocks, no eyes | 2 flutes + 2 grooves | scotia dropped |
| 16 | one terracotta band | 2 flutes + 1 groove | two rows |

`ephesus-128.svg` is the 64 artwork at an integer 2×, which stays crisp.

**Detail that cannot resolve is worse than no detail.** If you add a size, redraw
it — do not scale.

## The rules these obey

Every mark conforms to [`../design/UI-DESIGN.md`](../design/UI-DESIGN.md):

- **Only §2 tokens.** No invented hex. Each file uses 7 colours, inside §1.3's
  ceiling of 8.
- **Integer coordinates only**, with `shape-rendering="crispEdges"`. §1.1 makes
  pixel-snapping a hard rule, so there are no half-pixels and no anti-aliased
  curves anywhere in these files.
- **Light from the upper left**, consistently: the flute ramp runs light to
  shadow left-to-right, and every horizontal moulding carries a shadow row
  beneath it. That consistency is what reads as depth — outlines alone do not.

Both properties are mechanically checkable, and worth re-checking after any edit:

```bash
# every colour must appear in UI-DESIGN.md, and no coordinate may be fractional
grep -ohE '#[0-9A-Fa-f]{6}' docs/brand/*.svg | sort -u
grep -ohE '(x|y|width|height)="[0-9]*\.[0-9]+"' docs/brand/*.svg   # must print nothing
```

## The round mark is a redraw, not a crop

`ephesus-round-64.svg` exists because **cropping the square mark to a circle cuts the
column's corners off**. The abacus and the plinth are the widest parts of the drawing
and they sit at the very top and bottom — exactly where a circle is at its narrowest.
A circular mask over `ephesus-64.svg` removes 57,062 of its 262,144 pixels at 512 px,
including both ends of the plinth.

So the round mark keeps the master's shaft column-for-column — that is the part with
the flutes, and the part a reader recognises — and redraws only the capital and base,
34 units wide instead of 36. The column is 34×48 inside a 62-unit disc: the largest
the master's proportions go before a corner touches the field, leaving 1.3 units of
marble at the plinth. The ring is one unit rather than two for the same reason —
every unit spent on the ring is a unit the column cannot have.

**The disc is inset one unit from the canvas edge, and that is load-bearing.** GitHub
scales the upload and masks it to a circle itself. If our disc ran to r=32 the host's
mask would land on our stepped edge and shave it into a smooth one, losing the pixel
edge that makes it part of this family. At r=31 the mask passes through empty space
and the artwork survives untouched — verified by applying a full-radius circular mask
and diffing: 0 pixels lost, against 57,062 for the square mark.

The four canvas corners are transparent, so the same file also survives a rounded-square
mask, and reads on GitHub's dark canvas as well as its light one.

## Which one to upload where

The two round files answer different questions, and the difference is **who paints the
background**.

A **GitHub App logo** is composited onto a badge whose colour you choose on the same
settings page. GitHub already supplies a circle, so a mark that brings its own marble
disc puts a roundel inside a roundel and the column ends up small in the middle. Upload
`ephesus-column-520.png` there: it is the master column with the two background plates
deleted and the viewBox cropped to the column's own bounding box — nothing redrawn, and
nothing scaled. It runs edge to edge vertically, 69% wide, because a column is not square.

Set the **badge background to `F4EDE0`**. That is the marble the mark was drawn on, so
every shadow row and dark edge in the column was chosen against exactly that colour. The
tempting choice, `C4552D`, is the abacus's own colour and swallows the capital; `221A14`
and `4A3B2C` swallow the shaft's shadow side for the same reason.

An **org or profile avatar** is shown as uploaded, with no badge behind it. There
`ephesus-round-512.png` is right — it brings its own field and ring.

One honest trade: on the App settings page GitHub also previews the raw upload on a dark
tile, and the field-less column reads poorly there because its own dark side merges with
the tile. The badge is what users see; the tile is a settings-page artefact.

## The social card's wordmark is drawn, not typed

`ephesus-social-card.svg` spells EPHESUS with rectangles from a 5×7 bitmap rather
than setting it in Press Start 2P. The app bundles that face, but whatever
rasterises this file will not have it, and a silent fallback to Arial would break
§3's typography rule. Drawn glyphs cannot fall back.

GitHub's social preview needs PNG or JPG, so the card must be rasterised before
upload — open it in a browser at 1280×640 and capture, or use a headless renderer.
