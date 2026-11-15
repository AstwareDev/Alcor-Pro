// Port of ToolExecutor+Denoise.swift: denoise_audio.
import { mutationResult, timelineSnapshot } from "../agent/tools/mutationDelta";
import { ToolError, decodeToolArgs } from "../agent/tools/toolArgs";
import type { ToolArgs, ToolContext } from "../agent/tools/toolRegistry";
import type { ToolResult } from "../agent/tools/toolResult";
import { setDenoise } from "../inspector/effectEdit";

interface DenoiseAudioInput {
  clipIds: string[];
  strength?: number;
  enabled?: boolean;
}

export function denoiseAudio({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<DenoiseAudioInput>(args, "denoise_audio", {
    clipIds: { spec: { array: "string" }, required: true },
    strength: { spec: "double" },
    enabled: { spec: "bool" },
  });
  if (input.clipIds.length === 0) throw new ToolError("clipIds is empty.");
  if (input.strength !== undefined && !(input.strength >= 0 && input.strength <= 1)) {
    throw new ToolError(`strength must be 0–1 (got ${input.strength})`);
  }
  for (const id of input.clipIds) {
    const clip = editor.clipFor(id);
    if (!clip) throw new ToolError(`Clip not found: ${id}`);
    if (clip.mediaType !== "audio") throw new ToolError(`Clip ${id} is a ${clip.mediaType} clip; denoise_audio needs an audio clip.`);
  }

  const enabled = input.enabled ?? true;
  const since = timelineSnapshot(editor);
  const actionName = enabled ? "Denoise Audio (Agent)" : "Disable Denoise (Agent)";
  editor.perform(actionName, () => {
    setDenoise(editor, new Set(input.clipIds), enabled, input.strength, actionName);
  });
  const notes = enabled ? ["Denoise bakes in the background; the preview picks it up automatically when it finishes."] : [];
  return mutationResult(editor, since, { touched: input.clipIds, notes });
}
