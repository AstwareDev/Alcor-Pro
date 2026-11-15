import { importMediaAsset, commitStagedProjectMedia, finalizeImportedAsset } from "../../media/library";
import { mediaIo } from "../../media/io";
import {
  joinPath, makeMediaAsset, matteAspectPixelSize, matteErrorDescription, matteEven, rgbaFromHex,
  type MatteAspect, type MediaAsset,
} from "../../model";
import { swiftRound } from "../../util/math";
import { newId } from "../../util/id";
import type { Editor } from "../editor";

// Port of EditorViewModel+Matte.swift and `Matte.png`: a solid-colour PNG becomes an image asset in the library.

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
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `Matte.png`: an opaque solid-colour RGB PNG; undefined when `hex` isn't a colour. Dimensions are made even. */
export async function matteSolidPng(hex: string, width: number, height: number): Promise<Uint8Array | undefined> {
  const color = rgbaFromHex(hex);
  if (!color) return undefined;
  const size = matteEven(width, height);
  const rgb = [color.r, color.g, color.b].map((c) => swiftRound(c * 255));
  const stride = 1 + size.width * 3;
  const raw = new Uint8Array(stride * size.height);
  for (let x = 0; x < size.width; x++) raw.set(rgb, 1 + x * 3);
  for (let y = 1; y < size.height; y++) raw.copyWithin(y * stride, 0, stride);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size.width);
  view.setUint32(4, size.height);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}

export interface CreateMatteOptions {
  hex: string;
  aspect?: MatteAspect;
  folderId?: string;
  name?: string;
}

/** Not undoable (like `importMediaAsset`). Throws with the Swift `Matte.Error` descriptions. */
export async function createMatte(editor: Editor, options: CreateMatteOptions): Promise<MediaAsset> {
  if (editor.projectPath === null) throw new Error(matteErrorDescription("noProject"));
  const aspect = options.aspect ?? "Project";
  const d = matteAspectPixelSize(aspect, editor.timeline.width, editor.timeline.height);
  const filename = `matte-${newId().slice(0, 8)}.png`;
  const data = await matteSolidPng(options.hex, d.width, d.height);
  if (!data) throw new Error(matteErrorDescription("renderFailed"));
  const io = await mediaIo();
  const tempDir = await io.tempDir();
  await io.mkdir(tempDir);
  const staged = joinPath(tempDir, `palmier-stage-${newId()}.png`);
  await io.writeBytes(staged, data);
  const destination = await commitStagedProjectMedia(editor, staged, filename);
  const asset = makeMediaAsset({
    url: destination,
    type: "image",
    name: options.name ?? (aspect === "Project" ? `Matte · ${d.width}×${d.height}` : `Matte · ${aspect}`),
  });
  if (options.folderId !== undefined) asset.folderId = options.folderId;
  importMediaAsset(editor, asset);
  await finalizeImportedAsset(editor, asset.id);
  return editor.mediaAsset(asset.id) ?? asset;
}
