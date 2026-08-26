# Pixel font drop

UI-DESIGN §3 names three faces and requires them **bundled** — the app must not
depend on a font CDN. Drop the files here, exactly under these names:

| File | Face | Licence |
|---|---|---|
| `PressStart2P-Regular.woff2` | Press Start 2P — display / panel titles | SIL OFL 1.1 |
| `PixelifySans-Regular.woff2` | Pixelify Sans — UI body & labels | SIL OFL 1.1 |
| `IBMPlexMono-Regular.woff2` | IBM Plex Mono — data, terminals, logs | SIL OFL 1.1 |

All three are Open Font License, which permits redistribution inside an
application; record each one in `../../src/assets/ATTRIBUTION.md` when it lands.

`src/renderer/src/fonts.ts` loads whatever is present at startup and reports
what is missing in the status strip — the app never silently renders in the
wrong face.
