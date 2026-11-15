import { sub } from "./e2lib.mjs";
const c = "src/timeline/view/clipRenderer.ts";
sub(c, `  clipSourceDurationFrames,
  clipSourceFramesConsumed,`, `  clipHasSpeedRamp,
  clipSourceDurationFrames,
  clipSourceFramesAt,
  clipSourceFramesConsumed,
  keyframeEase,`);
sub(c, `  smoothstep,
  type Clip,`, `  type Clip,`);
sub(c, `  type Interpolation,
  type MediaAsset,`, `  type Keyframe,
  type MediaAsset,`);
sub(c, `import { css, type CanvasPalette`, `import { traceKeyframeGlyph } from "./keyframeGlyph";
import { css, type CanvasPalette`);
sub(c, `  by: number,
  interp: Interpolation,
  dbA: number,
  dbB: number,
  body: Rect,
): void {
  switch (interp) {
    case "linear":
      ctx.lineTo(bx, by);
      break;
    case "hold":
      ctx.lineTo(bx, ay);
      ctx.lineTo(bx, by);
      break;
    case "smooth":
      for (let s = 1; s <= 12; s++) {
        const t = s / 12;
        ctx.lineTo(ax + (bx - ax) * t, yForDb(dbA + (dbB - dbA) * smoothstep(t), body));
      }
      break;
  }
}`, `  by: number,
  ka: Keyframe<number>,
  dbB: number,
  body: Rect,
): void {
  switch (ka.interpolationOut) {
    case "linear":
      ctx.lineTo(bx, by);
      break;
    case "hold":
      ctx.lineTo(bx, ay);
      ctx.lineTo(bx, by);
      break;
    default:
      for (let s = 1; s <= 12; s++) {
        const t = s / 12;
        ctx.lineTo(ax + (bx - ax) * t, yForDb(ka.value + (dbB - ka.value) * keyframeEase(ka, t), body));
      }
      break;
  }
}`);
sub(c, `rect.x + kb.frame * ppf, yForDb(kb.value, body), ka.interpolationOut, ka.value, kb.value, body);`, `rect.x + kb.frame * ppf, yForDb(kb.value, body), ka, kb.value, body);`);
sub(c, `      ctx.beginPath();
      ctx.moveTo(cx, cy - half);
      ctx.lineTo(cx + half, cy);
      ctx.lineTo(cx, cy + half);
      ctx.lineTo(cx - half, cy);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  drawFadeHandle(dc, leftX`, `      ctx.beginPath();
      traceKeyframeGlyph(ctx, kf.interpolationOut, cx, cy, half);
      ctx.fill();
      ctx.stroke();
    }
  }
  drawFadeHandle(dc, leftX`);
const t = "src/timeline/view/timelineRenderer.ts";
sub(t, `          ctx.beginPath();
          ctx.moveTo(x, cy - half);
          ctx.lineTo(x + half, cy);
          ctx.lineTo(x, cy + half);
          ctx.lineTo(x - half, cy);
          ctx.closePath();
          ctx.fill();`, `          ctx.beginPath();
          traceKeyframeGlyph(ctx, clipInterpolation(clip, property, frame) ?? "linear", x, cy, half);
          ctx.fill();`);
