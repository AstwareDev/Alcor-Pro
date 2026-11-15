import { sub } from "./e2lib.mjs";
const s = "src/timeline/view/shortcuts.ts";
sub(s, `  | "zoomToFit"
  | "escape";`, `  | "zoomToFit"
  | "easyEase"
  | "escape";`);
sub(s, `  { combo: { code: "KeyZ", ...noMods, shift: true }, command: "zoomToFit" },`, `  { combo: { code: "KeyZ", ...noMods, shift: true }, command: "zoomToFit" },
  // After Effects: F9 = easy ease on the selected keyframes.
  { combo: { code: "F9", ...noMods, shift: false }, command: "easyEase" },`);
sub(s, `    case "togglePlayback":
      ui.isPlaying = !ui.isPlaying;
      return true;`, `    case "easyEase":
      return easyEaseSelectedKeyframes(editor);
    case "togglePlayback":
      ui.isPlaying = !ui.isPlaying;
      return true;`);
sub(s, `import { skipBackward,`, `import { easyEaseSelectedKeyframes } from "../../editor/mutations/keyframes";
import { skipBackward,`);
