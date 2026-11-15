import type { Editor } from "./editor/editor";
import { aiTransitionHooks } from "./editor/mutations/aiTransition";
import { captureFrameToMedia } from "./agent/tools/captureTools";
import { generationHooks } from "./generation/generationState";
import { projectSessionIfOpen } from "./project/projectSession";

/**
 * Wires the module-level hook seams that Swift sets on `EditorViewModel` / `AppNotifications`.
 * Call once per open editor; the returned function removes only what this call installed.
 */
export function installEditorIntegrations(editor: Editor): () => void {
  const checkpointRequired = (target: Editor): void => {
    if (target === editor) projectSessionIfOpen(editor)?.requestCheckpoint();
  };
  const generationComplete = (target: Editor, asset: { name: string; type: string }, count: number): void => {
    if (target !== editor) return;
    editor.showToast(generationCompleteMessage(asset.name, asset.type, count), "info");
  };
  const captureTimelineFrame = async (target: Editor, frame: number, name: string) =>
    (await captureFrameToMedia(target, { kind: "timeline", frame }, name)).asset;

  const prior = {
    checkpointRequired: generationHooks.checkpointRequired,
    generationComplete: generationHooks.generationComplete,
    captureTimelineFrame: aiTransitionHooks.captureTimelineFrame,
  };
  // Hooks are shared across editors; chain to whatever was installed before so a second editor keeps working.
  generationHooks.checkpointRequired = (e) => { checkpointRequired(e); if (e !== editor) prior.checkpointRequired?.(e); };
  generationHooks.generationComplete = (e, a, n) => { generationComplete(e, a, n); if (e !== editor) prior.generationComplete?.(e, a, n); };
  aiTransitionHooks.captureTimelineFrame = captureTimelineFrame;

  return () => {
    generationHooks.checkpointRequired = prior.checkpointRequired;
    generationHooks.generationComplete = prior.generationComplete;
    aiTransitionHooks.captureTimelineFrame = prior.captureTimelineFrame;
  };
}

/** `AppNotifications.generationBody`. */
export function generationCompleteMessage(name: string, type: string, count: number): string {
  if (count > 1) {
    const noun = type === "audio" ? "audio clips" : type === "image" ? "images" : type === "text" ? "text clips" : type === "lottie" ? "Lottie animations" : type === "subtitle" ? "subtitle files" : "videos";
    return `${count} ${noun} are ready.`;
  }
  const trimmed = name.trim();
  if (trimmed !== "") return `${trimmed} is ready.`;
  return type === "audio" ? "Your audio clip is ready." : type === "image" ? "Your image is ready." : "Your video is ready.";
}
