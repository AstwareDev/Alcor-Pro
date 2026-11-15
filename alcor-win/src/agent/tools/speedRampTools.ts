import { applySpeedRampPreset, setFrameBlending, setSpeedRampPoints, validateSpeedRampPoints, type SpeedRampPoint } from "../../editor/mutations/speedRamp";
import { clipHasSpeedRamp, clipSupportsRetiming, speedRampPresets, speedRampRange } from "../../model";
import { kfBezier, kfDouble, kfInt, kfInterp } from "./clipPropertyTools";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import { ToolError, decodeToolArgs } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";

export const speedRampPresetIds = speedRampPresets.map((p) => p.id);

function parsePoints(rows: unknown[]): SpeedRampPoint[] {
  return rows.map((raw, i) => {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) {
      throw new ToolError(`keyframes[${i}]: expected [frame, speed, interp?, bezier?]`);
    }
    const interpolation = kfInterp(raw.length > 2 ? raw[2] : undefined, `keyframes[${i}][2] (interp)`);
    const bezier = kfBezier(raw.length > 3 ? raw[3] : undefined, interpolation, `keyframes[${i}][3] (bezier)`);
    const point: SpeedRampPoint = { frame: kfInt(raw[0], `keyframes[${i}][0] (frame)`), speed: kfDouble(raw[1], `keyframes[${i}][1] (speed)`), interpolation };
    if (bezier) point.bezier = bezier;
    return point;
  });
}

/** MCP `set_speed_ramp`: time remapping by preset or explicit speed keyframes, plus the frame-blending flag. */
export function setSpeedRamp({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<{ clipId: string; preset?: string; frameBlending?: boolean }>(args, "set_speed_ramp", {
    clipId: { spec: "string", required: true },
    preset: { spec: "string" },
    keyframes: { spec: "any" },
    frameBlending: { spec: "bool" },
  });
  const rows = args.keyframes;
  if (rows !== undefined && !Array.isArray(rows)) throw new ToolError("keyframes must be an array");
  if (input.preset === undefined && rows === undefined && input.frameBlending === undefined) {
    throw new ToolError("Pass at least one of preset, keyframes or frameBlending");
  }
  if (input.preset !== undefined && rows !== undefined) throw new ToolError("Pass either preset or keyframes, not both");
  const clip = editor.clipFor(input.clipId);
  if (!clip) throw new ToolError(`Clip not found: ${input.clipId}`);
  if (!clipSupportsRetiming(clip)) throw new ToolError(`Clip ${input.clipId} cannot be retimed.`);
  if (clip.multicamGroupId !== undefined) throw new ToolError("Speed ramps are refused on multicam clips — they would slip out of sync with the group.");
  if (input.preset !== undefined && input.preset !== "none" && !speedRampPresetIds.includes(input.preset)) {
    throw new ToolError(`Unknown preset '${input.preset}'. Expected one of: none, ${speedRampPresetIds.join(", ")}`);
  }
  const points = rows === undefined ? undefined : parsePoints(rows);
  if (points) {
    const problem = validateSpeedRampPoints(points, clip.durationFrames);
    if (problem) throw new ToolError(`keyframes: ${problem}`);
  }

  const snapshot = timelineSnapshot(editor);
  const touched = new Set<string>();
  const notes: string[] = [];
  if (input.preset !== undefined) {
    for (const id of applySpeedRampPreset(editor, [input.clipId], input.preset === "none" ? undefined : input.preset)) touched.add(id);
    notes.push(input.preset === "none" ? "Removed the speed ramp." : `Applied the ${input.preset} ramp; the clip keeps its length and source range.`);
  } else if (points) {
    for (const id of setSpeedRampPoints(editor, [input.clipId], points)) touched.add(id);
    notes.push(points.length === 0 ? "Removed the speed ramp." : "Set the speed ramp; speed now averages over the clip, trimEnd adjusted to keep the source range.");
  }
  if (input.frameBlending !== undefined) {
    setFrameBlending(editor, [input.clipId], input.frameBlending);
    touched.add(input.clipId);
  }
  const after = editor.clipFor(input.clipId);
  if (after && clipHasSpeedRamp(after)) notes.push(`Speed range ${speedRampRange.min}-${speedRampRange.max}x; clip speed (mean) is ${after.speed.toFixed(3)}x.`);
  return mutationResult(editor, snapshot, { touched: [...touched], notes });
}
