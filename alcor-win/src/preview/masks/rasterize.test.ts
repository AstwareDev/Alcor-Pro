import { describe, expect, it } from "vitest";
import { makeEllipsePath, makeMask, makeMaskPath, makeMaskVertex, makeRectanglePath } from "../../model/mask";
import { makeKeyframe, makeKeyframeTrack } from "../../model/keyframe";
import { MaskTextures, maskRasterSize } from "./maskTextures";
import { insertVertex, nearestOnPath, removeVertex, setTangent } from "./pathMath";
import { rasterizeMasks, type MaskContext2D, type MaskSurface } from "./rasterize";

class FakeCtx {
  log: string[] = [];
  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = "source-over";
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineJoin: CanvasLineJoin = "miter";
  filter = "none";
  clearRect() { this.log.push("clear"); }
  fillRect() { this.log.push(`fillRect:${this.globalCompositeOperation}`); }
  beginPath() { this.log.push("begin"); }
  moveTo() {}
  bezierCurveTo() { this.log.push("curve"); }
  closePath() {}
  fill() { this.log.push("fill"); }
  stroke() { this.log.push(`stroke:${this.globalCompositeOperation}:${this.lineWidth}`); }
  drawImage() { this.log.push(`draw:${this.globalCompositeOperation}:${this.globalAlpha}:${this.filter}`); }
}

class FakeSurface implements MaskSurface {
  ctx = new FakeCtx();
  constructor(public width: number, public height: number) {}
  getContext(): MaskContext2D { return this.ctx as unknown as MaskContext2D; }
}

function run(masks: ReturnType<typeof makeMask>[], pxScale = 1) {
  const out = new FakeSurface(100, 100), shape = new FakeSurface(100, 100), blur = new FakeSurface(100, 100);
  const any = rasterizeMasks(out, { shape, blur }, masks, 0, pxScale);
  return { any, out: out.ctx.log, shape: shape.ctx.log, blur: blur.ctx.log };
}

describe("rasterizeMasks", () => {
  it("returns false when no mask has a usable path", () => {
    expect(run([makeMask({ path: makeMaskPath([makeMaskVertex(0, 0)]) })]).any).toBe(false);
    expect(run([]).any).toBe(false);
  });

  it("maps each mode to a canvas composite operation", () => {
    const base = { path: makeRectanglePath(0.1, 0.1, 0.9, 0.9) };
    const log = run([makeMask(base), makeMask({ ...base, mode: "subtract" }), makeMask({ ...base, mode: "intersect" }), makeMask({ ...base, mode: "difference" })]).out;
    expect(log.filter((l) => l.startsWith("draw")).map((l) => l.split(":")[1])).toEqual(["source-over", "destination-out", "destination-in", "xor"]);
  });

  it("starts a leading subtract mask from a full matte", () => {
    const { out } = run([makeMask({ mode: "subtract", path: makeRectanglePath(0.1, 0.1, 0.9, 0.9) })]);
    expect(out).toContain("fillRect:source-over");
  });

  it("feathers with a blur scaled by the render scale, strokes for expansion, xor for invert, alpha for opacity", () => {
    const m = makeMask({ shape: "ellipse", path: makeEllipsePath(0.5, 0.5, 0.3, 0.3), feather: 10, expansion: -4, inverted: true, opacity: 0.5 });
    const r = run([m], 0.5);
    expect(r.shape).toContain("stroke:destination-out:4");
    expect(r.blur).toContain("draw:source-over:1:blur(2.5px)");
    expect(r.blur).toContain("fillRect:xor");
    expect(r.out.find((l) => l.startsWith("draw"))).toBe("draw:source-over:0.5:none");
  });

  it("evaluates animated state at the offset", () => {
    const m = makeMask({ path: makeRectanglePath(0.1, 0.1, 0.9, 0.9), feather: 0 });
    m.featherTrack = makeKeyframeTrack([makeKeyframe(0, 0), makeKeyframe(10, 20)]);
    const out = new FakeSurface(10, 10), shape = new FakeSurface(10, 10), blur = new FakeSurface(10, 10);
    rasterizeMasks(out, { shape, blur }, [m], 10, 1);
    expect(blur.ctx.log.some((l) => l.includes("blur(10px)"))).toBe(true);
  });
});

describe("MaskTextures", () => {
  const fakeGl = {
    TEXTURE_2D: 1, TEXTURE_MIN_FILTER: 2, TEXTURE_MAG_FILTER: 3, TEXTURE_WRAP_S: 4, TEXTURE_WRAP_T: 5, LINEAR: 6, CLAMP_TO_EDGE: 7,
    UNPACK_FLIP_Y_WEBGL: 8, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 9, RGBA8: 10, RGBA: 11, UNSIGNED_BYTE: 12,
    createTexture: () => ({}), bindTexture() {}, texParameteri() {}, pixelStorei() {}, texImage2D() {}, deleteTexture() {},
  } as unknown as WebGL2RenderingContext;
  const factory = (w: number, h: number): MaskSurface => new FakeSurface(w, h);

  it("rasterizes a static mask once and again only when its state, size or scale changes", () => {
    const cache = new MaskTextures(factory);
    const masks = [makeMask({ path: makeRectanglePath(0.1, 0.1, 0.9, 0.9) })];
    const a = cache.acquire(fakeGl, "k", masks, 0, 64, 64, 1, 1);
    for (let f = 1; f < 50; f++) cache.acquire(fakeGl, "k", masks, f, 64, 64, 1, f + 1);
    expect(a).not.toBeNull();
    expect(cache.rasterCount).toBe(1);
    cache.acquire(fakeGl, "k", [...masks], 0, 64, 64, 1, 60);
    expect(cache.rasterCount).toBe(2);
    cache.acquire(fakeGl, "k", [...masks], 0, 32, 32, 0.5, 61);
    expect(cache.rasterCount).toBe(3);
  });

  it("re-rasterizes animated masks per frame offset only", () => {
    const cache = new MaskTextures(factory);
    const m = makeMask({ path: makeRectanglePath(0.1, 0.1, 0.9, 0.9) });
    m.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 1), makeKeyframe(10, 0)]);
    const masks = [m];
    cache.acquire(fakeGl, "k", masks, 3, 16, 16, 1, 1);
    cache.acquire(fakeGl, "k", masks, 3, 16, 16, 1, 2);
    cache.acquire(fakeGl, "k", masks, 4, 16, 16, 1, 3);
    expect(cache.rasterCount).toBe(2);
  });

  it("frees idle layers and returns null when nothing contributes", () => {
    const cache = new MaskTextures(factory);
    const empty = [makeMask({ path: makeMaskPath([]) })];
    expect(cache.acquire(fakeGl, "e", empty, 0, 8, 8, 1, 1)).toBeNull();
    cache.collect(fakeGl, 500, 120);
    expect(cache.acquire(fakeGl, "e", empty, 0, 8, 8, 1, 501)).toBeNull();
    expect(cache.rasterCount).toBe(2);
  });

  it("caps the raster size and scales feather accordingly", () => {
    const s = maskRasterSize(4096, 2048, 1);
    expect(s).toEqual({ w: 2048, h: 1024, pxScale: 0.5 });
    expect(maskRasterSize(100, 50, 0.5)).toEqual({ w: 50, h: 25, pxScale: 0.5 });
  });
});

describe("pathMath", () => {
  it("inserts a vertex on a segment without changing the curve ends", () => {
    const path = makeRectanglePath(0, 0, 1, 1);
    const hit = nearestOnPath(path, { x: 0.5, y: 0.01 });
    expect(hit?.segment).toBe(0);
    expect(hit?.t).toBeCloseTo(0.5, 1);
    const next = insertVertex(path, 0, hit?.t ?? 0.5);
    expect(next.vertices).toHaveLength(5);
    expect(next.vertices[1]?.y).toBeCloseTo(0, 5);
    expect(removeVertex(next, 1).vertices).toHaveLength(4);
    expect(removeVertex(path, 0).vertices.length).toBe(3);
    expect(removeVertex(removeVertex(path, 0), 0).vertices).toHaveLength(3);
  });

  it("mirrors the opposite tangent unless broken", () => {
    const path = makeRectanglePath(0, 0, 1, 1);
    const smooth = setTangent(path, 0, "out", { x: 0.2, y: 0 }, false);
    expect(smooth.vertices[0]).toMatchObject({ outX: 0.2, inX: -0.2 });
    const broken = setTangent(smooth, 0, "in", { x: 0, y: -0.3 }, true);
    expect(broken.vertices[0]).toMatchObject({ outX: 0.2, inY: -0.3, inX: 0 });
  });
});
