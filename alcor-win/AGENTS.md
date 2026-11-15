# Alcor Pro (Windows port of Palmier Pro)

Alcor Pro is the Windows 11 port of Palmier Pro (macOS, Swift); user-facing name is "Alcor Pro". The original source is the specification and lives read-only at
`../_reference/palmier-pro` (`Sources/PalmierPro`, `Tests/PalmierProTests`). Licence: GPLv3, same as the original.

## Stack

- Tauri 2. Rust (`src-tauri`) stays thin: project package I/O, secrets, provider HTTP, MCP server, OS integration.
- SolidJS + TypeScript (strict) + Vite. Vitest for tests. Plain CSS with tokens. No Tailwind, no UI kit.
- Media: WebCodecs via `mediabunny`, WebGL2 compositor, WebAudio. No ffmpeg dependency in the core path.
- All editor state, domain logic and undo live in TypeScript so UI and agent tools share one implementation.

## Layout

```
src/model/      data types + pure functions (port of Models/)
src/editor/     editor store, undo, mutations (port of Editor/, Editor/ViewModel/)
src/timeline/   geometry, snap, ripple, overwrite engines, canvas timeline view
src/preview/    compositor, playback engine, overlays
src/media/      import, probe, thumbnails, waveforms
src/<feature>/  inspector, mediapanel, home, settings, generation, agent, export, captions
src/ui/         shared components
src/theme/      tokens.css (port of UI/AppTheme.swift)
src/platform/   the only place that calls Tauri `invoke`
src/util/       shared infrastructure only
```

## Porting rules

- Port behaviour exactly: same defaults, clamping, rounding, ordering, edge cases and error conditions as the Swift.
  Read the Swift file and its tests fully before writing. Do not simplify or "improve" domain logic.
- JSON field names and enum raw values are identical to the Swift `Codable` output, including the lenient decoding
  (missing keys fall back to defaults exactly where the Swift decoder does).
- Swift struct → TS `interface` + `makeX(partial?)` factory with the Swift defaults. Never classes for data.
- Swift methods / computed properties → exported free functions in the same module, receiver first:
  `clip.endFrame` → `clipEndFrame(clip)`. `mutating func` → function that mutates its first argument in place
  (callers pass Immer drafts). Non-mutating functions never mutate arguments.
- Numbers: Swift `Int(x.rounded())` and `.rounded()` round half away from zero — use `swiftRound` from
  `src/util/math.ts`, never `Math.round`. Swift `Int(x)` truncates — use `Math.trunc`. Integer division truncates.
- IDs: `newId()` from `src/util/id.ts` (uppercase UUID, like Swift `UUID().uuidString`).
- Keep Swift names (camelCase) so code can be cross-referenced. One Swift file → one TS file of the same base name
  in lowerCamelCase unless told otherwise.
- macOS-only concerns (AppKit, AVFoundation objects, Sparkle, Clerk/Convex account, telemetry) are not ported;
  list anything you skip in your report.

## Editor state and undo

- The document (timelines, media manifest, speakers, multicam groups) is one immutable tree owned by
  `DocumentStore` (`src/editor/document.ts`), exposed through the `Editor` (`src/editor/editor.ts`).
- `editor.perform(actionName, () => { … })` is the port of Swift `withTimelineSwap` / `undo.perform`. Inside it
  `editor.timeline`, `editor.doc` etc. are Immer drafts: mutate them in place exactly like the Swift mutates
  `timeline.tracks[i].clips[j]`. Work must be synchronous. Nested performs join the outer action. Unchanged work
  records nothing. Outside `perform` the document is frozen — mutating it throws.
- **Swift value-copy hazard.** `let clip = timeline.tracks[t].clips[c]` copies in Swift; in TS it aliases the draft.
  If the Swift reads that local after the source was mutated (old duration, old end frame, `before` state…), take
  `const clip = snapshot(timeline.tracks[t].clips[c])` (`src/util/snapshot.ts`). Conversely, when Swift mutates a
  local copy and writes it back, write it back in TS too. Check every local of struct type for this.
- Never insert the same object into the document twice (Swift copies on assignment): use `structuredClone` when
  duplicating a clip, track or style.
- Live drags: `const g = editor.beginGesture(name)`, mutate through `perform` on every pointer move, then
  `g.commit()` (one undo entry) or `g.cancel()` (restores the start state).
- Never wrap the live-drag `commit*` helpers (`commitClipProperties`, `commitScalarProperty`, `commitFades`, …) in
  another `editor.perform`: the outer action records the mid-drag state as its undo target.
- `editor.withoutRegistration(() => …)` applies changes with no undo entry (load, background metadata hydration).
- `editor.ui` holds transient state; each field is a signal. Assign a new value (`ui.selectedClipIds = new Set(…)`),
  never mutate a Set/array/object held there in place. Selection is captured per action and restored by undo/redo.
- Model functions must `delete` an optional key rather than assign `undefined` to it: an `undefined` assignment
  marks the Immer draft as changed and creates a spurious undo entry.
- One user intent = one undo entry. Validate before `perform`; failed or refused operations must not mutate.
- UI components render state and forward intent. No domain logic in components.
- High-frequency state (playhead, meters, hover, drag preview) must not invalidate large component trees: use
  dedicated signals and draw to canvas / mutate DOM directly.

## Code style

- Strict TypeScript. No `any`, no non-null `!` unless an invariant is stated on the same line.
- Minimal comments: one short line, only for a non-obvious why.
- No speculative abstraction, no compatibility layers, no dead code.
- Icons: Lucide, imported per icon (`import Scissors from "lucide-solid/icons/scissors"`), never from the
  `lucide-solid` barrel. Pick the icon closest to the SF Symbol the Swift uses.
- UI styling uses only CSS variables from `src/theme/tokens.css`. Add a token there before hardcoding a value.
- Never block the UI thread with file, decode or encode work: use Rust commands, workers, or async WebCodecs.

## Tests

- Port the matching Swift tests (`Tests/PalmierProTests/**`) to Vitest next to the code as `<name>.test.ts`,
  keeping test names. Every ported pure module needs its ported tests passing.
- Run `pnpm test -- <path>` for your files and `pnpm typecheck` before reporting.
- Report exactly what ran, what failed, and what you did not port. Never claim untested behaviour works.
