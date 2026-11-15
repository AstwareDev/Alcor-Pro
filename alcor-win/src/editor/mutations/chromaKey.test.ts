import { describe, expect, it } from "vitest";
import { cancelChromaKeySampling, commitChromaKeySample, toggleChromaKeySampling } from "./chromaKey";
import { Fixtures, clipById, makeEditor } from "./testFixtures";

describe("EditorViewModel - chroma key sampling", () => {
  it("sampledChromaKeyUndoes", () => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);

    toggleChromaKeySampling(e, clip.id);
    commitChromaKeySample(e, 1 / 3, clip.id);

    const effect = clipById(e, clip.id).effects?.[0];
    expect(effect?.params["tolerance"]?.value).toBe(0.15);
    expect(effect?.params["softness"]?.value).toBe(0.1);
    expect(effect?.params["keyHue"]?.value).toBe(1 / 3);
    e.undo();
    expect(clipById(e, clip.id).effects).toBeUndefined();
  });

  it("togglingTwiceCancelsAndRestoresEnabledState", () => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    clip.effects = [{ id: "e", type: "key.chroma", enabled: true, params: {} }];
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);

    toggleChromaKeySampling(e, clip.id);
    expect(e.ui.chromaKeySamplingClipId).toBe(clip.id);
    expect(clipById(e, clip.id).effects?.[0]?.enabled).toBe(false);
    toggleChromaKeySampling(e, clip.id);
    expect(e.ui.chromaKeySamplingClipId).toBeNull();
    expect(clipById(e, clip.id).effects?.[0]?.enabled).toBe(true);
    expect(e.store.canUndo).toBe(false);
  });

  it("ignoresSamplesForOtherClipsAndNonFiniteHues", () => {
    const clip = Fixtures.clip({ id: "clip", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.videoTrack({ clips: [clip] })]);
    toggleChromaKeySampling(e, clip.id);
    commitChromaKeySample(e, Number.NaN, clip.id);
    commitChromaKeySample(e, 0.2, "other");
    expect(e.ui.chromaKeySamplingClipId).toBe(clip.id);
    cancelChromaKeySampling(e);
    expect(clipById(e, clip.id).effects).toBeUndefined();
  });

  it("refusesAudioClips", () => {
    const clip = Fixtures.clip({ id: "a", mediaType: "audio", start: 0, duration: 30 });
    const e = makeEditor([Fixtures.audioTrack({ clips: [clip] })]);
    toggleChromaKeySampling(e, clip.id);
    expect(e.ui.chromaKeySamplingClipId).toBeNull();
  });
});
