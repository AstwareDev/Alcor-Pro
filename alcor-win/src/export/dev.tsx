import {
  ALL_FORMATS, AudioSampleSink, BlobSource, BufferTarget, CanvasSource, Input, Mp4OutputFormat, Output, QUALITY_HIGH,
  VideoSampleSink, type InputVideoTrack,
} from "mediabunny";
import { Show, createSignal, onMount } from "solid-js";
import { Editor, makeEditorDocument } from "../editor/editor";
import { makeStaticEffect } from "../model/effect";
import { makeMediaAsset, type MediaAsset } from "../model/mediaAsset";
import { makeRGBA, makeTextShadow, makeTextStyle } from "../model/textStyle";
import { makeClip, makeTimeline, makeTrack, makeTransform, type Timeline } from "../model/timeline";
import { buildFrameGraph, collectMediaLayers, type FrameGraphDocument, type FrameGraphOptions } from "../preview/frameGraph";
import { Compositor, type SourceFrame, type TextureProvider } from "../preview/renderer";
import { ExportDialog } from "./ExportDialog";
import { exportVideoToBuffer } from "./exportEngine";
import { videoCodecIsHDR, type VideoCodec, type ExportResolution } from "./exportOptions";
import { ExportCancelledError, type ExportJobSpec, type ExportProgress, type ExportReport } from "./exportTypes";

/* ?dev=export: procedural media -> worker export into a BufferTarget -> re-open and verify against the Compositor. */

interface Scenario {
  name: string;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  codec: VideoCodec;
  resolution: ExportResolution;
  audio: boolean;
}

async function encodeTestVideo(width: number, height: number, fps: number, seconds: number, hue: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const make = async (codec: "avc" | "vp9"): Promise<Blob> => {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, keyFrameInterval: 0.5 });
    output.addVideoTrack(source, { frameRate: fps });
    await output.start();
    for (let i = 0; i < fps * seconds; i++) {
      const t = i / fps;
      const g = ctx.createLinearGradient(0, 0, width, height);
      g.addColorStop(0, `hsl(${hue + t * 30}, 70%, 35%)`);
      g.addColorStop(1, `hsl(${hue + 120 + t * 30}, 70%, 60%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(width * (0.1 + 0.8 * (t / seconds)), height / 2 + Math.sin(t * 3) * height * 0.3, height * 0.08, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `bold ${Math.round(height / 8)}px sans-serif`;
      ctx.fillText(`${hue} f${i}`, width * 0.05, height * 0.15);
      await source.add(t, 1 / fps);
    }
    await output.finalize();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("no output");
    return new Blob([buffer], { type: "video/mp4" });
  };
  try {
    return await make("avc");
  } catch {
    return make("vp9");
  }
}

function toneWav(durationSec: number, freq: number): Blob {
  const rate = 48000, n = Math.round(rate * durationSec);
  const data = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); data.setUint32(4, 36 + n * 4, true); str(8, "WAVE"); str(12, "fmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 2, true);
  data.setUint32(24, rate, true); data.setUint32(28, rate * 4, true); data.setUint16(32, 4, true); data.setUint16(34, 16, true);
  str(36, "data"); data.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 0.5 * 32767);
    data.setInt16(44 + i * 4, v, true);
    data.setInt16(46 + i * 4, v, true);
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}

/** 800x800 quadrants: TL red, TR green, BL blue, BR yellow. */
async function quadrantPng(): Promise<Blob> {
  const c = new OffscreenCanvas(800, 800);
  const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const colors = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"];
  colors.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect((i % 2) * 400, Math.floor(i / 2) * 400, 400, 400);
  });
  return c.convertToBlob({ type: "image/png" });
}

interface Fixture {
  spec: ExportJobSpec;
  timeline: Timeline;
  doc: FrameGraphDocument;
  graphOptions: FrameGraphOptions;
  blobs: Map<string, Blob>;
}

async function buildFixture(s: Scenario): Promise<Fixture> {
  const { width, height, fps, seconds } = s;
  const [videoA, videoB, png] = await Promise.all([
    encodeTestVideo(width, height, fps, seconds, 200),
    encodeTestVideo(width, height, fps, seconds, 20),
    quadrantPng(),
  ]);
  const tone = toneWav(seconds, 440);
  const blobs = new Map<string, Blob>([["videoA", videoA], ["videoB", videoB], ["image", png], ["tone", tone]]);
  const asset = (id: string, type: MediaAsset["type"], w?: number, h?: number): MediaAsset => {
    const a = makeMediaAsset({ id, url: URL.createObjectURL(blobs.get(id) as Blob), type, name: id, duration: type === "image" ? 0 : seconds });
    if (w && h) {
      a.sourceWidth = w;
      a.sourceHeight = h;
    }
    a.hasAudio = type === "audio";
    return a;
  };
  const assets = [asset("videoA", "video", width, height), asset("videoB", "video", width, height), asset("image", "image", 800, 800), asset("tone", "audio")];
  const dur = fps * seconds;
  const square = height / width; // 800x800 image drawn as a square of 0.5 * canvas height
  const clip = (p: Parameters<typeof makeClip>[0]) => makeClip({ sourceClipType: p.mediaType ?? "video", ...p });
  const text = makeClip({
    mediaRef: "", mediaType: "text", sourceClipType: "text", startFrame: 0, durationFrames: dur,
    textContent: "EXPORT TEST",
    textStyle: makeTextStyle({ fontSize: 80, isBold: true, color: makeRGBA({ r: 1, g: 1, b: 1, a: 1 }), shadow: makeTextShadow({ enabled: true }) }),
    transform: makeTransform({ centerY: 0.85, width: 0.9, height: 0.2 }),
  });
  const timeline = makeTimeline({
    name: s.name, fps, width, height,
    tracks: [
      makeTrack({ type: "video", clips: [text] }),
      makeTrack({
        type: "video",
        clips: [clip({ mediaRef: "image", mediaType: "image", startFrame: 0, durationFrames: dur, transform: makeTransform({ centerX: 0.2, centerY: 0.5, width: 0.5 * square, height: 0.5 }) })],
      }),
      makeTrack({
        type: "video",
        clips: [clip({
          mediaRef: "videoB", startFrame: Math.round(fps * 0.5), durationFrames: Math.round(fps * 1.5),
          transform: makeTransform({ centerX: 0.75, centerY: 0.35, width: 0.4, height: 0.4 }),
          effects: [makeStaticEffect("color.saturation", { amount: 1.3 })],
        })],
      }),
      makeTrack({
        type: "video",
        clips: [clip({ mediaRef: "videoA", startFrame: 0, durationFrames: dur })],
      }),
      makeTrack({
        type: "audio",
        clips: [makeClip({ mediaRef: "tone", mediaType: "audio", sourceClipType: "audio", startFrame: 0, durationFrames: dur, fadeInFrames: fps, volume: 1 })],
      }),
    ],
  });
  const doc: FrameGraphDocument = { timelines: [timeline], mediaAssets: assets };
  return {
    spec: {
      timelines: [timeline],
      mediaAssets: assets,
      timelineId: timeline.id,
      missingMediaRefs: [],
      options: { codec: s.codec, resolution: s.resolution, includeAudio: s.audio },
    },
    timeline,
    doc,
    graphOptions: {},
    blobs,
  };
}

// MARK: - Reference render (the preview Compositor with random-access decoding)

class ReferenceProvider implements TextureProvider {
  frames = new Map<string, SourceFrame>();
  private readonly toClose: (VideoFrame | ImageBitmap)[] = [];
  private readonly sinks = new Map<string, Promise<VideoSampleSink | null>>();
  private readonly images = new Map<string, Promise<ImageBitmap>>();

  constructor(private readonly fixture: Fixture) {}

  media(layer: { key: string }): SourceFrame | null {
    return this.frames.get(layer.key) ?? null;
  }

  private sink(ref: string): Promise<VideoSampleSink | null> {
    let p = this.sinks.get(ref);
    if (!p) {
      p = (async () => {
        const input = new Input({ source: new BlobSource(this.fixture.blobs.get(ref) as Blob), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        return track ? new VideoSampleSink(track) : null;
      })();
      this.sinks.set(ref, p);
    }
    return p;
  }

  async prepare(frame: number): Promise<ReturnType<typeof buildFrameGraph>> {
    const graph = buildFrameGraph(this.fixture.doc, this.fixture.timeline.id, frame, this.fixture.graphOptions);
    this.frames = new Map();
    for (const layer of collectMediaLayers(graph.layers, [])) {
      if (layer.mediaType === "video") {
        const sink = await this.sink(layer.mediaRef);
        const sample = sink ? await sink.getSample(layer.sourceTime + 1e-4) : null;
        if (!sample) continue;
        const vf = sample.toVideoFrame();
        sample.close();
        this.toClose.push(vf);
        this.frames.set(layer.key, { source: vf, width: vf.displayWidth, height: vf.displayHeight, version: `${layer.key}@${frame}`, premultiplied: false });
      } else if (layer.mediaType === "image") {
        let p = this.images.get(layer.mediaRef);
        if (!p) {
          p = createImageBitmap(this.fixture.blobs.get(layer.mediaRef) as Blob);
          this.images.set(layer.mediaRef, p);
        }
        const bmp = await p;
        this.frames.set(layer.key, { source: bmp, width: bmp.width, height: bmp.height, version: layer.mediaRef, premultiplied: false });
      }
    }
    return graph;
  }

  release(): void {
    for (const f of this.toClose.splice(0)) f.close();
  }
}

type Rgb = [number, number, number];

function patch(data: Uint8ClampedArray | Uint8Array, w: number, cx: number, cy: number, r = 2): Rgb {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const i = (y * w + x) * 4;
      sr += data[i] as number; sg += data[i + 1] as number; sb += data[i + 2] as number; n += 1;
    }
  }
  return [sr / n, sg / n, sb / n];
}

const maxDiff = (a: Rgb, b: Rgb): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

async function decodeFrameRgba(track: InputVideoTrack, t: number): Promise<{ data: Uint8ClampedArray; w: number; h: number } | null> {
  const sample = await new VideoSampleSink(track).getSample(t + 1e-4);
  if (!sample) return null;
  const w = sample.displayWidth, h = sample.displayHeight;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  sample.draw(ctx, 0, 0);
  sample.close();
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function verify(s: Scenario, fx: Fixture, buffer: ArrayBuffer, report: ExportReport): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail: string): void => void results.push({ name, ok, detail });
  const input = new Input({ source: new BlobSource(new Blob([buffer])), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const total = fx.timeline.fps * s.seconds;
  if (!video) {
    check("video track", false, "missing");
    return results;
  }
  const duration = await input.computeDuration();
  check("duration", Math.abs(duration - s.seconds) <= 1 / s.fps + 0.02, `${duration.toFixed(3)}s (expected ${s.seconds}s)`);
  const stats = await video.computePacketStats(Infinity);
  check("frame count", stats.packetCount === total, `${stats.packetCount} (expected ${total})`);
  check("fps", Math.abs(stats.averagePacketRate - s.fps) < 0.5, `${stats.averagePacketRate.toFixed(2)} (expected ${s.fps})`);
  check("resolution", video.displayWidth === report.width && video.displayHeight === report.height, `${video.displayWidth}x${video.displayHeight} (report ${report.width}x${report.height})`);

  if (s.audio) {
    const audio = await input.getPrimaryAudioTrack();
    check("audio present", audio !== null, audio ? `${audio.codec} ${audio.sampleRate}Hz x${audio.numberOfChannels}` : "missing");
    if (audio) {
      const rms = async (from: number, to: number): Promise<number> => {
        let sum = 0, n = 0;
        for await (const sample of new AudioSampleSink(audio).samples(from, to)) {
          const data = new Float32Array(sample.numberOfFrames);
          sample.copyTo(data, { planeIndex: 0, format: "f32-planar" });
          for (const v of data) { sum += v * v; n += 1; }
          sample.close();
        }
        return n > 0 ? Math.sqrt(sum / n) : 0;
      };
      const start = await rms(0, 0.1);
      const mid = await rms(1.2, 1.4);
      const audioDuration = await audio.computeDuration();
      check("audio fade-in", mid > 0.2 && start < mid * 0.4, `rms start ${start.toFixed(3)}, mid ${mid.toFixed(3)} (tone 0.5 amplitude -> 0.35)`);
      check("audio duration", Math.abs(audioDuration - s.seconds) < 0.08, `${audioDuration.toFixed(3)}s`);
    }
  }

  // Pixels vs the preview compositor at the same size.
  const canvas = new OffscreenCanvas(report.width, report.height);
  const compositor = new Compositor(canvas);
  compositor.setScale(report.width / s.width);
  const ref = new ReferenceProvider(fx);
  const w = report.width, h = report.height;
  const points: { name: string; x: number; y: number }[] = [
    { name: "center", x: 0.5, y: 0.5 },
    { name: "upper right (video B pip)", x: 0.75, y: 0.3 },
    { name: "lower left", x: 0.1, y: 0.8 },
    { name: "upper left", x: 0.3, y: 0.15 },
  ];
  const frames = [0, Math.round(s.fps * 1), Math.round(s.fps * 2) - 1, total - 1];
  let worst = 0;
  const lines: string[] = [];
  for (const frame of frames) {
    const graph = await ref.prepare(frame);
    compositor.render(graph, ref);
    const expected = compositor.readPixels(0, 0, w, h);
    ref.release();
    const got = await decodeFrameRgba(video, frame / s.fps);
    if (!got) {
      check(`frame ${frame} decodes`, false, "no sample");
      continue;
    }
    for (const p of points) {
      const px = Math.round(p.x * (w - 1)), py = Math.round(p.y * (h - 1));
      const d = maxDiff(patch(got.data, w, px, py), patch(expected, w, px, py));
      worst = Math.max(worst, d);
      if (d > 32) lines.push(`frame ${frame} ${p.name}: diff ${d.toFixed(1)}`);
    }
  }
  check("pixels match compositor (<=32/255)", lines.length === 0, lines.length === 0 ? `worst channel diff ${worst.toFixed(1)}` : lines.join("; "));

  // Absolute: the quadrant image sits at x 0.2*W +- 0.25H, y 0.5H +- 0.25H.
  const got = await decodeFrameRgba(video, (total - 1) / s.fps);
  if (got) {
    const half = 0.25 * h / 2;
    const cx = 0.2 * w, cy = 0.5 * h;
    const expectations: [string, number, number, Rgb][] = [
      ["red", cx - half, cy - half, [255, 0, 0]],
      ["green", cx + half, cy - half, [0, 255, 0]],
      ["blue", cx - half, cy + half, [0, 0, 255]],
      ["yellow", cx + half, cy + half, [255, 255, 0]],
    ];
    for (const [name, x, y, rgb] of expectations) {
      const d = maxDiff(patch(got.data, w, Math.round(x), Math.round(y)), rgb);
      check(`known colour ${name}`, d <= 48, `diff ${d.toFixed(1)}`);
    }
  }
  compositor.dispose();
  input.dispose();
  return results;
}

interface ScenarioOutcome {
  scenario: string;
  report?: ExportReport;
  bytes?: number;
  exportSeconds?: number;
  realtimeFactor?: number;
  checks?: CheckResult[];
  error?: string;
}

async function runScenario(s: Scenario, setStatus: (t: string) => void): Promise<ScenarioOutcome> {
  try {
    setStatus(`${s.name}: building media`);
    const fx = await buildFixture(s);
    setStatus(`${s.name}: exporting`);
    const t0 = performance.now();
    let last: ExportProgress | undefined;
    const { report, buffer } = await exportVideoToBuffer(fx.spec, {
      onProgress: (p) => {
        last = p;
        setStatus(`${s.name}: ${p.phase} ${p.framesDone}/${p.totalFrames}`);
      },
    });
    const exportSeconds = (performance.now() - t0) / 1000;
    void last;
    setStatus(`${s.name}: verifying`);
    const checks = await verify(s, fx, buffer, report);
    return {
      scenario: s.name, report, bytes: buffer.byteLength, exportSeconds: +exportSeconds.toFixed(2),
      realtimeFactor: +(exportSeconds / s.seconds).toFixed(2), checks,
    };
  } catch (e) {
    return { scenario: s.name, error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) };
  }
}

/** Aborts mid-export: the promise must reject with ExportCancelledError and the worker must stop. */
async function runCancelScenario(): Promise<ScenarioOutcome> {
  const s: Scenario = { name: "cancel-640x360", width: 640, height: 360, fps: 30, seconds: 3, codec: "H.264", resolution: "Match Timeline", audio: true };
  try {
    const fx = await buildFixture(s);
    const controller = new AbortController();
    let sawProgress = 0;
    const started = performance.now();
    try {
      await exportVideoToBuffer(fx.spec, {
        signal: controller.signal,
        onProgress: (p) => {
          sawProgress = p.framesDone;
          if (p.framesDone >= 10) controller.abort();
        },
      });
      return { scenario: s.name, checks: [{ name: "cancel rejects", ok: false, detail: "export completed" }] };
    } catch (e) {
      const ms = Math.round(performance.now() - started);
      return {
        scenario: s.name,
        checks: [{ name: "cancel rejects with ExportCancelledError", ok: e instanceof ExportCancelledError, detail: `${(e as Error).name} after ${sawProgress} frames, ${ms} ms` }],
      };
    }
  } catch (e) {
    return { scenario: s.name, error: e instanceof Error ? e.message : String(e) };
  }
}

/** HEVC and VP9 are hardware / OS dependent: record success or the actionable error, never fail the run. */
async function runCodecProbe(codec: VideoCodec): Promise<ScenarioOutcome> {
  const s: Scenario = { name: `probe-${codec}`, width: 640, height: 360, fps: 30, seconds: 1, codec, resolution: "Match Timeline", audio: true };
  try {
    const fx = await buildFixture(s);
    const { report, buffer } = await exportVideoToBuffer(fx.spec);
    const checks: CheckResult[] = [{ name: "probe", ok: true, detail: `${report.videoCodec}/${report.audioCodec} ${report.container}` }];
    if (videoCodecIsHDR(codec)) {
      const input = new Input({ source: new BlobSource(new Blob([buffer])), formats: ALL_FORMATS });
      const video = await input.getPrimaryVideoTrack();
      const cs = video ? await video.getColorSpace() : null;
      const hdr = video ? await video.hasHighDynamicRange() : false;
      const codecString = video ? await video.getCodecParameterString() : null;
      checks.push({ name: "hdr tags", ok: hdr && String(cs?.primaries) === "bt2020" && String(cs?.transfer) === "hlg", detail: `${codecString} ${JSON.stringify(cs)} hdr=${hdr}` });
    }
    return { scenario: s.name, report, bytes: buffer.byteLength, checks };
  } catch (e) {
    return { scenario: s.name, checks: [{ name: "probe", ok: true, detail: `unavailable: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

/** `&view=dialog`: mounts the real ExportDialog on a small in-memory document (visual check, no Tauri). */
function DialogPreview() {
  const [editor, setEditor] = createSignal<Editor | null>(null);
  onMount(async () => {
    const fx = await buildFixture({ name: "Demo Timeline", width: 640, height: 360, fps: 30, seconds: 2, codec: "H.264", resolution: "Match Timeline", audio: true });
    const doc = makeEditorDocument();
    doc.timelines = [fx.timeline, makeTimeline({ name: "Second Timeline", fps: 24, width: 1080, height: 1920 })];
    doc.activeTimelineId = fx.timeline.id;
    doc.mediaAssets = fx.doc.mediaAssets ? [...fx.doc.mediaAssets] : [];
    const e = new Editor(doc);
    e.ui.showExportDialog = true;
    setEditor(e);
  });
  return <Show when={editor()}>{(e) => <ExportDialog editor={e()} />}</Show>;
}

export default function ExportDevPage() {
  if (new URLSearchParams(location.search).get("view") === "dialog") return <DialogPreview />;
  const [status, setStatus] = createSignal("Starting");
  let results: HTMLPreElement | undefined;
  onMount(async () => {
    const params = new URLSearchParams(location.search);
    const only = params.get("only");
    const scenarios: Scenario[] = [
      { name: "correctness-640x360-h264", width: 640, height: 360, fps: 30, seconds: 3, codec: "H.264", resolution: "Match Timeline", audio: true },
      { name: "perf-1080p30-h264", width: 1920, height: 1080, fps: 30, seconds: 4, codec: "H.264", resolution: "Match Timeline", audio: true },
    ].filter((s) => (!only || s.name.includes(only)) && only !== "extra") as Scenario[];
    const outcomes: ScenarioOutcome[] = [];
    for (const s of scenarios) outcomes.push(await runScenario(s, setStatus));
    if (!only || only === "extra") {
      setStatus("cancel");
      outcomes.push(await runCancelScenario());
      for (const codec of ["H.265", "VP9", "HEVC 10-bit HDR", "VP9 10-bit HDR"] as const) {
        setStatus(`probe ${codec}`);
        outcomes.push(await runCodecProbe(codec));
      }
    }
    const ok = outcomes.every((o) => o.error === undefined && (o.checks ?? []).every((c) => c.ok));
    const summary = JSON.stringify({ ok, outcomes }, null, 1);
    if (results) results.textContent = summary;
    setStatus(ok ? "PASS" : "FAIL");
    console.log("EXPORT_DEV_RESULTS", summary);
  });
  return (
    <div style={{ padding: "16px", color: "var(--text-primary)", "font-family": "monospace" }}>
      <div id="status">{status()}</div>
      <pre id="results" ref={results} style={{ "white-space": "pre-wrap", "user-select": "text" }} />
    </div>
  );
}
