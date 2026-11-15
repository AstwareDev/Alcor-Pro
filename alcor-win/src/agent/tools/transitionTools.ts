import { addAdjustmentLayer } from "../../editor/mutations/adjustmentLayer";
import {
  addTransitionAfterClip, cutAfterClip, findTransition, removeTransition, updateTransition,
  type TransitionResult, type TransitionSpec,
} from "../../editor/mutations/transitions";
import { transitionAlignments, transitionKinds, type Transition } from "../../model/transition";
import { swiftRound } from "../../util/math";
import { jsonString } from "./jsonFormat";
import { ToolError, decodeToolArgs } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

interface SpecArgs { kind?: string; durationSeconds?: number; durationFrames?: number; alignment?: string }

const specFields = {
  kind: { spec: "string" },
  durationSeconds: { spec: "double" },
  durationFrames: { spec: "int" },
  alignment: { spec: "string" },
} as const;

function parseSpec(a: SpecArgs, fps: number): TransitionSpec {
  const spec: TransitionSpec = {};
  if (a.kind !== undefined) {
    const kind = transitionKinds.find((k) => k === a.kind);
    if (!kind) throw new ToolError(`kind: expected one of ${transitionKinds.join(", ")}.`);
    spec.kind = kind;
  }
  if (a.alignment !== undefined) {
    const alignment = transitionAlignments.find((k) => k === a.alignment);
    if (!alignment) throw new ToolError(`alignment: expected one of ${transitionAlignments.join(", ")}.`);
    spec.alignment = alignment;
  }
  if (a.durationFrames !== undefined) {
    if (a.durationFrames < 1) throw new ToolError("durationFrames: must be at least 1.");
    spec.durationFrames = a.durationFrames;
  } else if (a.durationSeconds !== undefined) {
    if (!(a.durationSeconds > 0)) throw new ToolError("durationSeconds: must be greater than 0.");
    spec.durationFrames = Math.max(1, swiftRound(a.durationSeconds * fps));
  }
  return spec;
}

function summary(t: Transition, fps: number): Record<string, unknown> {
  return {
    transitionId: t.id, fromClipId: t.fromClipId, toClipId: t.toClipId, kind: t.kind, alignment: t.alignment,
    durationFrames: t.durationFrames, durationSeconds: Math.round((t.durationFrames / fps) * 1000) / 1000,
  };
}

function unwrap(result: TransitionResult, fps: number): ToolResult {
  if (!result.ok) throw new ToolError(result.reason);
  return ok(jsonString(summary(result.transition, fps)));
}

function resolveId({ editor }: ToolContext, a: { clipId?: string; transitionId?: string }, tool: string): string {
  if (a.transitionId !== undefined) {
    if (!findTransition(editor, a.transitionId)) throw new ToolError(`Transition not found: ${a.transitionId}`);
    return a.transitionId;
  }
  if (a.clipId === undefined) throw new ToolError(`${tool}: provide clipId or transitionId.`);
  const cut = cutAfterClip(editor, a.clipId);
  if (!cut?.transition) throw new ToolError(`No transition at the end of clip ${a.clipId}.`);
  return cut.transition.id;
}

export function addTransitionTool({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const a = decodeToolArgs<SpecArgs & { clipId: string }>(args, "add_transition", { clipId: { spec: "string", required: true }, ...specFields });
  const spec = parseSpec(a, editor.timeline.fps);
  return unwrap(addTransitionAfterClip(editor, a.clipId, spec), editor.timeline.fps);
}

export function updateTransitionTool(context: ToolContext, args: ToolArgs): ToolResult {
  const a = decodeToolArgs<SpecArgs & { clipId?: string; transitionId?: string }>(args, "update_transition", {
    clipId: { spec: "string" }, transitionId: { spec: "string" }, ...specFields,
  });
  const { editor } = context;
  const spec = parseSpec(a, editor.timeline.fps);
  if (Object.keys(spec).length === 0) throw new ToolError("update_transition: provide kind, duration or alignment.");
  return unwrap(updateTransition(editor, resolveId(context, a, "update_transition"), spec), editor.timeline.fps);
}

export function removeTransitionTool(context: ToolContext, args: ToolArgs): ToolResult {
  const a = decodeToolArgs<{ clipId?: string; transitionId?: string }>(args, "remove_transition", {
    clipId: { spec: "string" }, transitionId: { spec: "string" },
  });
  const id = resolveId(context, a, "remove_transition");
  removeTransition(context.editor, id);
  return ok(jsonString({ removed: id }));
}

export function addAdjustmentLayerTool({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const a = decodeToolArgs<{ startFrame?: number; durationSeconds?: number; durationFrames?: number; trackIndex?: number }>(args, "add_adjustment_layer", {
    startFrame: { spec: "int" }, durationSeconds: { spec: "double" }, durationFrames: { spec: "int" }, trackIndex: { spec: "int" },
  });
  if (a.startFrame !== undefined && a.startFrame < 0) throw new ToolError("startFrame: must be 0 or greater.");
  const durationFrames = a.durationFrames ?? (a.durationSeconds !== undefined ? swiftRound(a.durationSeconds * editor.timeline.fps) : undefined);
  if (durationFrames !== undefined && durationFrames < 1) throw new ToolError("The duration must be at least one frame.");
  const id = addAdjustmentLayer(editor, {
    ...(a.startFrame !== undefined ? { startFrame: a.startFrame } : {}),
    ...(durationFrames !== undefined ? { durationFrames } : {}),
    ...(a.trackIndex !== undefined ? { trackIndex: a.trackIndex } : {}),
  });
  if (id === undefined) throw new ToolError("trackIndex: must be a video track that is free over the span.");
  const clip = editor.clipFor(id);
  return ok(jsonString({ clipId: id, startFrame: clip?.startFrame, durationFrames: clip?.durationFrames }));
}
