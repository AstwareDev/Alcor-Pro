// Port of Submission/MusicGenerationSubmission.swift.
import { makeGenerationInput, swiftDateNow } from "../model";
import type { Editor } from "../editor/editor";
import { finalizeGeneratingClip, placeGeneratingAudioClip, type TimelineSpan } from "../editor/mutations/generatedClips";
import { getGenerationService, type GenerationService } from "./generationService";
import type { AudioEntry } from "./modelConfig";
import type { AudioParams, LocalReference } from "./providers/types";
import { makeAudioSubmission } from "./submission";

export type MusicMode = "videoToMusic" | "textToMusic";
export type MusicPhase = "exporting" | "generating";
export const musicPhaseLabel: Record<MusicPhase, string> = { exporting: "Exporting…", generating: "Generating…" };

/** Seam for `TimelineRenderer.render` (240p, no audio): renders the span to a temp mp4 and returns its path. */
export const musicHooks: {
  renderTimelineSpan?: (editor: Editor, span: TimelineSpan, shortSide: number) => Promise<string>;
  removeTempFile?: (path: string) => Promise<void>;
} = {};

export async function runMusicGeneration(
  editor: Editor,
  p: {
    mode: MusicMode; model: AudioEntry; prompt?: string; source: TimelineSpan; spanSeconds: number; name?: string;
    onPhase?: (phase: MusicPhase) => void; onFinished?: () => void; service?: GenerationService;
  },
): Promise<void> {
  let video: LocalReference | undefined;
  let rendered: string | undefined;
  if (p.mode === "videoToMusic") {
    p.onPhase?.("exporting");
    if (!musicHooks.renderTimelineSpan) throw new Error("Rendering the timeline for video-to-music is not available yet.");
    rendered = await musicHooks.renderTimelineSpan(editor, p.source, 240);
    video = { path: rendered, type: "video", contentType: "video/mp4" };
  }
  const durationSeconds = Math.max(1, Math.round(p.spanSeconds));
  const params: AudioParams = {
    kind: "audio", prompt: p.prompt ?? "", instrumental: false, durationSeconds, ...(video ? { video } : {}),
  };
  const genInput = makeGenerationInput({
    prompt: p.prompt ?? "", model: p.model.id, duration: durationSeconds, aspectRatio: "",
    audioInput: p.mode === "textToMusic" ? "text" : "video", createdAt: swiftDateNow(),
  });
  const plan = makeAudioSubmission({ genInput, model: p.model, params, name: p.name ?? p.model.displayName });
  p.onPhase?.("generating");
  const id = (p.service ?? getGenerationService()).generate(editor, plan, {
    onComplete: (asset) => {
      finalizeGeneratingClip(editor, asset.id, asset);
      p.onFinished?.();
    },
    onFailure: () => p.onFinished?.(),
  });
  if (rendered !== undefined) void musicHooks.removeTempFile?.(rendered);
  placeGeneratingAudioClip(editor, id, p.source.startFrame, p.spanSeconds, "Add Music");
}
