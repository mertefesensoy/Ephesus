# Third-party asset attribution

Every third-party asset shipped with Ephesus is recorded here, with its licence
and the terms it is used under (UI-DESIGN §7). **An asset that is not listed here
is not shipped.**

## Rules

1. Only licences that permit redistribution inside a shipped application are
   acceptable. "Free for personal use", "no redistribution", and asset-store
   licences that forbid bundling are not.
2. Asset files that the licence forbids redistributing *in source form* are kept
   out of this repository: they go in the gitignored drop below, and the
   restore path is documented so a fresh clone can be rebuilt from a purchase.
3. Characters are never third-party assets. Citizens are drawn procedurally
   (`src/renderer/src/floor/citizen.ts`) precisely so no likeness of a real
   person and no other IP's character can appear on the floor.

## Installed assets

_None yet._ The floor currently renders its own tiles and citizens.

| Asset | Version | Author | Licence | Redistributable | Where used |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## Tileset drop (gitignored)

```
src/renderer/src/assets/tileset/*.png
```

Sheets placed here are discovered at build time by
`src/renderer/src/floor/tileset.ts` — no code change is needed to adopt them.
With the directory empty, the floor draws procedural tiles and the status strip
says `tileset: procedural (none installed)`.

**Restore path for a fresh clone:** purchase or obtain the tileset named in the
table above, unzip its 16×16 sheets into the drop directory, add its row here,
and rebuild. The reference lineage in §7 is LimeZu's *Modern Interiors*; a
Mediterranean/antiquity-compatible set is preferred if one is available on
comparable terms.

## Pixel fonts drop (gitignored)

```
src/renderer/public/fonts/*.woff2
```

The three faces of UI-DESIGN §3 — Press Start 2P, Pixelify Sans and IBM Plex
Mono — are all published under the SIL Open Font License, which does permit
redistribution in an application. They are loaded at runtime by
`src/renderer/src/fonts.ts`; with the files absent the app falls back to the
generic stacks in `tokens.css` and says `fonts: N of 3 pixel faces missing` in
the status strip. See `src/renderer/public/fonts/README.md` for the exact
filenames.
