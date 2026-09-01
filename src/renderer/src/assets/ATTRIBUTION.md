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

| LimeZu *Modern Interiors* — Room Builder 16×16 (`limezu-interiors-room-builder.png`) | full (paid) version, purchased 2026-08-28 | LimeZu ([limezu.itch.io](https://limezu.itch.io/)) | Commercial asset licence (`LICENSE.txt` in the pack): use and edit in any commercial or non-commercial project; **resale or redistribution of the asset is forbidden**; **credit required** | **no** — used in the app, never redistributed as an asset (rule 2) | The floor's walls and floors (UI-DESIGN §7). Active pack. |
| LimeZu *Modern Office Revamped* v1.2 — Room Builder 16×16 (`limezu-office-room-builder.png`) | v1.2, purchased 2026-08-28 | LimeZu ([limezu.itch.io](https://limezu.itch.io/)) | Same terms as above | **no** — same as above | An alternative floor palette. Layered after the interiors pack, so it fills only what that pack leaves unmapped. |
| LimeZu *Modern Office Revamped* v1.2 — furniture 16×16 (`limezu-office-furniture.png`) | v1.2, purchased 2026-08-28 | LimeZu ([limezu.itch.io](https://limezu.itch.io/)) | Same terms as above | **no** — same as above | Station furniture (UI-DESIGN §5.4). Mapped conservatively: only tiles that read as a whole object on their own. Half of a two-tile printer would look deliberate and be wrong. |
| LimeZu *Modern Interiors* — UI thinking emotes 16×16 (`limezu-emotes.png`) | full (paid) version, purchased 2026-08-28 | LimeZu ([limezu.itch.io](https://limezu.itch.io/)) | Same terms as above | **no** — same as above | Installed, NOT yet used. Intended for avatar status, which needs a decision about whether an emote replaces or accompanies the status word. |

Citizens remain procedural (never third-party — rule 3). The LimeZu purchase
ships a character generator and character sheets; **neither is used, and the
generator is never run**. That is not an oversight — rule 3 exists so that no
likeness and no other IP's character can appear on the floor, and a purchased
character pack is exactly the temptation it was written against.

**Retired 2026-08-28:** the Kenney *Roguelike/RPG* and *Roguelike Indoors* packs
(CC0) were interim staging while the licensed set was being chosen. They are out
of the drop; nothing references them. Their CC0 terms would still permit use, so
this is a quality decision rather than a licence one — §7's bar is the LimeZu
line, and keeping two half-mapped packs around invites painting one pack's
frames from the other's sheet.

## Tileset drop

```
src/renderer/src/assets/tileset/*.png          the sheet(s) — GITIGNORED (the
                                               licence forbids redistributing them)
src/renderer/src/assets/tileset/*.tiles.json   which tile paints what — COMMITTED
                                               (our own work; a fresh clone needs
                                               the maps to adopt a restored sheet)
```

Both are discovered at build time by `src/renderer/src/floor/tileset.ts` — no
code change is needed to adopt a pack.

A pack whose licence **requires a credit** declares it in its own map, as
`credit`, and the floor's status strip prints it beside the pack name — today,
`tileset: LimeZu Modern Interiors (Room Builder 16x16) — LimeZu —
limezu.itch.io`. The credit ships with the pack for the same reason the layout
does: it is a term of *that* licence, and a credit hard-coded in the app would
be wrong the moment somebody swapped the pack.

A sheet alone is not enough: every pack lays its tiles out differently, so the
pack's layout ships **with the pack**, as a tile map validated by
`src/shared/tileset.ts`. Hard-coding frame indices for a pack that is not in the
tree would paint whatever happened to sit at those offsets.

```jsonc
{
  "schemaVersion": 1,
  "name": "Kenney Roguelike Indoors",   // credited in the floor's status strip
  "sheet": "kenney-roguelike-indoors.png",
  "tilePx": 16,                          // must divide the 32px world tile (§7)
  "columns": 57,                          // sheet width in tiles
  "spacing": 1,                           // grid gap, if the pack has one
  "frames": {                             // any subset; unmapped tiles stay procedural
    "wall": 0, "path": 1, "temple": 2, "seat": 3,
    "floor-a": 10, "floor-b": 11,
    "station": 20, "station:odeon": 21    // `station:<name>` overrides `station`
  }
}
```

Anything short of a sheet **and** a valid map for it leaves the floor
procedural, and the status strip says which step is missing — no sheet, no tile
map, an invalid map (with the reason), or a map naming a sheet that is not
there. A tileset that quietly failed to load would look exactly like one nobody
had installed yet.

**Restore path for a fresh clone** (exact, as performed on 2026-08-28):

1. Buy *Modern Interiors* (full version) and *Modern Office Revamped* from
   [limezu.itch.io](https://limezu.itch.io/) and download the Windows/desktop
   archives. The interiors download is named by its itch slug
   (`moderninteriors-win.zip`), not by its version.
2. Copy exactly two files into `src/renderer/src/assets/tileset/`:
   - `1_Interiors/16x16/Room_Builder_16x16.png` → `limezu-interiors-room-builder.png`
   - `1_Room_Builder_Office/Room_Builder_Office_16x16.png` → `limezu-office-room-builder.png`
3. The `*.tiles.json` maps are already in this repository's history — they are
   the only part of the intake that may be committed, because a layout is our
   own work and not the asset. Restore them beside the sheets.
4. `npm test -- test/renderer/tileset.test.ts` — the drop block validates every
   installed map against its actual sheet (frame bounds, columns, integer scale).

**Do not use**, and why: `Modern_Interiors_Free_v2.2.zip` is the free tier and
must never ship in place of the purchased set; `Modern_Interiors_RPG_Maker_Version.zip`
is engine-formatted for RPG Maker and does not match this atlas layout; and
`Character Generator 2.0 Setup.exe` is never run — see rule 3.

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
