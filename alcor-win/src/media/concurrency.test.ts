import { describe, expect, it } from "vitest";
import { AsyncSemaphore, InflightMap, isAbortError } from "./concurrency";
import { ByteLru } from "./lru";
import { diskCacheKey, sizeMtimeTag } from "./cacheKey";
import {
  filmstripTimestamps, fitWithin, quantizeThumbnailHeight, thumbnailIndexForTime, videoThumbnailTimes,
} from "./thumbnailMath";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AsyncSemaphore", () => {
  it("limits concurrency and releases FIFO", async () => {
    const sem = new AsyncSemaphore(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const job = (i: number) =>
      sem.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(i);
        await tick();
        running -= 1;
      });
    await Promise.all([0, 1, 2, 3, 4].map(job));
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("cancels a queued waiter without consuming a permit", async () => {
    const sem = new AsyncSemaphore(1);
    await sem.wait();
    const ac = new AbortController();
    const queued = sem.wait(ac.signal);
    ac.abort();
    await expect(queued).rejects.toSatisfy(isAbortError);
    sem.signal();
    await sem.wait(); // permit is available again
  });

  it("rejects immediately for an already aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(new AsyncSemaphore(1).wait(ac.signal)).rejects.toSatisfy(isAbortError);
  });
});

describe("InflightMap", () => {
  it("shares one run between concurrent callers", async () => {
    const flights = new InflightMap<number>();
    let runs = 0;
    const factory = async () => {
      runs += 1;
      await tick();
      return 7;
    };
    const [a, b] = await Promise.all([flights.run("k", factory), flights.run("k", factory)]);
    expect([a, b, runs]).toEqual([7, 7, 1]);
    expect(flights.size).toBe(0);
  });

  it("aborts the shared work only when every caller aborted", async () => {
    const flights = new InflightMap<number>();
    let workSignal: AbortSignal | undefined;
    const factory = (s: AbortSignal) => {
      workSignal = s;
      return new Promise<number>((resolve) => setTimeout(() => resolve(1), 5));
    };
    const a = new AbortController();
    const b = new AbortController();
    const pa = flights.run("k", factory, a.signal);
    const pb = flights.run("k", factory, b.signal);
    a.abort();
    await expect(pa).rejects.toSatisfy(isAbortError);
    expect(workSignal?.aborted).toBe(false);
    await expect(pb).resolves.toBe(1);

    const c = new AbortController();
    const pc = flights.run("k2", factory, c.signal);
    c.abort();
    await expect(pc).rejects.toSatisfy(isAbortError);
    expect(workSignal?.aborted).toBe(true);
  });

  it("propagates failures to all callers and clears the entry", async () => {
    const flights = new InflightMap<number>();
    const factory = async () => {
      await tick();
      throw new Error("boom");
    };
    const results = await Promise.allSettled([flights.run("k", factory), flights.run("k", factory)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(flights.size).toBe(0);
  });
});

describe("ByteLru", () => {
  it("evicts least recently used entries over the byte budget and reports them", () => {
    const evicted: string[] = [];
    const lru = new ByteLru<string>(10, (k) => evicted.push(k));
    lru.set("a", "A", 4);
    lru.set("b", "B", 4);
    expect(lru.get("a")).toBe("A"); // a is now most recent
    lru.set("c", "C", 4);
    expect(evicted).toEqual(["b"]);
    expect(lru.bytes).toBe(8);
    expect(lru.has("b")).toBe(false);
    expect(lru.peek("a")).toBe("A");
  });

  it("keeps a single oversized newest entry and replaces by key", () => {
    const evicted: string[] = [];
    const lru = new ByteLru<string>(5, (k, v) => evicted.push(`${k}:${v}`));
    lru.set("big", "1", 100);
    expect(lru.has("big")).toBe(true);
    lru.set("big", "2", 3);
    expect(evicted).toEqual(["big:1"]);
    expect(lru.bytes).toBe(3);
  });

  it("deleteWhere and clear release everything", () => {
    const evicted: string[] = [];
    const lru = new ByteLru<number>(100, (k) => evicted.push(k));
    lru.set("x|1", 1, 1);
    lru.set("x|2", 2, 1);
    lru.set("y|1", 3, 1);
    lru.deleteWhere((k) => k.startsWith("x|"));
    expect(lru.size).toBe(1);
    lru.clear();
    expect(evicted.sort()).toEqual(["x|1", "x|2", "y|1"]);
    expect(lru.bytes).toBe(0);
  });
});

describe("cache keys", () => {
  it("sizeMtimeTag is size_truncatedSeconds, 0_0 when missing", () => {
    expect(sizeMtimeTag({ size: 123, modifiedMs: 1_700_000_000_999 })).toBe("123_1700000000");
    expect(sizeMtimeTag(null)).toBe("0_0");
  });

  it("diskCacheKey is 32 hex chars and changes with path, size or mtime", async () => {
    const base = await diskCacheKey("C:\\a.mp4", { size: 10, modifiedMs: 1000 });
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    expect(await diskCacheKey("C:\\a.mp4", { size: 10, modifiedMs: 1000 })).toBe(base);
    expect(await diskCacheKey("C:\\b.mp4", { size: 10, modifiedMs: 1000 })).not.toBe(base);
    expect(await diskCacheKey("C:\\a.mp4", { size: 11, modifiedMs: 1000 })).not.toBe(base);
    expect(await diskCacheKey("C:\\a.mp4", { size: 10, modifiedMs: 2000 })).not.toBe(base);
  });
});

describe("thumbnail maths", () => {
  it("videoThumbnailTimes: every 1 s under 10 s, else every 2 s", () => {
    expect(videoThumbnailTimes(3.5)).toEqual([0, 1, 2, 3]);
    expect(videoThumbnailTimes(10)).toEqual([0, 2, 4, 6, 8]);
    expect(videoThumbnailTimes(0)).toEqual([]);
    expect(videoThumbnailTimes(Number.NaN)).toEqual([]);
    expect(videoThumbnailTimes(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("fitWithin only shrinks and keeps aspect", () => {
    expect(fitWithin(1920, 1080, 320)).toEqual({ width: 320, height: 180 });
    expect(fitWithin(1080, 1920, 320)).toEqual({ width: 180, height: 320 });
    expect(fitWithin(100, 50, 320)).toEqual({ width: 100, height: 50 });
  });

  it("filmstripTimestamps centres each tile", () => {
    expect(filmstripTimestamps(10, 14, 4)).toEqual([10.5, 11.5, 12.5, 13.5]);
    expect(filmstripTimestamps(0, 1, 0)).toEqual([]);
  });

  it("quantizes heights to multiples of 8 within 16...512", () => {
    expect([1, 17, 64, 65, 9999].map(quantizeThumbnailHeight)).toEqual([16, 24, 64, 72, 512]);
  });

  it("picks the nearest uniformly spaced thumbnail and stops past coverage", () => {
    expect(thumbnailIndexForTime(5.2, 0, 2, 10, 18)).toBe(3); // 2.6 -> 3
    expect(thumbnailIndexForTime(-4, 0, 2, 10, 18)).toBe(0);
    expect(thumbnailIndexForTime(19.9, 0, 2, 10, 18)).toBe(9);
    expect(thumbnailIndexForTime(20.1, 0, 2, 10, 18)).toBeUndefined();
  });
});
