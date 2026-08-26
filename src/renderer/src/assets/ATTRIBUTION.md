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

| Asset | Version | Author | Licence | Redistributable | Where used |
|---|---|---|---|---|---|
| Press Start 2P (`@fontsource/press-start-2p`, latin-400) | npm-pinned | CodeMan38 | SIL OFL 1.1 | yes | Display face — panel titles (UI-DESIGN §3) |
| Pixelify Sans (`@fontsource/pixelify-sans`, latin-400) | npm-pinned | Stefie Justprince | SIL OFL 1.1 | yes | UI body & labels (UI-DESIGN §3) |
| IBM Plex Mono (`@fontsource/ibm-plex-mono`, latin-400) | npm-pinned | IBM / Bold Monday | SIL OFL 1.1 | yes | Data, logs, Odeon artifacts (UI-DESIGN §3) |

| Kenney *Roguelike/RPG pack* (`kenney-roguelike-rpg.png`) | 2023 pack | Kenney (kenney.nl) | CC0 1.0 (license file in pack) | yes (public domain) | Staged in the tileset drop — interim floor sheets pending Architect review; LimeZu *Modern Interiors* replaces them after purchase |
| Kenney *Roguelike Indoors* (`kenney-roguelike-indoors.png`) | 2023 pack | Kenney (kenney.nl) | CC0 1.0 (license file in pack) | yes (public domain) | Same as above |

Citizens remain procedural (never third-party — rule 3).

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
redistribution in an application. **Source of truth is npm** (Architect decision
2026-08-26): the `@fontsource/*` packages listed above are copied into this drop
by `scripts/sync-fonts.cjs` on every `npm install` — the woff2 files stay out of
git. They are loaded at runtime by `src/renderer/src/fonts.ts`; with the files
absent the app falls back to the generic stacks in `tokens.css` and says
`fonts: N of 3 pixel faces missing` in the status strip. See
`src/renderer/public/fonts/README.md` for the exact filenames.
