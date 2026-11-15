import { sub } from "./e2lib.mjs";
sub("src/theme/tokens.css", "  --marker-editor-w: 320px;", "  --marker-editor-w: 320px;\n  --curve-editor-w: 244px;");
const c = "src/timeline/view/contextMenus.ts";
sub(c, `  const choices: [Interpolation, string][] = [
    ["linear", "Linear"],
    ["smooth", "Smooth"],
    ["hold", "Hold"],
  ];
  return menuSections(
    choices.map(([interp, label]) => item(label, () => setInterpolation(editor, clipId, property, frame, interp), { checked: current === interp })),
    [item("Delete Keyframe", () => removeKeyframe(editor, clipId, property, frame))],
  );`, `  const choices: [Interpolation, string][] = [
    ["linear", "Linear"],
    ["hold", "Hold"],
    ["smooth", "Smooth"],
    ["easeIn", "Ease in"],
    ["easeOut", "Ease out"],
    ["easeInOut", "Ease in and out"],
  ];
  return menuSections(
    [
      ...choices.map(([interp, label]) => item(label, () => setInterpolation(editor, clipId, property, frame, interp), { checked: current === interp })),
      item("Custom curve…", () => openCurveEditor(editor, { clipId, property, frame }, c.menuAnchor()), { checked: current === "bezier" }),
    ],
    [item("Delete Keyframe", () => removeKeyframe(editor, clipId, property, frame))],
  );`);
sub(c, `import { keyframeLaneHit } from "../timelineInput";`, `import { keyframeLaneHit } from "../timelineInput";
import { openCurveEditor } from "../../curveEditor/CurveEditorPopover";`);
