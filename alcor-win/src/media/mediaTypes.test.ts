import { describe, expect, it } from "vitest";
import { clipTypeForPath, isLottieHeader, parseLottieJson } from "./mediaTypes";
import { fileStem, hasDirectoryPath, lastPathComponent, parentPath, pathExtension } from "./paths";
import { mediaUrl } from "./mediaUrl";

describe("AudioImport", () => {
  it("classifiesAudioExtensions", () => {
    for (const ext of ["mp3", "wav", "aac", "m4a", "aiff", "aif", "aifc", "flac"]) {
      expect(clipTypeForPath(`C:\\x\\a.${ext}`)).toBe("audio");
    }
    expect(clipTypeForPath("a.txt")).toBeUndefined();
  });

  it("lowercases the extension before matching", () => {
    expect(clipTypeForPath("/clips/A.MP4")).toBe("video");
    expect(clipTypeForPath("/clips/noext")).toBeUndefined();
    expect(clipTypeForPath("/clips/.mp4")).toBeUndefined();
  });

  it("classifies images, lottie and subtitles", () => {
    expect(clipTypeForPath("a.heic")).toBe("image");
    expect(clipTypeForPath("a.json")).toBe("lottie");
    expect(clipTypeForPath("a.lottie")).toBe("lottie");
    expect(clipTypeForPath("a.srt")).toBe("subtitle");
  });
});

describe("paths", () => {
  it("splits components like NSString", () => {
    expect(lastPathComponent("C:\\media\\clip.final.mp4")).toBe("clip.final.mp4");
    expect(lastPathComponent("/a/b/")).toBe("b");
    expect(pathExtension("/a/b.tar.gz")).toBe("gz");
    expect(pathExtension("/a/.hidden")).toBe("");
    expect(pathExtension("/a/name.")).toBe("");
    expect(fileStem("/a/clip.final.mp4")).toBe("clip.final");
    expect(fileStem("/a/.hidden")).toBe(".hidden");
    expect(parentPath("/a/b/c.mp4")).toBe("/a/b");
    expect(hasDirectoryPath("/tmp/folder/")).toBe(true);
    expect(hasDirectoryPath("/tmp/a.mp4")).toBe(false);
  });
});

describe("lottie sniffing", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it("accepts a Bodymovin comp signature", () => {
    expect(isLottieHeader("a.json", bytes('  {"v":"5.7","w":10,"h":10,"op":30,"layers":[]}'))).toBe(true);
  });
  it("rejects other JSON and non-JSON", () => {
    expect(isLottieHeader("a.json", bytes('{"name":"x"}'))).toBe(false);
    expect(isLottieHeader("a.json", bytes("[1,2]"))).toBe(false);
  });
  it(".lottie must be a zip", () => {
    expect(isLottieHeader("a.lottie", Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1))).toBe(true);
    expect(isLottieHeader("a.lottie", bytes("{}"))).toBe(false);
  });
  it("derives metadata from comp fields", () => {
    const meta = parseLottieJson('{"v":"5","fr":30,"ip":0,"op":90,"w":512.9,"h":256,"layers":[]}');
    expect(meta).toEqual({ width: 512, height: 256, framerate: 30, duration: 3 });
    expect(parseLottieJson("nope")).toBeUndefined();
    expect(parseLottieJson('{"w":1}')).toBeUndefined();
  });
});

describe("mediaUrl", () => {
  it("passes the path through outside Tauri", () => {
    expect(mediaUrl("C:\\a\\b.mp4")).toBe("C:\\a\\b.mp4");
  });
});
