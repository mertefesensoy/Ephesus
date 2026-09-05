# Brand marks

The Ephesus mark is an Ionic column — the one still standing at the Artemision.
Terracotta capital, marble shaft, drawn to [`../design/UI-DESIGN.md`](../design/UI-DESIGN.md).

| File | Use |
|---|---|
| `ephesus-16.svg` | Favicon, and anywhere under 24 px |
| `ephesus-32.svg` | Small UI, list rows, tab strips |
| `ephesus-64.svg` | The master drawing |
| `ephesus-128.svg` | README header, docs, anywhere large |
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

## The social card's wordmark is drawn, not typed

`ephesus-social-card.svg` spells EPHESUS with rectangles from a 5×7 bitmap rather
than setting it in Press Start 2P. The app bundles that face, but whatever
rasterises this file will not have it, and a silent fallback to Arial would break
§3's typography rule. Drawn glyphs cannot fall back.

GitHub's social preview needs PNG or JPG, so the card must be rasterised before
upload — open it in a browser at 1280×640 and capture, or use a headless renderer.
