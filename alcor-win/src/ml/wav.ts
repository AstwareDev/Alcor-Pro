// Minimal IEEE-float WAV (format 3) writer: the denoised "wet" audio is written as 32-bit float WAV, streamed in blocks.

export const wavHeaderBytes = 44;

export function wavHeader(frames: number, channels: number, sampleRate: number): Uint8Array {
  const dataBytes = frames * channels * 4;
  const header = new Uint8Array(wavHeaderBytes);
  const v = new DataView(header.buffer);
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < 4; i++) header[offset + i] = text.charCodeAt(i);
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE float
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 4, true);
  v.setUint16(32, channels * 4, true);
  v.setUint16(34, 32, true);
  tag(36, "data");
  v.setUint32(40, dataBytes, true);
  return header;
}

/** Interleaves `count` frames starting at `start` from planar channels into little-endian float32 bytes. */
export function interleaveFloat32(planes: readonly Float32Array[], start: number, count: number): Uint8Array {
  const channels = planes.length;
  const out = new Float32Array(count * channels);
  for (let c = 0; c < channels; c++) {
    const plane = planes[c] as Float32Array;
    for (let i = 0; i < count; i++) out[i * channels + c] = plane[start + i] as number;
  }
  return new Uint8Array(out.buffer);
}

export interface WavInfo {
  frames: number;
  channels: number;
  sampleRate: number;
}

/** Parses the header written by `wavHeader`; undefined for anything else. */
export function parseWavHeader(bytes: Uint8Array): WavInfo | undefined {
  if (bytes.length < wavHeaderBytes) return undefined;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (o: number): string => String.fromCharCode(bytes[o] as number, bytes[o + 1] as number, bytes[o + 2] as number, bytes[o + 3] as number);
  if (text(0) !== "RIFF" || text(8) !== "WAVE" || text(12) !== "fmt " || text(36) !== "data" || v.getUint16(20, true) !== 3) return undefined;
  const channels = v.getUint16(22, true);
  if (channels === 0) return undefined;
  return { frames: v.getUint32(40, true) / (channels * 4), channels, sampleRate: v.getUint32(24, true) };
}
