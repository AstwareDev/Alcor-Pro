import { sub } from "./e2lib.mjs";
sub("src/timeline/view/clipRenderer.ts", `  type Keyframe,
`, `  type Interpolation,
  type Keyframe,
`);
