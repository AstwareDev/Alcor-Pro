// Port of Search/Indexing/EmbeddingStore.swift: per-asset frame embeddings cached on disk, keyed by file identity
// (path + mtime + size). Format: magic + u32 header length + JSON header + rows of (time, shotStart, shotEnd) f64 + dim f16.
import { diskCacheDirectory } from "../media/diskCache";
import { mediaIo, type MediaIo } from "../media/io";
import { joinPath } from "../model";

export interface EmbeddingHeader {
  model: string;
  modelVersion: number;
  samplerVersion: number;
  dim: number;
  count: number;
}

export interface EmbeddingRow {
  time: number;
  shotStart: number;
  shotEnd: number;
}

export interface AssetIndex {
  header: EmbeddingHeader;
  rows: EmbeddingRow[];
  /** Flat count x dim. */
  vectors: Float32Array;
}

export class CorruptEmbeddingError extends Error {
  constructor() {
    super("Embedding file is corrupt.");
    this.name = "CorruptEmbeddingError";
  }
}

const magic = new TextEncoder().encode("PALMEMB1");
const prefixBytes = magic.length + 4;

const scratch = new DataView(new ArrayBuffer(4));

export function toHalf(value: number): number {
  scratch.setFloat32(0, value);
  const x = scratch.getUint32(0);
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rest = mant & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (rest > halfway || (rest === halfway && (half & 1))) half++;
    return sign | half;
  }
  let half = sign | (e << 10) | (mant >>> 13);
  const round = mant & 0x1fff;
  if (round > 0x1000 || (round === 0x1000 && (half & 1))) half++;
  return half;
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

export function encodeIndex(header: EmbeddingHeader, rows: readonly EmbeddingRow[], vectors: Float32Array): Uint8Array {
  if (rows.length !== header.count || vectors.length !== header.count * header.dim) throw new Error("Embedding rows do not match the header.");
  const json = new TextEncoder().encode(JSON.stringify(header));
  const rowBytes = 24 + header.dim * 2;
  const out = new Uint8Array(prefixBytes + json.length + header.count * rowBytes);
  const view = new DataView(out.buffer);
  out.set(magic, 0);
  view.setUint32(magic.length, json.length, true);
  out.set(json, prefixBytes);
  let at = prefixBytes + json.length;
  rows.forEach((row, i) => {
    view.setFloat64(at, row.time, true);
    view.setFloat64(at + 8, row.shotStart, true);
    view.setFloat64(at + 16, row.shotEnd, true);
    for (let d = 0; d < header.dim; d++) view.setUint16(at + 24 + d * 2, toHalf(vectors[i * header.dim + d] as number), true);
    at += rowBytes;
  });
  return out;
}

function hasMagic(bytes: Uint8Array): boolean {
  return bytes.length >= prefixBytes && magic.every((b, i) => bytes[i] === b);
}

function parseHeader(bytes: Uint8Array): { header: EmbeddingHeader; end: number } | undefined {
  if (!hasMagic(bytes)) return undefined;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(magic.length, true);
  if (bytes.length < prefixBytes + len) return undefined;
  try {
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(prefixBytes, prefixBytes + len))) as EmbeddingHeader;
    return { header, end: prefixBytes + len };
  } catch {
    return undefined;
  }
}

export function decodeHeader(bytes: Uint8Array): EmbeddingHeader | undefined {
  return parseHeader(bytes)?.header;
}

export function decodeIndex(bytes: Uint8Array): AssetIndex {
  const parsed = parseHeader(bytes);
  if (!parsed) throw new CorruptEmbeddingError();
  const { header, end } = parsed;
  const rowBytes = 24 + header.dim * 2;
  if (bytes.length !== end + header.count * rowBytes) throw new CorruptEmbeddingError();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rows: EmbeddingRow[] = [];
  const vectors = new Float32Array(header.count * header.dim);
  for (let i = 0; i < header.count; i++) {
    const base = end + i * rowBytes;
    rows.push({ time: view.getFloat64(base, true), shotStart: view.getFloat64(base + 8, true), shotEnd: view.getFloat64(base + 16, true) });
    for (let d = 0; d < header.dim; d++) vectors[i * header.dim + d] = fromHalf(view.getUint16(base + 24 + d * 2, true));
  }
  return { header, rows, vectors };
}

/** `EmbeddingStore.key(for:)`: first 32 hex digits of SHA-256("path|mtimeSeconds|size"); undefined when the file is gone. */
export async function embeddingKey(path: string, io?: MediaIo): Promise<string | undefined> {
  const stat = await (io ?? (await mediaIo())).stat(path);
  if (!stat || stat.isDir) return undefined;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${path}|${stat.modifiedMs / 1000}|${stat.size}`)));
  let hex = "";
  for (let i = 0; i < 16; i++) hex += (digest[i] as number).toString(16).padStart(2, "0");
  return hex;
}

export interface IndexIdentity {
  model: string;
  modelVersion: number;
  samplerVersion: number;
}

export class EmbeddingStore {
  constructor(private readonly ioProvider: () => Promise<MediaIo> = mediaIo) {}

  private async directory(): Promise<string> {
    return diskCacheDirectory("Embeddings");
  }

  private async file(key: string): Promise<string> {
    return joinPath(await this.directory(), `${key}.embed`);
  }

  async header(key: string): Promise<EmbeddingHeader | undefined> {
    const io = await this.ioProvider();
    try {
      const path = await this.file(key);
      const prefix = await io.readHead(path, prefixBytes);
      if (!hasMagic(prefix)) return undefined;
      const len = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(magic.length, true);
      return decodeHeader(await io.readHead(path, prefixBytes + len));
    } catch {
      return undefined;
    }
  }

  /** The cached index was built by this model and sampler version (stale entries are rebuilt). */
  async isCurrent(key: string, want: IndexIdentity): Promise<boolean> {
    const h = await this.header(key);
    return h !== undefined && h.model === want.model && h.modelVersion === want.modelVersion && h.samplerVersion === want.samplerVersion;
  }

  async load(key: string): Promise<AssetIndex> {
    return decodeIndex(await (await this.ioProvider()).readAll(await this.file(key)));
  }

  async save(header: EmbeddingHeader, rows: readonly EmbeddingRow[], vectors: Float32Array, key: string): Promise<void> {
    const io = await this.ioProvider();
    const path = await this.file(key);
    await io.mkdir(await this.directory());
    const staging = `${path}.part`;
    await io.writeBytes(staging, encodeIndex(header, rows, vectors));
    await io.rename(staging, path);
  }

  async clearAll(): Promise<void> {
    const io = await this.ioProvider();
    await io.remove(await this.directory()).catch(() => undefined);
  }
}
