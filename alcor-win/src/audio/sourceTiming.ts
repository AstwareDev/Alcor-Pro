import type { Editor } from "../editor/editor";
import { extractAudioEnvelope, type TimeRange } from "../media/waveform";
import { isAbortError } from "../media/concurrency";
import type { AudioEnvelope } from "../media/peaks";
import { seededCorrelateInWorker } from "./audioSyncClient";
import type { CorrelationResult, SeededCorrelateParams } from "./audioSyncCorrelator";

/** `SourceTimecode`: only the wall-clock start in seconds is needed to align clips. */
export interface SourceTimecode {
  seconds: number;
}

/** `SourceTiming`: embedded timecode and/or recording-start capture date (epoch seconds). */
export interface SourceTiming {
  timecode?: SourceTimecode;
  captureDate?: number;
}

/** Everything the sync algorithms need from the outside world, injectable so tests run without media. */
export interface SyncServices {
  /** Null when the asset has no readable audio. Rethrows aborts. */
  envelope(mediaRef: string, range: TimeRange | undefined, signal?: AbortSignal): Promise<AudioEnvelope | null>;
  timing(mediaRef: string): Promise<SourceTiming>;
  correlate(params: SeededCorrelateParams, signal?: AbortSignal): Promise<CorrelationResult | null>;
}

/**
 * Production services. Embedded timecode and capture-date reading (`SourceTimingReader`: tmcd/rtmd/BWF atoms and
 * the QuickTime creation date) is not ported, so every file reports no timing and sync falls back to audio.
 */
export function editorSyncServices(editor: Editor): SyncServices {
  return {
    async envelope(mediaRef, range, signal) {
      const asset = editor.mediaAsset(mediaRef);
      if (!asset) return null;
      try {
        const envelope = await extractAudioEnvelope(asset.url, range, signal);
        return envelope.samples.length === 0 ? null : envelope;
      } catch (e) {
        if (isAbortError(e)) throw e;
        return null;
      }
    },
    timing: async () => ({}),
    correlate: seededCorrelateInWorker,
  };
}
