import { sub } from "./e2lib.mjs";
sub("src/timeline/view/clipRenderer.ts", `  keyframeEase,
`, `  keyframeEase,
  smoothstep,
`);
sub("src/timeline/view/timelineRenderer.ts", `  clipKeyframeFramesIntersecting,`, `  clipInterpolation,
  clipKeyframeFramesIntersecting,`);
sub("src/timeline/view/timelineRenderer.ts", `import { css, type CanvasPalette } from "./canvasPalette";`, `import { css, type CanvasPalette } from "./canvasPalette";
import { traceKeyframeGlyph } from "./keyframeGlyph";`);
