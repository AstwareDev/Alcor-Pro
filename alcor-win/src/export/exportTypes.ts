import type { MediaAsset } from "../model/mediaAsset";
import type { Timeline } from "../model/timeline";
import type { VideoExportOptions } from "./exportOptions";

/** Everything the render pipeline needs, as structured-cloneable plain data (it is posted to a Worker). */
export interface ExportJobSpec {
  /** Every timeline of the document: nested timelines resolve through this list. */
  timelines: Timeline[];
  /** Slim assets whose `url` is directly fetchable (asset-protocol or blob URL). */
  mediaAssets: MediaAsset[];
  timelineId: string;
  missingMediaRefs: string[];
  /** Media refs whose denoised twin is attached as a `denoise:<ref>` asset (see denoise/exportWet.ts). */
  wetMediaRefs?: string[];
  options: VideoExportOptions;
}

export type ExportPhaseName = "preparing" | "rendering" | "finalizing";

export interface ExportProgress {
  phase: ExportPhaseName;
  framesDone: number;
  totalFrames: number;
  /** 0...1 */
  fraction: number;
  /** Seconds remaining, once enough frames have been timed. */
  etaSeconds?: number;
}

export interface ExportReport {
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSeconds: number;
  videoCodec: string;
  audioCodec: string | null;
  container: "mp4" | "webm";
  /** Wall-clock seconds spent rendering + encoding. */
  elapsedSeconds: number;
  /** Non-fatal problems: skipped media, codec fallbacks. */
  warnings: string[];
}

export type ExportTargetKind = "stream" | "buffer";

export type MainToWorker =
  | { type: "start"; spec: ExportJobSpec; target: ExportTargetKind }
  | { type: "cancel" }
  | { type: "ack"; id: number; error?: string };

export type WorkerToMain =
  | { type: "progress"; progress: ExportProgress }
  | { type: "write"; id: number; position: number; data: Uint8Array }
  | { type: "done"; report: ExportReport; buffer?: ArrayBuffer }
  | { type: "error"; message: string; cancelled: boolean };

/** Thrown for failures whose message is already actionable. */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelledError";
  }
}
