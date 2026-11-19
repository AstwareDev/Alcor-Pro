// Port of Editor/Tour/TourController.swift's step model. The AI-edit and generation-panel steps are not ported (the
// Alcor panels differ); the prompt bar and export button stand in for the Swift's element anchors.

export type TourPanel = "media" | "preview" | "timeline" | "inspector";
export type TourTarget = TourPanel | "promptBar" | "export";

export interface TourStep {
  kind: "intro" | "spotlight" | "outro";
  target?: TourTarget;
  title: string;
  instruction: string;
}

export const tourSteps: readonly TourStep[] = [
  { kind: "intro", title: "Tutorial", instruction: "Let's take a quick tour of the workspace and what you can do." },
  { kind: "spotlight", target: "media", title: "Media panel", instruction: "This is where all your footage and assets live. Import, drag and drop, or generate new media here." },
  { kind: "spotlight", target: "preview", title: "Preview", instruction: "Play a selected media item or the whole timeline here." },
  { kind: "spotlight", target: "timeline", title: "Timeline", instruction: "The top half is video, the bottom half is audio. This is where you edit." },
  { kind: "spotlight", target: "promptBar", title: "Prompt bar", instruction: "Describe what you want and generate video, images or audio straight into your project." },
  { kind: "spotlight", target: "inspector", title: "Inspector", instruction: "Your inspector for the selected clip: transform, adjust, audio, and more." },
  { kind: "spotlight", target: "export", title: "Export", instruction: "When you are done, export your timeline to a video file." },
  { kind: "outro", title: "You're all set", instruction: "Start creating, or explore these to get the most out of Alcor Pro." },
];

export const tourSpotlightCount = tourSteps.filter((s) => s.kind === "spotlight").length;

/** The panel that must be visible for `target` to have a frame. Only media and inspector can be hidden. */
export function hostPanel(target: TourTarget): TourPanel | undefined {
  switch (target) {
    case "media": case "preview": case "inspector": case "timeline": return target;
    case "promptBar": return "timeline";
    case "export": return undefined;
  }
}

export function tourSelector(target: TourTarget): string {
  switch (target) {
    case "media": case "preview": case "inspector": return `[data-panel="${target}"]`;
    case "timeline": case "promptBar": case "export": return `[data-tour="${target}"]`;
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export const calloutWidth = 320;
export const calloutMargin = 24;
/** Generous height estimate so the card's full extent stays on screen after clamping. */
export const calloutHeightEstimate = 220;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Centre point for the spotlight card: right of the frame, else left, else above, else below (`calloutPosition`). */
export function calloutPosition(frame: Rect | null, size: Size): { x: number; y: number } {
  const half = calloutHeightEstimate / 2;
  const clampY = (y: number): number => clamp(y, half + calloutMargin, size.height - half - calloutMargin);
  const clampX = (x: number): number => clamp(x, calloutWidth / 2 + calloutMargin, size.width - calloutWidth / 2 - calloutMargin);
  if (!frame) return { x: size.width / 2, y: size.height / 2 };
  const neededX = calloutWidth + calloutMargin * 2;
  const midY = frame.y + frame.height / 2;
  if (size.width - (frame.x + frame.width) > neededX) return { x: frame.x + frame.width + calloutMargin + calloutWidth / 2, y: clampY(midY) };
  if (frame.x > neededX) return { x: frame.x - calloutMargin - calloutWidth / 2, y: clampY(midY) };
  const x = clampX(frame.x + frame.width / 2);
  if (frame.y > calloutHeightEstimate + calloutMargin * 2) return { x, y: clampY(frame.y - calloutMargin - half) };
  return { x, y: clampY(frame.y + frame.height + calloutMargin + half) };
}
