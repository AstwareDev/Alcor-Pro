// Port of ToolExecutor+Beats.swift: detect_beats.
import { mediaIo } from "../media/io";
import { jsonString } from "../agent/tools/jsonFormat";
import { ToolError, argDouble, requireString, validateUnknownKeys } from "../agent/tools/toolArgs";
import type { ToolArgs, ToolContext } from "../agent/tools/toolRegistry";
import { ok, type ToolResult } from "../agent/tools/toolResult";
import { estimateBPM } from "./beatInference";
import { beatStore } from "./beatState";

const detectBeatsAllowedKeys = ["mediaRef", "startSeconds", "endSeconds"];

/** `String(format: "%.2f")` as a JSON number. */
const r2 = (t: number): number => Number(t.toFixed(2));

const windowed = (times: readonly number[], range: [number, number] | undefined): number[] =>
  range ? times.filter((t) => t >= range[0] && t <= range[1]) : [...times];

function beatsRange(args: ToolArgs, duration: number): [number, number] | undefined {
  const start = argDouble(args, "startSeconds");
  const end = argDouble(args, "endSeconds");
  if (start === undefined && end === undefined) return undefined;
  const s = Math.max(start ?? 0, 0);
  const e = Math.min(end ?? duration, duration);
  if (!(s < e)) throw new ToolError(`Invalid time range [${s}, ${e}] for media of duration ${duration}s`);
  return [s, e];
}

export async function detectBeats({ editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, detectBeatsAllowedKeys, "detect_beats");
  const mediaRef = requireString(args, "mediaRef");
  const asset = editor.mediaAsset(mediaRef);
  if (!asset) throw new ToolError(`Media asset not found: ${mediaRef}`);
  if (!(asset.type === "audio" || (asset.type === "video" && asset.hasAudio))) {
    throw new ToolError(`detect_beats needs audio: ${mediaRef} is ${asset.type}${asset.type === "video" ? " with no audio track" : ""}.`);
  }
  if (!(await (await mediaIo()).stat(asset.url))) throw new ToolError(`Media file not on disk: ${asset.url.split(/[\\/]/).pop() ?? asset.url}`);

  // The shared store de-duplicates concurrent detection of one asset.
  const analysis = await beatStore.detect(asset);

  if (analysis.beats.length === 0 && analysis.downbeats.length === 0) {
    return ok('{"beats":[],"note":"No beats found — the audio may lack rhythmic content."}');
  }
  const range = beatsRange(args, asset.duration);
  const beats = windowed(analysis.beats, range);
  const downbeats = windowed(analysis.downbeats, range);
  if (range && beats.length === 0 && downbeats.length === 0) {
    return ok('{"beats":[],"note":"No beats in the requested window; the track has beats elsewhere — widen or drop startSeconds/endSeconds."}');
  }
  const out: Record<string, unknown> = {
    mediaRef,
    units: "source seconds — multiply by fps for frame values",
    beats: beats.map(r2),
  };
  if (downbeats.length > 0) out.downbeats = downbeats.map(r2);
  const bpm = range === undefined ? analysis.bpm : (estimateBPM(beats) ?? 0);
  if (bpm > 0) out.bpm = Number(bpm.toFixed(1));
  return ok(jsonString(out));
}
