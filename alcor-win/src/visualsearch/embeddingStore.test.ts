import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeFakeIo, type FakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import {
  CorruptEmbeddingError, EmbeddingStore, decodeHeader, decodeIndex, embeddingKey, encodeIndex, fromHalf, toHalf,
  type EmbeddingHeader, type EmbeddingRow,
} from "./embeddingStore";

const header: EmbeddingHeader = { model: "siglip", modelVersion: 1, samplerVersion: 1, dim: 3, count: 2 };
const rows: EmbeddingRow[] = [{ time: 1.5, shotStart: 0, shotEnd: 6 }, { time: 7, shotStart: 6, shotEnd: 12.25 }];
const vectors = Float32Array.from([0.5, -0.25, 0.125, 1, 0, -1]);

let io: FakeIo;
beforeEach(() => {
  io = makeFakeIo();
  setMediaIo(io);
});
afterEach(() => setMediaIo(undefined));

describe("half precision", () => {
  it("roundTripsRepresentableValuesAndRoundsOthers", () => {
    for (const v of [0, 1, -1, 0.5, -0.25, 65504, 2 ** -14, 2 ** -24]) expect(fromHalf(toHalf(v))).toBe(v);
    expect(fromHalf(toHalf(0.1))).toBeCloseTo(0.1, 3);
    expect(fromHalf(toHalf(1e9))).toBe(Infinity);
    expect(fromHalf(toHalf(1e-9))).toBe(0);
  });
});

describe("index encoding", () => {
  it("roundTripsHeaderRowsAndVectors", () => {
    const decoded = decodeIndex(encodeIndex(header, rows, vectors));
    expect(decoded.header).toEqual(header);
    expect(decoded.rows).toEqual(rows);
    expect(Array.from(decoded.vectors)).toEqual(Array.from(vectors));
  });

  it("readsJustTheHeader", () => {
    expect(decodeHeader(encodeIndex(header, rows, vectors))).toEqual(header);
    expect(decodeHeader(new TextEncoder().encode("garbage-bytes-here"))).toBeUndefined();
  });

  it("rejectsTruncatedOrForeignFiles", () => {
    const bytes = encodeIndex(header, rows, vectors);
    expect(() => decodeIndex(bytes.subarray(0, bytes.length - 1))).toThrow(CorruptEmbeddingError);
    expect(() => decodeIndex(new Uint8Array(4))).toThrow(CorruptEmbeddingError);
  });

  it("refusesToEncodeMismatchedRows", () => {
    expect(() => encodeIndex({ ...header, count: 3 }, rows, vectors)).toThrow();
  });
});

describe("cache invalidation", () => {
  const want = { model: "siglip", modelVersion: 1, samplerVersion: 1 };

  it("keysOnPathMtimeAndSize", async () => {
    io.addFile("/m/a.mp4", "abc", 1000);
    const k1 = await embeddingKey("/m/a.mp4");
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
    io.addFile("/m/a.mp4", "abc", 2000);
    expect(await embeddingKey("/m/a.mp4")).not.toBe(k1);
    io.addFile("/m/a.mp4", "abcd", 1000);
    expect(await embeddingKey("/m/a.mp4")).not.toBe(k1);
    io.addFile("/m/b.mp4", "abc", 1000);
    expect(await embeddingKey("/m/b.mp4")).not.toBe(k1);
    expect(await embeddingKey("/m/missing.mp4")).toBeUndefined();
  });

  it("isCurrentOnlyForTheSameModelVersionAndSamplerVersion", async () => {
    const store = new EmbeddingStore();
    expect(await store.isCurrent("k", want)).toBe(false);
    await store.save(header, rows, vectors, "k");
    expect(await store.isCurrent("k", want)).toBe(true);
    expect(await store.isCurrent("k", { ...want, model: "other" })).toBe(false);
    expect(await store.isCurrent("k", { ...want, modelVersion: 2 })).toBe(false);
    expect(await store.isCurrent("k", { ...want, samplerVersion: 2 })).toBe(false);
  });

  it("aReplacedFileGetsANewKeyAndSoIsNotCurrent", async () => {
    const store = new EmbeddingStore();
    io.addFile("/m/a.mp4", "abc", 1000);
    const old = (await embeddingKey("/m/a.mp4")) as string;
    await store.save(header, rows, vectors, old);
    io.addFile("/m/a.mp4", "abc", 5000);
    const fresh = (await embeddingKey("/m/a.mp4")) as string;
    expect(await store.isCurrent(fresh, want)).toBe(false);
    expect((await store.load(old)).rows).toEqual(rows);
  });

  it("treatsACorruptFileAsNotCurrentAndFailsToLoad", async () => {
    const store = new EmbeddingStore();
    io.addFile("/cache/Embeddings/bad.embed", "not an embedding file at all");
    expect(await store.isCurrent("bad", want)).toBe(false);
    await expect(store.load("bad")).rejects.toThrow(CorruptEmbeddingError);
  });
});
