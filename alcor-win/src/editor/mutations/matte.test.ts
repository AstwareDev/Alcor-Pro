import { describe, expect, it } from "vitest";
import { matteSolidPng } from "./matte";

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array }[] = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    out.push({ type: String.fromCharCode(...png.subarray(at + 4, at + 8)), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

describe("matteSolidPng", () => {
  it("encodesAnEvenSizedOpaqueRGBImage", async () => {
    const png = await matteSolidPng("#FF8000", 5, 3);
    expect(png).toBeDefined();
    const parts = chunks(png as Uint8Array);
    expect(parts.map((p) => p.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    const header = new DataView(parts[0].data.buffer, parts[0].data.byteOffset, 13);
    // 5x3 is made even: 4x2
    expect([header.getUint32(0), header.getUint32(4), parts[0].data[8], parts[0].data[9]]).toEqual([4, 2, 8, 2]);
    const raw = await inflate(parts[1].data);
    expect(raw.length).toBe(2 * (1 + 4 * 3));
    expect(Array.from(raw.subarray(0, 4))).toEqual([0, 255, 128, 0]);
    expect(Array.from(raw.subarray(13, 17))).toEqual([0, 255, 128, 0]);
  });

  it("rejectsNonColors", async () => {
    expect(await matteSolidPng("not-a-color", 4, 4)).toBeUndefined();
  });
});
