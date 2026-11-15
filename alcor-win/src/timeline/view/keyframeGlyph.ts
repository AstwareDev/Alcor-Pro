import type { Interpolation } from "../../model";

/** After Effects-style keyframe marker shapes: the glyph tells how the segment leaving the keyframe is eased. */
export type KeyframeGlyphKind = "diamond" | "square" | "circle" | "hourglass" | "leftRound" | "rightRound" | "octagon";

export function keyframeGlyphKind(interpolation: Interpolation): KeyframeGlyphKind {
  switch (interpolation) {
    case "linear": return "diamond";
    case "hold": return "square";
    case "smooth": return "circle";
    case "easeInOut": return "hourglass";
    case "easeIn": return "rightRound";
    case "easeOut": return "leftRound";
    case "bezier": return "octagon";
  }
}

/** Adds the glyph to the current path (the caller fills / strokes). `half` is the glyph's half extent. */
export function traceKeyframeGlyph(ctx: CanvasRenderingContext2D, interpolation: Interpolation, cx: number, cy: number, half: number): void {
  const k = keyframeGlyphKind(interpolation);
  switch (k) {
    case "diamond":
      ctx.moveTo(cx, cy - half);
      ctx.lineTo(cx + half, cy);
      ctx.lineTo(cx, cy + half);
      ctx.lineTo(cx - half, cy);
      ctx.closePath();
      return;
    case "square": {
      const s = half * 0.8;
      ctx.rect(cx - s, cy - s, s * 2, s * 2);
      return;
    }
    case "circle":
      ctx.moveTo(cx + half, cy);
      ctx.arc(cx, cy, half, 0, Math.PI * 2);
      ctx.closePath();
      return;
    case "hourglass":
      ctx.moveTo(cx - half, cy - half);
      ctx.lineTo(cx + half, cy - half);
      ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.moveTo(cx - half, cy + half);
      ctx.lineTo(cx + half, cy + half);
      ctx.lineTo(cx, cy);
      ctx.closePath();
      return;
    case "leftRound":
      ctx.moveTo(cx - half, cy);
      ctx.lineTo(cx, cy - half);
      ctx.arc(cx, cy, half, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(cx, cy + half);
      ctx.closePath();
      return;
    case "rightRound":
      ctx.moveTo(cx + half, cy);
      ctx.lineTo(cx, cy + half);
      ctx.arc(cx, cy, half, Math.PI / 2, (3 * Math.PI) / 2);
      ctx.lineTo(cx, cy - half);
      ctx.closePath();
      return;
    case "octagon": {
      const c = half * 0.4;
      ctx.moveTo(cx - half + c, cy - half);
      ctx.lineTo(cx + half - c, cy - half);
      ctx.lineTo(cx + half, cy - half + c);
      ctx.lineTo(cx + half, cy + half - c);
      ctx.lineTo(cx + half - c, cy + half);
      ctx.lineTo(cx - half + c, cy + half);
      ctx.lineTo(cx - half, cy + half - c);
      ctx.lineTo(cx - half, cy - half + c);
      ctx.closePath();
      return;
    }
  }
}
