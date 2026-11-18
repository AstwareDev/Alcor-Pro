import { describe, expect, it } from "vitest";
import { hdrTransferDefault } from "./exportOptions";
import {
  buildHdrTransferLut, createHdrConverter, hdrColorSpace, hdrFullCodecString, hdrTransferOf, supportedHdrCodecs,
} from "./hdrExport";

describe("hdrFullCodecString", () => {
  it("picks the HEVC Main10 level from picture size and sample rate", () => {
    expect(hdrFullCodecString("HEVC 10-bit HDR", { width: 1920, height: 1080 }, 30)).toBe("hev1.2.4.L120.B0");
    expect(hdrFullCodecString("HEVC 10-bit HDR", { width: 1920, height: 1080 }, 60)).toBe("hev1.2.4.L123.B0");
    expect(hdrFullCodecString("HEVC 10-bit HDR", { width: 3840, height: 2160 }, 30)).toBe("hev1.2.4.L150.B0");
    expect(hdrFullCodecString("HEVC 10-bit HDR", { width: 3840, height: 2160 }, 60)).toBe("hev1.2.4.L153.B0");
  });
  it("picks the VP9 profile 2 level", () => {
    expect(hdrFullCodecString("VP9 10-bit HDR", { width: 1280, height: 720 }, 30)).toBe("vp09.02.40.10");
    expect(hdrFullCodecString("VP9 10-bit HDR", { width: 1920, height: 1080 }, 60)).toBe("vp09.02.42.10");
    expect(hdrFullCodecString("VP9 10-bit HDR", { width: 3840, height: 2160 }, 30)).toBe("vp09.02.50.10");
    expect(hdrFullCodecString("VP9 10-bit HDR", { width: 7680, height: 4320 }, 30)).toBe("vp09.02.60.10");
  });
  it("falls back to the highest level for oversized pictures", () => {
    expect(hdrFullCodecString("VP9 10-bit HDR", { width: 16384, height: 16384 }, 120)).toBe("vp09.02.62.10");
  });
});

describe("hdr tagging", () => {
  it("tags BT.2020 non-constant luminance, limited range", () => {
    expect(hdrColorSpace("pq")).toEqual({ primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false });
    expect(hdrColorSpace("hlg")).toMatchObject({ transfer: "hlg" });
  });
  it("defaults to HLG like the Swift exporter", () => {
    expect(hdrTransferOf({})).toBe(hdrTransferDefault);
    expect(hdrTransferDefault).toBe("hlg");
    expect(hdrTransferOf({ hdrTransfer: "pq" })).toBe("pq");
  });
  it("reports no HDR codecs when WebCodecs is unavailable", async () => {
    expect(await supportedHdrCodecs()).toEqual([]);
  });
});

describe("hdr pixel conversion", () => {
  const solid = (r: number, g: number, b: number): Uint8Array => {
    const px = new Uint8Array(2 * 2 * 4);
    for (let i = 0; i < 4; i++) px.set([r, g, b, 255], i * 4);
    return px;
  };
  const convert = (transfer: "hlg" | "pq", r: number, g: number, b: number): { y: number; cb: number; cr: number } => {
    const out = new Uint16Array(6);
    createHdrConverter(2, 2, transfer)(solid(r, g, b), out);
    return { y: out[0] as number, cb: out[4] as number, cr: out[5] as number };
  };
  it("maps black to limited-range black with neutral chroma", () => {
    for (const t of ["hlg", "pq"] as const) expect(convert(t, 0, 0, 0)).toEqual({ y: 64, cb: 512, cr: 512 });
  });
  it("puts SDR white at the BT.2408 reference level", () => {
    // HLG 75% and PQ 58.1% of the 876-code luma range.
    expect(Math.abs(convert("hlg", 255, 255, 255).y - Math.round(64 + 876 * 0.75))).toBeLessThanOrEqual(2);
    expect(Math.abs(convert("pq", 255, 255, 255).y - Math.round(64 + 876 * 0.5807))).toBeLessThanOrEqual(2);
  });
  it("keeps greys neutral and pushes red toward Cr", () => {
    const grey = convert("pq", 128, 128, 128);
    expect(Math.abs(grey.cb - 512)).toBeLessThanOrEqual(1);
    expect(Math.abs(grey.cr - 512)).toBeLessThanOrEqual(1);
    const red = convert("hlg", 255, 0, 0);
    expect(red.cr).toBeGreaterThan(560);
    expect(red.cb).toBeLessThan(512);
  });
  it("writes Y, then U, then V planes for 4:2:0", () => {
    const out = new Uint16Array(4 * 4 * 3 / 2);
    createHdrConverter(4, 4, "hlg")(new Uint8Array(4 * 4 * 4).fill(255), out);
    expect(out.every((v) => v > 0)).toBe(true);
    expect(out[16]).toBe(512); // U of a grey frame
    expect(out[20]).toBe(512); // V starts after 16 luma + 4 U samples
  });
  it("builds a monotonic transfer table that ends below peak", () => {
    for (const t of ["hlg", "pq"] as const) {
      const lut = buildHdrTransferLut(t);
      for (let i = 1; i < lut.length; i++) expect(lut[i] as number).toBeGreaterThanOrEqual(lut[i - 1] as number);
      expect(lut[lut.length - 1] as number).toBeLessThan(0.8);
    }
  });
});
