// `VoiceActivity.analysis(for:mediaRef:)`: cached sidecar, else stream-decode the first audio track (chunked mediabunny
// path), resample to 16 kHz mono and run VAD in 512-sample chunks. Never holds more than one decoded packet.
import { ALL_FORMATS, Input, UrlSource } from "mediabunny";
import { throwIfAborted } from "../media/concurrency";
import { mediaUrl } from "../media/mediaUrl";
import { makeLinearResampler, type LinearResampler } from "../media/peaks";
import { NoAudioTrackError, readMonoChunks } from "../media/waveform";
import {
  cacheAnalysis, cacheNoAudioAnalysis, cachedAnalysis, vadSampleRate, type VadEngine, type VoiceAnalysis,
} from "./voiceActivity";

export async function voiceActivityAnalysis(
  sourcePath: string,
  mediaRef: string,
  engine: VadEngine,
  signal?: AbortSignal,
): Promise<VoiceAnalysis> {
  const cached = await cachedAnalysis(sourcePath, mediaRef);
  if (cached) return cached;

  const input = new Input({ source: new UrlSource(mediaUrl(sourcePath)), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return await cacheNoAudioAnalysis(sourcePath, mediaRef);
    if (!(await track.canDecode())) throw new Error(`Audio codec not decodable in ${sourcePath}`);

    const run = await engine.begin(signal);
    try {
    let resampler: LinearResampler | undefined;
    // readMonoChunks takes a synchronous callback; chain the awaits so the worker sees chunks in order.
    let pending: Promise<void> = Promise.resolve();
    let batch: Float32Array[] = [];
    let batched = 0;
    const flush = (): void => {
      if (batched === 0) return;
      const samples = new Float32Array(batched);
      let at = 0;
      for (const part of batch) {
        samples.set(part, at);
        at += part.length;
      }
      batch = [];
      batched = 0;
      pending = pending.then(() => run.push(samples));
    };
    await readMonoChunks(track, undefined, signal, (mono, sampleRate) => {
      resampler ??= makeLinearResampler(sampleRate, vadSampleRate);
      const samples = resampler.push(mono);
      batch.push(samples);
      batched += samples.length;
      if (batched >= vadSampleRate) flush();
    });
    flush();
    await pending;
    throwIfAborted(signal);
    const analysis = await run.finish();
    await cacheAnalysis(analysis, sourcePath, mediaRef);
    return analysis;
    } finally {
      run.release();
    }
  } catch (e) {
    if (e instanceof NoAudioTrackError) return await cacheNoAudioAnalysis(sourcePath, mediaRef);
    throw e;
  } finally {
    input.dispose();
  }
}
