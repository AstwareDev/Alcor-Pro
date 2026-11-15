import { describe, expect, it } from "vitest";
import {
  assetDragString, assetIdFromDragString, assetSegmentFromDragString, decodeMediaDrag, encodeMediaDrag,
  folderDragString, folderIdFromDragString, timelineDragString, timelineIdFromDragString,
} from "./dragPayload";

describe("MediaTab — drag payload contract", () => {
  it("assetStringRoundTrips", () => {
    expect(assetIdFromDragString(assetDragString("asset-123"))).toBe("asset-123");
  });
  it("folderStringRoundTrips", () => {
    expect(folderIdFromDragString(folderDragString("folder-abc"))).toBe("folder-abc");
  });
  it("timelineStringRoundTrips", () => {
    expect(timelineIdFromDragString(timelineDragString("t1"))).toBe("t1");
  });
  it("sentinelsDoNotCrossDecode", () => {
    const asset = assetDragString("x");
    const folder = folderDragString("y");
    expect(folderIdFromDragString(asset)).toBeUndefined();
    expect(assetIdFromDragString(folder)).toBeUndefined();
    expect(timelineIdFromDragString(folder)).toBeUndefined();
  });
  it("fileURLDoesNotDecodeAsAssetOrFolder", () => {
    const line = "file:///tmp/foo.mp4";
    expect(assetIdFromDragString(line)).toBeUndefined();
    expect(folderIdFromDragString(line)).toBeUndefined();
  });
  it("segmentRoundTripsWithThreeDecimals", () => {
    const line = assetDragString("a", { start: 1.5, end: 2.25 });
    expect(line).toBe("palmier-asset://a#1.500-2.250");
    expect(assetIdFromDragString(line)).toBe("a");
    expect(assetSegmentFromDragString(line)).toEqual({ start: 1.5, end: 2.25 });
  });
  it("invalidSegmentsAreRejected", () => {
    for (const bad of ["a#2.000-1.000", "a#1.000-1.000", "a#x-2", "a#-1.000-2.000", "a#1", "a"]) {
      expect(assetSegmentFromDragString(`palmier-asset://${bad}`)).toBeUndefined();
    }
  });
  it("multiLinePayloadDecodesEveryKind", () => {
    const text = encodeMediaDrag({
      assets: [{ id: "a1" }, { id: "a2", segment: { start: 0, end: 1 } }],
      folderIds: ["f1"],
      timelineIds: ["t1"],
    });
    expect(decodeMediaDrag(text)).toEqual({
      assets: [{ id: "a1" }, { id: "a2", segment: { start: 0, end: 1 } }],
      folderIds: ["f1"],
      timelineIds: ["t1"],
    });
  });
  it("unknownAndEmptyLinesAreIgnoredAndDuplicatesCollapse", () => {
    const text = ["file:///tmp/x.mp4", "", "nonsense", assetDragString("a"), assetDragString("a")].join("\n");
    expect(decodeMediaDrag(text)).toEqual({ assets: [{ id: "a" }], folderIds: [], timelineIds: [] });
    expect(decodeMediaDrag("")).toEqual({ assets: [], folderIds: [], timelineIds: [] });
  });
});
