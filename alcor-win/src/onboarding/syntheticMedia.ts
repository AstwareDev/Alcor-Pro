// Media made in code for the generated sample: a WAV arpeggio and flat or gradient PNGs. Nothing here is a binary in git.

const encoder = new TextEncoder();

function ascii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export interface Note {
  /** Seconds from the start. */
  at: number;
  seconds: number;
  hz: number;
  gain: number;
}

/** Mono 16-bit PCM WAV of decaying sine notes with a soft attack (no clicks), peak-limited to the note gains. */
export function synthWav(notes: readonly Note[], seconds: number, sampleRate = 22_050): Uint8Array {
  const frames = Math.round(seconds * sampleRate);
  const samples = new Float32Array(frames);
  const attack = 0.012 * sampleRate;
  for (const note of notes) {
    const start = Math.round(note.at * sampleRate);
    const length = Math.min(Math.round(note.seconds * sampleRate), frames - start);
    const step = (2 * Math.PI * note.hz) / sampleRate;
    for (let i = 0; i < length; i++) {
      const envelope = Math.min(1, i / attack) * Math.exp((-4 * i) / length);
      const value = Math.sin(step * i) + 0.25 * Math.sin(2 * step * i);
      samples[start + i] = (samples[start + i] ?? 0) + (note.gain * envelope * value) / 1.25;
    }
  }
  const out = new Uint8Array(44 + frames * 2);
  const view = new DataView(out.buffer);
  ascii(view, 0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  ascii(view, 8, "WAVE");
  ascii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(view, 36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(clamped * 32_767), true);
  }
  return out;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const v of bytes) {
    a = (a + v) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib stream of stored (uncompressed) deflate blocks: sample images are tiny, so no compressor is needed. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65_535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let pos = 2;
  for (let i = 0; i < blocks; i++) {
    const part = raw.subarray(i * 65_535, (i + 1) * 65_535);
    out[pos++] = i === blocks - 1 ? 1 : 0;
    out[pos++] = part.length & 0xff;
    out[pos++] = part.length >>> 8;
    out[pos++] = ~part.length & 0xff;
    out[pos++] = (~part.length >>> 8) & 0xff;
    out.set(part, pos);
    pos += part.length;
  }
  new DataView(out.buffer).setUint32(pos, adler32(raw));
  return out;
}

export type Rgb = readonly [number, number, number];

/** 8-bit RGB PNG whose pixel (x, y) is `pixel(x, y)`. */
export function synthPng(width: number, height: number, pixel: (x: number, y: number) => Rgb): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  let pos = 0;
  for (let y = 0; y < height; y++) {
    raw[pos++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[pos++] = r;
      raw[pos++] = g;
      raw[pos++] = b;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2; // truecolour
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
