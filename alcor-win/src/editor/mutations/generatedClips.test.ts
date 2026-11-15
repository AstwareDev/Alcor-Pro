import { describe, expect, it } from "vitest";
import { makeMediaAsset } from "../../model";
import { fixtureAudioTrack, fixtureClip, fixtureVideoTrack } from "../../model/fixtures";
import { makeEditor } from "./testFixtures";
import { finalizeGeneratingClip, placeGeneratingAudioClip, selectedTimelineSpan } from "./generatedClips";
import { pendingGeneration } from "../../generation/generationState";
import { beginAIRerun, clearPendingGenerationPanelState, aiEditTrimmedSource } from "./aiEdit";
import { finalizeTransitionClip } from "./aiTransition";
import { makeGenerationInput } from "../../model";

function setup() {
  const editor = makeEditor([fixtureVideoTrack({ clips: [fixtureClip({ mediaRef: "v", start: 0, duration: 90 })] }), fixtureAudioTrack()], { fps: 30 });
  const ph = makeMediaAsset({ id: "ph", url: "/tmp/gen.mp3", type: "audio", name: "Music", duration: 3 });
  editor.withoutRegistration(() => { editor.doc.mediaAssets.push(ph); });
  return editor;
}

describe("generated clips", () => {
  it("selectedTimelineSpan falls back to the whole timeline, then the marked range", () => {
    const e = setup();
    expect(selectedTimelineSpan(e)).toEqual({ startFrame: 0, frameCount: 90 });
    e.ui.selectedTimelineRange = { startFrame: 30, endFrame: 60 };
    expect(selectedTimelineSpan(e)).toEqual({ startFrame: 30, frameCount: 30 });
  });
  it("places a placeholder as one undo step and finalizes its duration", () => {
    const e = setup();
    const id = placeGeneratingAudioClip(e, "ph", 10, 3, "Add Music");
    expect(id).not.toBeNull();
    expect(e.clipFor(id ?? "")?.durationFrames).toBe(90);
    finalizeGeneratingClip(e, "ph", { ...makeMediaAsset({ url: "/x.mp3", type: "audio", name: "x", duration: 2 }) });
    expect(e.clipFor(id ?? "")?.durationFrames).toBe(60);
    expect(e.undo()).toBe("Add Music");
    expect(e.clipFor(id ?? "")).toBeNull();
  });
  it("transition finalize retimes via speed", () => {
    const e = setup();
    const id = placeGeneratingAudioClip(e, "ph", 0, 2, "t") ?? "";
    finalizeTransitionClip(e, "ph", makeMediaAsset({ url: "/x.mp3", type: "audio", name: "x", duration: 4 }));
    expect(e.clipFor(id)?.speed).toBe(2);
  });
});

describe("ai edit seeding", () => {
  it("rerun seeds the panel with the stored input and the replacement clip", () => {
    const e = makeEditor([fixtureVideoTrack({ clips: [fixtureClip({ mediaRef: "g", start: 0, duration: 30 })] })]);
    const a = makeMediaAsset({ id: "g", url: "/g.mp4", type: "video", name: "g", duration: 1, generationInput: makeGenerationInput({ prompt: "p", model: "m", duration: 1, aspectRatio: "" }) });
    e.withoutRegistration(() => { e.doc.mediaAssets.push(a); });
    const clipId = e.timeline.tracks[0].clips[0].id;
    beginAIRerun(e, clipId);
    const p = pendingGeneration(e);
    expect(p.panelSeed?.stored.prompt).toBe("p");
    expect(p.replacementClipId).toBe(clipId);
    expect(e.ui.showGenerationPanel).toBe(true);
    clearPendingGenerationPanelState(e);
    expect(p.panelSeed).toBeNull();
    expect(aiEditTrimmedSource(e, clipId)).toBeNull();
  });
});
