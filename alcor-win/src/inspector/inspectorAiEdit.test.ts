import { describe, expect, it } from "vitest";
import { aiEditEligible, availableTabs, type InspectorClipSelection } from "./inspectorLogic";
import { makeClip } from "../model";

const clip = (id: string, mediaType: "video" | "audio" | "text") => ({ ...makeClip({ mediaRef: "m", startFrame: 0, durationFrames: 10, mediaType }), id });
const sel = (p: Partial<InspectorClipSelection>): InspectorClipSelection => ({ textClips: [], nonTextVisualClips: [], audioClips: [], ...p });
const none = (): string[] => [];

describe("aiEditEligible", () => {
  it("needs a resolved asset", () => {
    const v = clip("v", "video");
    expect(aiEditEligible(sel({ nonTextVisualClips: [v], firstVisualClip: v }), false, none)).toBe(false);
  });
  it("accepts one visual clip, or one lone audio clip", () => {
    const v = clip("v", "video");
    expect(aiEditEligible(sel({ nonTextVisualClips: [v], firstVisualClip: v }), true, none)).toBe(true);
    expect(aiEditEligible(sel({ audioClips: [clip("a", "audio")] }), true, none)).toBe(true);
    expect(aiEditEligible(sel({ audioClips: [clip("a", "audio"), clip("b", "audio")] }), true, none)).toBe(false);
  });
  it("accepts audio only when it is a linked partner of the visual clip", () => {
    const v = clip("v", "video");
    const s = sel({ nonTextVisualClips: [v], firstVisualClip: v, audioClips: [clip("a", "audio")] });
    expect(aiEditEligible(s, true, none)).toBe(false);
    expect(aiEditEligible(s, true, () => ["a"])).toBe(true);
  });
  it("appends the AI tab last", () => {
    const v = clip("v", "video");
    expect(availableTabs(sel({ nonTextVisualClips: [v] }), undefined, true)).toEqual(["video", "effects", "ai"]);
  });
});
