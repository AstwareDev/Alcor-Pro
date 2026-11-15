import { sub } from "./e2lib.mjs";
sub("src/timeline/view/contextMenus.ts", `openCurveEditor(editor, { clipId, property, frame }, c.menuAnchor())`, `openCurveEditor(editor, { clipId, property, frame })`);
const p = "src/curveEditor/CurveEditorPopover.tsx";
sub(p, `let dispose: (() => void) | undefined;`, `// The popover opens where the context menu that launched it was.
let lastMenuPoint = { x: 200, y: 200 };
if (typeof window !== "undefined") {
  window.addEventListener("contextmenu", (e) => {
    lastMenuPoint = { x: e.clientX, y: e.clientY };
  }, true);
}

let dispose: (() => void) | undefined;`);
sub(p, `export function openCurveEditor(editor: Editor, ref: KeyframeRef, anchor: { x: number; y: number }): void {`, `export function openCurveEditor(editor: Editor, ref: KeyframeRef, anchor: { x: number; y: number } = lastMenuPoint): void {`);
