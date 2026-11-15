# Alcor Pro cover assets

Created 2026-11-15; redesigned 2026-11-16 after the user explicitly chose black/white/green for the logo, cover, and app UI. All deliverables stay local; nothing was published or committed. App branding/theme changes are listed in `../brand/README.md`. Application dependencies and existing saved projects were not changed. Native icon resources, browser favicons and bundle descriptions were subsequently integrated; the full product name remains Alcor Pro. The native executable has not been rebuilt.

## Deliverables

- `alcor-pro-cover.png`: 1920 × 1080 cover.
- `alcor-pro-cover@2x.png`: 3840 × 2160 cover.
- `cover.html`: editable, responsive source for the cover.
- `editor-screenshot.png`: 3840 × 1800 capture of actual editor components running in Chromium, with an in-memory demo document.
- `native-app-screenshot.png`: separate screenshot of the actual Windows application's current view, captured without navigating or changing its preferences.
- `editor-screenshot-light.png`: a light-theme visual check of the same in-memory editor demo.
- `demo-landscape.png`: original procedural artwork generated for the demo. No stock photograph or Palmier imagery is used in the cover.
- `capture-editor.mjs`, `render-cover.mjs`, `check-native.mjs`: capture and verification scripts.

The editor image is deliberately labeled **Editor preview · Demo project**. The scene uses real SolidJS editor, preview, text rendering, inspector, media panel, prompt bar, and timeline components. Images are procedural demo assets; audio waveforms are synthetic fixtures. It does not demonstrate AI generation, media decoding, audio playback, export, or a completed native editing workflow. The prompt bar is media generation, not a built-in chat agent. Optional visual-search model loading is unavailable in the offline capture and the app's Retry indicator remains visible rather than being concealed.

## Design reference

Visited and visually inspected https://palmier.io/ on 2026-11-15, including a browser screenshot and computed styles. Observed warm near-black background (`rgb(13,12,10)`), off-white type (`rgb(236,236,236)`), muted gray secondary copy, large left-aligned sans-serif headlines, generous spacing, restrained controls and prominent product imagery. These are observed design cues, not a claim to possess Palmier's internal brand guidelines.

The original composition used those cues. On 2026-11-16 the user changed direction to black, white and green inspired by Higgsfield, and explicitly included the app UI. The current cover uses Alcor's own logo and lime/black/white palette, Segoe typography, an authentic editor capture and original artwork. Higgsfield's homepage was visually inspected; its observed green was `rgb(209,254,23)`. Alcor retains the working tree's existing distinct lime `#c6f432`, unified across assets and UI. No reference-site logos, endorsements or screenshots are reused.

## What ran and what was verified

1. No dev server was listening at 1420. Started the existing frontend from Windows Node with the explicit application root:
   ```powershell
   node D:/Projects/Alcor/alcor-win/node_modules/vite/bin/vite.js D:/Projects/Alcor/alcor-win --host 127.0.0.1
   ```
2. Opened `http://127.0.0.1:1420/?dev=editor` in headless Chromium. Mounted a custom in-memory demo with actual app components; no source patch or project save. Opened and dismissed Canvas Guides; selected a timeline title and verified its text inspector. Final capture reported **zero uncaught browser page errors**. External requests were blocked for the final demo capture, so no models or generated media were downloaded.
3. Launched the **existing** `src-tauri/target/debug/alcor-pro.exe`, not a new build. Its WebView2 loaded `http://localhost:1420/`. Opened Home project search, filtered an existing generic project, cleared the search and dismissed it. No saved project was opened or modified. Captured and visually checked the native Home screen.
4. Exported the cover at 1x and 2x and visually checked the 1920 × 1080 result.

The existing native debug binary predates this session; current Rust source was **not rebuilt or validated**. No Tauri/build commands were run. After the palette/UI update, the focused brand, timeline-color, and appearance test files passed (15 tests total), and `pnpm typecheck` passed. Dark and light editor captures reported zero uncaught browser page errors. Native WebView2 reflected the new logo and brand tokens; its current view/preferences were preserved. An intermediate repeat of the older Home-search script timed out because its Home assumption no longer held; the final read-only branding check passed. See `../brand/README.md` for the scoped changes and verification history.

At handoff, the native app and Vite server were left running. Native WebView2 was launched with a loopback CDP endpoint at port 9223 for this session. Closing that app ends this debug session. MCP also starts with the native app; it was not exercised.

## Reproduce the captures

Scripts use `playwright-core` and an installed Chromium executable through environment variables; no app npm dependency was added. Session tooling was isolated in `D:/Temp/alcor-visual-tools-20261115`.

```powershell
$env:PLAYWRIGHT_MODULE = 'file:///D:/Temp/alcor-visual-tools-20261115/node_modules/playwright-core/index.mjs'
$env:CHROMIUM_EXECUTABLE = '<absolute path to chrome-headless-shell.exe>'
node docs/cover/capture-editor.mjs
node docs/cover/render-cover.mjs
```

Run with the Vite server above active. To regenerate just the cover after changing its HTML, only `render-cover.mjs` is needed. Native verification additionally needs the existing app launched with:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
Start-Process ./src-tauri/target/debug/alcor-pro.exe
node docs/cover/check-native.mjs
```

`check-native.mjs` checks the logo and theme tokens in the native window without navigating or modifying projects/preferences, then captures its current view. It is a visual smoke check, not a general end-to-end suite. For a reusable project launch/drive skill, consider `/run-skill-generator`.

## Context for the resuming agent

- Read `../../AGENTS.md` and `../../../.claude/agent-brief.md` before code work. This session did not take over ongoing implementation.
- Alcor is a Tauri 2 / SolidJS editor with a thin Rust shell, transactional TypeScript document/undo model, WebGL2/WebCodecs media path and MCP bridge.
- The root README coverage table is not reliable as current verification: visual search and onboarding implementations now exist, while the sample-project catalog is still empty.
- Cover assets are not wired into the root README or any website; choose placement separately.
