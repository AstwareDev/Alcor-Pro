import { sub } from "./e2lib.mjs";
const o = "src/preview/offlineRender.ts";
sub(o, `  private served: SourceFrame | null = null;
  private version = 0;`, `  private served: SourceFrame | null = null;
  private version = 0;
  private blendCanvas: OffscreenCanvas | null = null;`);
sub(o, `  async frameAt(t: number): Promise<SourceFrame | null> {`, `  /** Frame blending: the frame at \`t\` mixed with its successor by how far \`t\` lies between them. */
  async blendedFrameAt(t: number): Promise<SourceFrame | null> {
    const base = await this.frameAt(t);
    const cur = this.current;
    const next = this.next;
    if (!base || !cur || !next) return base;
    const span = next.timestamp - cur.timestamp;
    const alpha = span > 0 ? (t - cur.timestamp) / span : 0;
    if (!(alpha > 0.02 && alpha < 0.98)) return base;
    const w = cur.displayWidth, h = cur.displayHeight;
    if (!this.blendCanvas || this.blendCanvas.width !== w || this.blendCanvas.height !== h) this.blendCanvas = new OffscreenCanvas(w, h);
    const ctx = this.blendCanvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    cur.draw(ctx, 0, 0);
    ctx.globalAlpha = alpha;
    next.draw(ctx, 0, 0);
    ctx.globalAlpha = 1;
    this.version += 1;
    return { source: this.blendCanvas, width: w, height: h, version: this.version, premultiplied: true };
  }

  async frameAt(t: number): Promise<SourceFrame | null> {`);
sub(o, `frame = cursor ? await cursor.frameAt(layer.sourceTime) : null;`, `frame = cursor ? await (layer.frameBlend ? cursor.blendedFrameAt(layer.sourceTime) : cursor.frameAt(layer.sourceTime)) : null;`);
const c = "src/timeline/view/clipRenderer.ts";
sub(c, `  const durationSec = clipSourceFramesConsumed(clip) / fpsD;
  if (!(durationSec > 0)) return;`, `  const durationSec = clipSourceFramesConsumed(clip) / fpsD;
  if (!(durationSec > 0)) return;
  const ramped = clipHasSpeedRamp(clip);`);
sub(c, `    const timeSec = startSec + ((tileX - draw.x) / draw.width) * durationSec;`, `    const frac = (tileX - draw.x) / draw.width;
    const timeSec = startSec + (ramped ? clipSourceFramesAt(clip, frac * clip.durationFrames) / fpsD : frac * durationSec);`);
