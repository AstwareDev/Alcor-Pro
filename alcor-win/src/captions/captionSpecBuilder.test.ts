import { describe, expect, it } from "vitest";
import { clipEndFrame, makeTextAnimation, makeTextStyle, type TextAnimationPreset } from "../model";
import { fixtureClip } from "../model/fixtures";
import { captionCaseApply } from "../editor/mutations/captions";
import {
  makeTranscriptionResult, makeTranscriptionSegment, makeTranscriptionWord, type TranscriptionResult,
} from "../transcription/transcription";
import { captionGapSettingsDefault, captionMaximumGapFrames, makeCaptionGapSettings } from "./captionGapSettings";
import { buildCaptionSpecs, type CaptionSpecInput, type CaptionSpecTarget } from "./captionSpecBuilder";
import { mapperPhrases } from "./captionTranscriptMapper";
import { fakeMeasure, testGroupId } from "./testSupport";

function gapTarget(p: {
  id: string;
  startFrame: number;
  durationFrames: number;
  captionDurationFrames?: number;
  hasWordTiming?: boolean;
}): CaptionSpecTarget {
  const clip = fixtureClip({ id: p.id, mediaRef: `media-${p.id}`, mediaType: "audio", start: p.startFrame, duration: p.durationFrames });
  const captionDuration = (p.captionDurationFrames ?? Math.min(21, p.durationFrames)) / 30;
  const result = makeTranscriptionResult({
    text: p.id,
    language: "en",
    words: p.hasWordTiming === false ? [] : [makeTranscriptionWord(p.id, 0, captionDuration)],
    segments: [makeTranscriptionSegment(p.id, 0, captionDuration)],
  });
  return { clip, result };
}

function input(p: {
  targets: CaptionSpecTarget[];
  maximumGapSeconds?: number;
  timelineEndFrame?: number;
  maxCharacters?: number;
  animation?: ReturnType<typeof makeTextAnimation>;
}): CaptionSpecInput {
  return {
    targets: p.targets,
    fps: 30,
    timelineEndFrame: p.timelineEndFrame ?? Math.max(0, ...p.targets.map((t) => clipEndFrame(t.clip))),
    canvasWidth: 1920,
    canvasHeight: 1080,
    style: makeTextStyle(),
    center: { x: 0.5, y: 0.8 },
    textCase: "auto",
    maxWords: undefined,
    maxCharacters: p.maxCharacters,
    gapSettings: makeCaptionGapSettings(p.maximumGapSeconds ?? captionGapSettingsDefault.maximumGapSeconds) ?? captionGapSettingsDefault,
    animation: p.animation,
    measure: fakeMeasure,
  };
}

const build = (i: CaptionSpecInput) => buildCaptionSpecs(i, testGroupId);

describe("CaptionSpecBuilder", () => {
  it("buildsCaptionSpecsFromImmutableInput", () => {
    const clip = fixtureClip({ id: "source", mediaRef: "media", mediaType: "audio", start: 0, duration: 300 });
    const result = makeTranscriptionResult({
      text: "hello world",
      language: "en",
      words: [makeTranscriptionWord("hello", 1, 1.4), makeTranscriptionWord("world", 1.5, 2)],
      segments: [],
    });
    const specs = build({ ...input({ targets: [] }), targets: [{ clip, result }], timelineEndFrame: clipEndFrame(clip), textCase: "upper", gapSettings: captionGapSettingsDefault });
    const spec = specs[0];
    expect(specs).toHaveLength(1);
    expect(spec.content).toBe("HELLO WORLD");
    expect(spec.startFrame).toBe(30);
    expect(spec.durationFrames).toBe(45);
    expect(spec.transform).toBeDefined();
    expect(spec.words?.map((w) => w.text)).toEqual(["hello", "world"]);
  });

  it("appliesCharacterCapWhenBuildingCaptionSpecs", () => {
    const clip = fixtureClip({ mediaRef: "media", mediaType: "audio", start: 0, duration: 90 });
    const result = makeTranscriptionResult({
      text: "one two three",
      language: "en",
      words: [makeTranscriptionWord("one", 0, 0.2), makeTranscriptionWord("two", 0.3, 0.5), makeTranscriptionWord("three", 0.6, 0.8)],
      segments: [makeTranscriptionSegment("one two three", 0, 0.8)],
    });
    const specs = build(input({ targets: [{ clip, result }], maxCharacters: 7 }));
    expect(specs.map((s) => s.content)).toEqual(["one", "two", "three"]);
  });

  it.each([
    [6, 0.25, 27, 28],
    [7, 0.25, 28, 28],
    [8, 0.25, 21, 28],
    [6, 0.0, 21, 21],
  ])("closesOnlyGapsWithinTheFrameRoundedThreshold gap=%i max=%f", (gapFrames, maximumGapSeconds, expectedFirstDuration, expectedLastDuration) => {
    const specs = build(input({
      targets: [
        gapTarget({ id: "one", startFrame: 0, durationFrames: 21 }),
        gapTarget({ id: "two", startFrame: 21 + gapFrames, durationFrames: 30 }),
      ],
      maximumGapSeconds,
    }));
    expect(specs.map((s) => s.startFrame)).toEqual([0, 21 + gapFrames]);
    expect(specs.map((s) => s.durationFrames)).toEqual([expectedFirstDuration, expectedLastDuration]);
    expect(specs[0].words).toEqual([{ text: "one", startFrame: 0, endFrame: 21 }]);
  });

  it.each<TextAnimationPreset>(["popIn", "slideUp", "typewriter", "wordReveal", "wordSlide"])(
    "closesAnimatedCaptionGapWithoutOverlap %s",
    (preset) => {
      const specs = build(input({
        targets: [
          gapTarget({ id: "one", startFrame: 0, durationFrames: 21 }),
          gapTarget({ id: "two", startFrame: 27, durationFrames: 30 }),
        ],
        animation: makeTextAnimation({ preset }),
      }));
      expect(specs.map((s) => s.durationFrames)).toEqual([27, 30]);
      expect(specs[0].startFrame + specs[0].durationFrames).toBe(specs[1].startFrame);
      expect(specs[0].words?.at(-1)?.endFrame).toBe(21);
      expect(specs[1].words?.at(-1)?.endFrame).toBe(21);
    },
  );

  it("oneFrameAnimatedCaptionClosesTheFollowingGapWithoutOverlap", () => {
    const specs = build(input({
      targets: [
        gapTarget({ id: "one", startFrame: 0, durationFrames: 21 }),
        gapTarget({ id: "two", startFrame: 27, durationFrames: 1, hasWordTiming: false }),
        gapTarget({ id: "three", startFrame: 33, durationFrames: 30 }),
      ],
      animation: makeTextAnimation({ preset: "popIn" }),
    }));
    expect(specs.map((s) => s.durationFrames)).toEqual([27, 6, 30]);
    expect(specs[0].startFrame + specs[0].durationFrames).toBe(specs[1].startFrame);
    expect(specs[1].startFrame + specs[1].durationFrames).toBe(specs[2].startFrame);
  });

  it("trimsOverlapsWhenGapClosingIsDisabled", () => {
    const specs = build(input({
      targets: [
        gapTarget({ id: "one", startFrame: 0, durationFrames: 21 }),
        gapTarget({ id: "two", startFrame: 20, durationFrames: 30 }),
      ],
      maximumGapSeconds: 0,
    }));
    expect(specs.map((s) => s.startFrame)).toEqual([0, 20]);
    expect(specs.map((s) => s.durationFrames)).toEqual([20, 21]);
    expect(specs[0].words?.at(-1)?.endFrame).toBe(20);
  });

  it("trimsNestedOverlapsWithoutExtendingAcrossALongGap", () => {
    const specs = build(input({
      targets: [
        gapTarget({ id: "outer", startFrame: 0, durationFrames: 40 }),
        gapTarget({ id: "nested", startFrame: 10, durationFrames: 5 }),
        gapTarget({ id: "next", startFrame: 31, durationFrames: 30 }),
      ],
    }));
    expect(specs.map((s) => s.startFrame)).toEqual([0, 10, 31]);
    expect(specs.map((s) => s.durationFrames)).toEqual([10, 5, 30]);
  });

  it("shorterPreviousCaptionOwnsOverlappingFrames", () => {
    const specs = build(input({
      targets: [
        gapTarget({ id: "one", startFrame: 0, durationFrames: 5 }),
        gapTarget({ id: "two", startFrame: 4, durationFrames: 21 }),
      ],
      maximumGapSeconds: 0,
    }));
    expect(specs.map((s) => s.content)).toEqual(["one", "two"]);
    expect(specs.map((s) => s.startFrame)).toEqual([0, 5]);
    expect(specs.map((s) => s.durationFrames)).toEqual([5, 20]);
    expect(specs[1].words).toEqual([{ text: "two", startFrame: 0, endFrame: 20 }]);
  });

  it("shorterNextCaptionOwnsOverlappingFrames", () => {
    const specs = build(input({
      targets: [
        gapTarget({ id: "one", startFrame: 0, durationFrames: 21 }),
        gapTarget({ id: "two", startFrame: 20, durationFrames: 5 }),
      ],
      maximumGapSeconds: 0,
    }));
    expect(specs.map((s) => s.content)).toEqual(["one", "two"]);
    expect(specs.map((s) => s.startFrame)).toEqual([0, 20]);
    expect(specs.map((s) => s.durationFrames)).toEqual([20, 5]);
  });

  it("laterCaptionWinsEqualDurationTie", () => {
    const specs = build(input({
      targets: [
        gapTarget({ id: "one", startFrame: 0, durationFrames: 5 }),
        gapTarget({ id: "two", startFrame: 4, durationFrames: 5 }),
      ],
      maximumGapSeconds: 0,
    }));
    expect(specs.map((s) => s.startFrame)).toEqual([0, 4]);
    expect(specs.map((s) => s.durationFrames)).toEqual([4, 5]);
  });

  it("sameFrameCaptionsRemainSeparateAndCapped", () => {
    const specs = build(input({
      targets: [
        gapTarget({ id: "one", startFrame: 0, durationFrames: 21 }),
        gapTarget({ id: "two", startFrame: 0, durationFrames: 5 }),
      ],
      maximumGapSeconds: 0,
      maxCharacters: 3,
    }));
    expect(specs.map((s) => s.content)).toEqual(["one", "two"]);
    expect(specs.map((s) => s.startFrame)).toEqual([0, 1]);
    expect(specs.map((s) => s.durationFrames)).toEqual([1, 4]);
    expect(specs.every((s) => s.content.length <= 3)).toBe(true);
    expect(specs[1].words).toEqual([{ text: "two", startFrame: 0, endFrame: 4 }]);
  });

  it("sameFrameCollisionChainPreservesEveryCaption", () => {
    const specs = build(input({
      targets: [
        gapTarget({ id: "aaa", startFrame: 0, durationFrames: 3 }),
        gapTarget({ id: "bb", startFrame: 0, durationFrames: 2 }),
        gapTarget({ id: "c", startFrame: 0, durationFrames: 1 }),
      ],
      maximumGapSeconds: 0,
      maxCharacters: 3,
    }));
    expect(specs.map((s) => s.content)).toEqual(["aaa", "bb", "c"]);
    expect(specs.map((s) => s.startFrame)).toEqual([0, 1, 2]);
    expect(specs.map((s) => s.durationFrames)).toEqual([1, 1, 1]);
  });

  it.each([
    [100, 0.5, 16],
    [10, 0.5, 10],
    [100, 0.0, 1],
  ])("holdsTheFinalCaptionWithinTheTimeline end=%i max=%f", (timelineEndFrame, maximumGapSeconds, expectedDuration) => {
    const specs = build(input({
      targets: [gapTarget({ id: "last", startFrame: 0, durationFrames: timelineEndFrame, captionDurationFrames: 1 })],
      maximumGapSeconds,
      timelineEndFrame,
    }));
    expect(specs.map((s) => s.durationFrames)).toEqual([expectedDuration]);
  });

  it("captionGapSettingsValidateAndRoundDownToFrames", () => {
    expect(captionMaximumGapFrames(captionGapSettingsDefault, 30)).toBe(15);
    const zero = makeCaptionGapSettings(0);
    expect(zero && captionMaximumGapFrames(zero, 30)).toBe(0);
    expect(makeCaptionGapSettings(-0.1)).toBeUndefined();
    expect(makeCaptionGapSettings(2.1)).toBeUndefined();
    expect(makeCaptionGapSettings(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("CaptionProjectionTests", () => {
  it.each([true, false])("preservesShortTimingsAcrossTranscriptSegments hasWordTimings=%s", (hasWordTimings) => {
    const clip = fixtureClip({ mediaRef: "media", mediaType: "audio", start: 0, duration: 60 });
    const result = makeTranscriptionResult({
      text: "Sophie? Hi,",
      language: "en",
      words: hasWordTimings ? [makeTranscriptionWord("Sophie?", 0, 0.2), makeTranscriptionWord("Hi,", 0.3, 0.5)] : [],
      segments: [makeTranscriptionSegment("Sophie?", 0, 0.2), makeTranscriptionSegment("Hi,", 0.3, 0.5)],
    });
    const phrases = mapperPhrases(clip, result, { fps: 30, maxWords: undefined, maxCharacters: 4, fits: () => true });
    expect(phrases.map((p) => p.text)).toEqual(["Sophie?", "Hi,"]);
    expect(phrases.map((p) => p.start)).toEqual([0, 0.3]);
    expect(phrases.map((p) => p.end)).toEqual([0.2, 0.5]);
  });

  it("phrasesIgnoreWordsOutsideCurrentClipFragments", () => {
    const first = fixtureClip({ id: "first", mediaRef: "media-1", mediaType: "audio", start: 0, duration: 30, trimStart: 0 });
    const second = fixtureClip({ id: "second", mediaRef: "media-1", mediaType: "audio", start: 30, duration: 30, trimStart: 60 });
    const result: TranscriptionResult = makeTranscriptionResult({
      text: "keep um go",
      language: "en",
      words: [makeTranscriptionWord("keep", 0.1, 0.3), makeTranscriptionWord("um", 1.1, 1.2), makeTranscriptionWord("go", 2.1, 2.3)],
      segments: [makeTranscriptionSegment("keep um go", 0, 3)],
    });
    const opts = { fps: 30, maxWords: undefined, maxCharacters: undefined, fits: () => true };
    expect(mapperPhrases(first, result, opts).map((p) => p.text)).toEqual(["keep"]);
    expect(mapperPhrases(second, result, opts).map((p) => p.text)).toEqual(["go"]);
  });
});

describe("CaptionCaseTests", () => {
  it("transformsText", () => {
    expect(captionCaseApply("auto", "Hello World.")).toBe("Hello World.");
    expect(captionCaseApply("upper", "Hello World.")).toBe("HELLO WORLD.");
    expect(captionCaseApply("lower", "Hello World.")).toBe("hello world.");
  });
});
