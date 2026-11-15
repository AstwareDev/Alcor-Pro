import { describe, expect, it } from "vitest";
import { blendModeCiFilterName, blendModes } from "./blendMode";
import { clipTypeFromFileExtension, clipTypeIsCompatible, clipTypeTrackLabelPrefix } from "./clipType";
import { matteAspectParse, matteAspectPixelSize, matteEven, matteFit } from "./matte";
import { videoLayoutSlots, videoLayouts } from "./videoLayout";
import { decodeTextAnimation, textAnimationAgentValues, presetRenderMode } from "./textAnimation";
import { clipSetTextFillMode } from "./textFillMode";
import { textLayoutNaturalSize } from "./textLayout";
import { makeTextStyle } from "./textStyle";
import {
  decodeMulticamSource, makeMulticamMember, multicamAngles, multicamMemberCoverage, multicamMemberLabeled,
} from "./multicamSource";
import { Layout, gcd } from "./constants";
import { fixtureClip } from "./fixtures";

describe("Blend modes", () => {
  it("normalHasNoFilterEverythingElseDoes", () => {
    expect(blendModeCiFilterName("normal")).toBeUndefined();
    for (const mode of blendModes) if (mode !== "normal") expect(blendModeCiFilterName(mode)).toBeDefined();
    expect(blendModeCiFilterName("screen")).toBe("CIScreenBlendMode");
    expect(blendModeCiFilterName("multiply")).toBe("CIMultiplyBlendMode");
  });
});

describe("ClipType", () => {
  it("extension mapping, compatibility and prefix", () => {
    expect(clipTypeFromFileExtension("mp4")).toBe("video");
    expect(clipTypeFromFileExtension("flac")).toBe("audio");
    expect(clipTypeFromFileExtension("exe")).toBeUndefined();
    expect(clipTypeIsCompatible("video", "text")).toBe(true);
    expect(clipTypeIsCompatible("audio", "video")).toBe(false);
    expect(clipTypeTrackLabelPrefix("sequence")).toBe("V");
  });
});

describe("Matte", () => {
  it("sizes are even and fit the short edge", () => {
    expect(matteEven(1921, 1)).toEqual({ width: 1920, height: 2 });
    expect(matteFit(1080, 16, 9)).toEqual({ width: 1920, height: 1080 });
    expect(matteFit(1080, 9, 16)).toEqual({ width: 1080, height: 1920 });
    expect(matteAspectPixelSize("2.4:1", 1920, 1080)).toEqual({ width: 2592, height: 1080 });
    expect(matteAspectPixelSize("Project", 1921, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it("parse is case-insensitive for project only", () => {
    expect(matteAspectParse(" PROJECT ")).toBe("Project");
    expect(matteAspectParse("16:9")).toBe("16:9");
    expect(matteAspectParse("")).toBeUndefined();
    expect(matteAspectParse("5:4")).toBeUndefined();
  });
});

describe("VideoLayout", () => {
  it("every layout has slots with unique ids inside the unit square", () => {
    for (const l of videoLayouts) {
      const slots = videoLayoutSlots(l);
      expect(new Set(slots.map((s) => s.id)).size).toBe(slots.length);
      for (const s of slots) {
        expect(s.rect.x + s.rect.w).toBeLessThanOrEqual(1 + 1e-9);
        expect(s.rect.y + s.rect.h).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    expect(videoLayoutSlots("grid_3x3").length).toBe(9);
    expect(videoLayoutSlots("pip_bottom_right")[1]?.z).toBe(1);
  });
});

describe("TextAnimation / TextFillMode", () => {
  it("decode is lenient", () => {
    expect(decodeTextAnimation({ preset: "bogus", perWordFrames: "x" })).toEqual({ preset: "none", perWordFrames: 6 });
    expect(textAnimationAgentValues[0]).toBe("off");
    expect(presetRenderMode("wordSlide")).toBe("perWord");
  });

  it("setTextFillMode footage recolours the style and color clears the field", () => {
    const clip = fixtureClip({ mediaType: "text", start: 0, duration: 10 });
    clipSetTextFillMode(clip, "footage");
    expect(clip.textFillMode).toBe("footage");
    expect(clip.textStyle?.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    clipSetTextFillMode(clip, "color");
    expect(clip.textFillMode).toBeUndefined();
  });
});

describe("TextLayout", () => {
  it("adds shadow, border and slack padding around the measured size", () => {
    const measure = () => ({ width: 100.2, height: 50 });
    const plain = textLayoutNaturalSize("hi", makeTextStyle(), 1000, 1080, measure);
    expect(plain).toEqual({ width: 101 + 4, height: 50 + 4 });
  });
});

describe("Multicam", () => {
  it("members, coverage and decode", () => {
    const m = makeMulticamMember({ mediaRef: "m", kind: "angle", angleLabel: "Cam A", sync: { offsetSeconds: 1.5, confidence: 0.9, locked: false } });
    const src = decodeMulticamSource(JSON.parse(JSON.stringify({ id: "s", name: "n", members: [m], masterMemberId: m.id })));
    expect(multicamAngles(src).length).toBe(1);
    expect(multicamMemberLabeled(src, "cam a")?.id).toBe(m.id);
    expect(multicamMemberCoverage(m, 2, 30)).toEqual({ lowerBound: 45, upperBound: 105 });
  });
});

describe("constants", () => {
  it("inlined theme values and gcd", () => {
    expect(Layout.mediaPanelMin).toBe(352);
    expect(Layout.toolbarHeight).toBe(36);
    expect(gcd(48, 18)).toBe(6);
  });
});
