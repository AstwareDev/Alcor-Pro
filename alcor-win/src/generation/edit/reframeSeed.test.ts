// Port of Tests/PalmierProTests/Generation/ReframeSeedTests.swift.
import { describe, expect, it } from "vitest";
import { makeMediaAsset } from "../../model";
import { makeVideoInputAssets, validateVideoInputs } from "../inputAssets";
import { isReframeModel, validateReframeDuration, videoSupportedDurationCovering } from "../modelConfig";
import { minimaxH3, sourceEditModel } from "../testFixtures";
import { reframePrompt, reframeSeed } from "./editSubmitter";

const video = (id: string, url: string, duration: number) => makeMediaAsset({ id, url, type: "video", name: id, duration });

describe("Reframe seed", () => {
  it("Seeds MiniMax H3 with video reference and fill prompt", () => {
    const asset = video("clip-1", "/tmp/wide.mp4", 8.2);
    asset.sourceWidth = 1920;
    asset.sourceHeight = 1080;
    const seed = reframeSeed(asset, minimaxH3());
    expect(seed?.model).toBe("minimax-h3");
    expect(seed?.prompt).toBe(reframePrompt);
    expect(seed?.prompt).toContain("@Video1");
    expect(seed?.aspectRatio).toBe("9:16");
    expect(seed?.resolution).toBe("2K");
    expect(seed?.duration).toBe(9);
    expect(seed?.referenceVideoAssetIds).toEqual(["clip-1"]);
    expect(seed?.imageURLAssetIds).toBeUndefined();
  });

  it("Portrait sources reframe to landscape", () => {
    const asset = video("clip-2", "/tmp/tall.mp4", 5);
    asset.sourceWidth = 1080;
    asset.sourceHeight = 1920;
    expect(reframeSeed(asset, minimaxH3())?.aspectRatio).toBe("16:9");
  });

  it("Rejects models that cannot take video references", () => {
    const asset = video("clip-3", "/tmp/clip.mp4", 5);
    expect(reframeSeed(asset, sourceEditModel())).toBeUndefined();
    expect(isReframeModel(sourceEditModel())).toBe(false);
  });

  it("Duration covers the source span so the replaced clip never outlives the media", () => {
    const model = minimaxH3();
    expect(videoSupportedDurationCovering(model, 7.6)).toBe(8);
    expect(videoSupportedDurationCovering(model, 8.5)).toBe(9);
    expect(videoSupportedDurationCovering(model, 4.1)).toBe(5);
    expect(videoSupportedDurationCovering(model, 10)).toBe(10);
    expect(videoSupportedDurationCovering(model, 20)).toBe(15);
    expect(validateReframeDuration(model, 16)).toBeDefined();
    expect(validateReframeDuration(model, 10)).toBeUndefined();
  });

  it("Validates combined video-ref duration against the trimmed span", () => {
    const model = minimaxH3();
    const asset = video("long-1", "/tmp/long-reframe.mp4", 60);
    const inputs = makeVideoInputAssets({ videoRefs: [asset] });
    expect(validateVideoInputs(inputs, model)).toContain("Combined video reference duration");
    const trim = { sourceURL: "/tmp/long-reframe.mp4", trimStartFrame: 0, trimEndFrame: 45 * 30, sourceFramesConsumed: 10 * 30, fps: 30 };
    expect(validateVideoInputs(inputs, model, trim)).toBeUndefined();
  });

  it("Applies trim to the matching video even when an image reference precedes it", () => {
    const image = makeMediaAsset({ id: "img-1", url: "/tmp/style.png", type: "image", name: "Style" });
    const clip = video("vid-2", "/tmp/long-second.mp4", 60);
    const inputs = makeVideoInputAssets({ imageRefs: [image], videoRefs: [clip] });
    const trim = { sourceURL: "/tmp/long-second.mp4", trimStartFrame: 30, trimEndFrame: 49 * 30, sourceFramesConsumed: 10 * 30, fps: 30 };
    expect(validateVideoInputs(inputs, minimaxH3(), trim)).toBeUndefined();
  });

  it("Ignores trim whose source URL matches no reference", () => {
    const clip = video("vid-3", "/tmp/long-third.mp4", 60);
    const inputs = makeVideoInputAssets({ videoRefs: [clip] });
    const trim = { sourceURL: "/tmp/other.mp4", trimStartFrame: 30, trimEndFrame: 49 * 30, sourceFramesConsumed: 10 * 30, fps: 30 };
    expect(validateVideoInputs(inputs, minimaxH3(), trim)).toContain("Combined video reference duration");
  });
});
