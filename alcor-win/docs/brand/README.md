# Alcor brand kit

Updated 2026-11-16. The user requested a logo, then explicitly selected black, white and green for **logo, cover and app UI**, inspired by Higgsfield. This replaces the earlier monochrome/Palmier-led direction.

## Identity

The original mark combines a geometric A, a right-pointing play cutout, and a small companion star referencing Alcor's astronomical name. It is a design concept, not a trademark-clearance claim. Higgsfield's logo and assets were not reused.

| Role | Color | Usage |
|---|---|---|
| Black | `#0b0b0c` | Primary background and dark ink |
| White | `#f5f7f2` | Light surfaces and inverse lettering |
| Green | `#c6f432` | Brand mark, active actions, selection and playhead on dark surfaces |
| Green ink | `#3b5700` | Accessible green text/actions on light surfaces |

Higgsfield's live homepage was visually inspected; its observed green was `rgb(209,254,23)`. Alcor's green intentionally keeps the distinct lime already present in the working tree. Darkroom surface/radius/layout work from the other agent was preserved, not replaced.

## Assets

Each SVG has a corresponding PNG:

- `alcor-logo-light`: green mark and white wordmark for dark backgrounds; 2160 × 768 PNG.
- `alcor-logo`: dark-green mark and black wordmark for light backgrounds; 2160 × 768 PNG.
- `alcor-mark-green`: green standalone mark; 1024 × 1024 PNG.
- `alcor-mark`: black monochrome mark; 1024 × 1024 PNG.
- `alcor-mark-light`: white monochrome mark; 1024 × 1024 PNG.
- `alcor-app-icon`: black mark on a lime rounded-square tile; 1024 × 1024 PNG.
- `alcor-logo-preview.png`: 1600 × 1100 presentation showing variants and palette.
- `preview.html`: editable presentation source.

PNG space outside the artwork is transparent. Wordmark letters are vector outlines, so SVGs need no installed font. Use the lime mark on dark backgrounds, not as low-contrast text on white; use the dark-green positive variant on light backgrounds. Keep the mark and companion star together, without stretching or adding a glow.

The full product name is **Alcor Pro**; **Alcor** is the short wordmark. The npm/Rust package and executable remain `alcor-pro`, the library remains `alcor_pro_lib`, and the application ID stays `io.alcor.pro`. The user explicitly confirmed retaining “Pro.”

The app icon is now integrated into `src-tauri/icons` (17 desktop files, including Windows ICO and the configured ICNS/PNG assets), plus `public/favicon.svg` and `public/favicon.png`. Rebuild and restart the native executable/installer to see the new taskbar/install icon; the existing running binary was not rebuilt.

## Application integration

Scoped changes by this session:

- `src/theme/tokens.css`: named black/white/green tokens; unified dark accents and links; accessible light green palette; muted green/neutral track tokens. Preserved existing layout and shape tokens.
- `src/timeline/view/timelineClipColors.ts`: matching default track colors only. Saved user color preferences still win, and reset restores the new defaults.
- `src/ui/AlcorBrand.tsx` and `.css`: static, theme-aware logo component, without polling or dependencies.
- `src/home/HomeView.tsx`: two-line integration of branding in the existing sidebar.
- `src/editor/TitleBar.tsx`: two-line integration of the compact symbol, retaining existing activity/shortcuts work.
- `src/settings/settings.css`: API-key validation errors use `--status-error`, not the now-green playhead token.
- `src/theme/brandPalette.test.ts`: brand contrast, light-theme accents, and CSS/canvas color consistency checks.

Errors, destructive actions, audio clipping/warnings, and RGB grading controls retain their functional colors. Image/video content is not tinted. No editing behavior, provider integration, saved project, appearance preference, or application npm dependency was changed.

The cover assets in `../cover` were regenerated with the new logo and actual updated editor components. They remain labeled as an in-memory demo with original image artwork and synthetic audio waveforms.

## Native identity and README integration

The root README now includes theme-aware wordmark variants, the branded cover, brand-kit links, and identity/icon-regeneration instructions. npm metadata has a product description and `private: true`; Cargo metadata has the matching description and GPL license rather than a placeholder author. Tauri has the Alcor Pro product/window names, matching startup background and bundle descriptions. Browser metadata and favicons are integrated in `index.html`.

```powershell
pnpm run brand:icons
pnpm run brand:check
```

`brand:icons` uses the existing Tauri CLI to generate into a fresh temporary directory, copies only desktop icons and browser favicons, and cleans up its own temporary directory. It does not add mobile asset trees or dependencies. `brand:check` runs 20 Node tests covering names/versions/license, stable application and credential IDs, PNG dimensions/RGBA format, ICO image entries, ICNS and bundle paths, browser favicons and README assets.

Final integration checks passed: **20/20 branding tests**, `pnpm typecheck`, and `cargo metadata --offline --locked --no-deps --format-version 1`. The generated 128px icon was visually checked. No native build was run. The app name, package/crate names, credentials, project directories, protocols and file formats remain unchanged.

## Verification

Final checks:

```powershell
node node_modules/vitest/vitest.mjs run src/theme/brandPalette.test.ts src/timeline/view/timelineClipColors.test.ts src/settings/settings.test.ts
pnpm typecheck
```

- **3 files / 15 tests passed**, including the 8 new palette checks.
- **TypeScript passed** with no output other than the command banner.
- Browser editor: opened/dismissed Canvas Guides, selected the title clip, checked inspector, captured dark and light modes; **zero uncaught page errors**.
- Visually checked logo presentation, green cover and light editor capture.
- Native WebView2: confirmed the rendered Alcor logo and new brand tokens in its current view. Its light preference was respected; no navigation or preference changes in the final check.

Intermediate failures were fixed: Vitest stubs raw CSS imports, so the new test reads the CSS file in Node instead; that test-only import follows the project's existing `@ts-expect-error` approach because Node typings are not an app dependency. The cover renderer was updated to decode both images after adding the logo. An old Home-specific native smoke check timed out after the native view changed; final verification is now read-only and view-independent.

The initial documented `pnpm test -- <paths>` invocation forwarded `--` such that the wider suite ran and exited nonzero. The final command above directly selected the intended tests; the full suite was **not revalidated**. No native rebuild, full correctness review, staging, commit or publishing was performed by this session. Preserve unrelated staged/working-tree edits from the other agent.

## Regeneration

`generate-assets.mjs` uses `PLAYWRIGHT_MODULE`, `OPENTYPE_MODULE`, `LOGO_FONT`, and `CHROMIUM_EXECUTABLE`. Tooling was installed only in `D:/Temp/alcor-visual-tools-20261115`, outside the app. `LOGO_FONT` was the locally installed Segoe UI Semibold font; outlines are embedded in the resulting wordmark SVGs, not font files. No runtime font dependency is shipped.
