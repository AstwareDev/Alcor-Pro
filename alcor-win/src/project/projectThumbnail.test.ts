import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeClip as mk, makeTimeline, makeTrack } from "../model";
import { ThumbnailScheduler, thumbnailFrame } from "./projectThumbnail";

const makeClip = (p: { mediaType: "video" | "image" | "audio" | "text"; startFrame: number }) =>
  mk({ mediaRef: "m", durationFrames: 10, ...p });

describe("thumbnailFrame", () => {
  it("is null without video-track image/video clips", () => {
    expect(thumbnailFrame(makeTimeline({}))).toBeNull();
    const audio = makeTrack({ type: "audio", clips: [makeClip({ mediaType: "audio", startFrame: 5 })] });
    expect(thumbnailFrame(makeTimeline({ tracks: [audio] }))).toBeNull();
  });

  it("takes the earliest image/video clip of the first video track that has one", () => {
    const text = makeTrack({ type: "video", clips: [makeClip({ mediaType: "text", startFrame: 0 })] });
    const v = makeTrack({
      type: "video",
      clips: [makeClip({ mediaType: "video", startFrame: 90 }), makeClip({ mediaType: "image", startFrame: 30 })],
    });
    const later = makeTrack({ type: "video", clips: [makeClip({ mediaType: "video", startFrame: 0 })] });
    expect(thumbnailFrame(makeTimeline({ tracks: [text, v, later] }))).toBe(30);
  });
});

describe("ThumbnailScheduler", () => {
  let now = 0;
  let playing = false;
  const jpeg = new Uint8Array([1]);
  const make = (capture: ReturnType<typeof vi.fn<() => Promise<Uint8Array | null>>> = vi.fn(async () => jpeg)) => {
    const onCaptured = vi.fn();
    const s = new ThumbnailScheduler({ capture, onCaptured, isPlaying: () => playing, minIntervalMs: 1000, now: () => now });
    return { s, capture, onCaptured };
  };
  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    playing = false;
  });
  afterEach(() => vi.useRealTimers());

  it("captures immediately when idle, then throttles to one trailing capture", async () => {
    const { s, capture, onCaptured } = make();
    s.request();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(onCaptured).toHaveBeenCalledWith(jpeg);
    now = 100;
    s.request();
    s.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(1);
    now = 1000;
    await vi.advanceTimersByTimeAsync(500);
    expect(capture).toHaveBeenCalledTimes(2);
    s.dispose();
  });

  it("never captures during playback", async () => {
    const { s, capture } = make();
    playing = true;
    s.request();
    await s.flush();
    expect(capture).not.toHaveBeenCalled();
    s.dispose();
  });

  it("flush captures once more ignoring the throttle", async () => {
    const { s, capture } = make();
    s.request();
    await vi.advanceTimersByTimeAsync(0);
    now = 10;
    await s.flush();
    expect(capture).toHaveBeenCalledTimes(2);
    s.dispose();
  });

  it("flush gives up on a stuck capture", async () => {
    const { s } = make(vi.fn<() => Promise<Uint8Array | null>>(() => new Promise(() => {})));
    const done = s.flush();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    s.dispose();
  });
});
