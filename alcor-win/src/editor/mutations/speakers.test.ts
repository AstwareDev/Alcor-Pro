import { describe, expect, it } from "vitest";
import { hexToRgba, removeSpeaker, renameSpeaker, setSpeakerColor, speakerCssColor, speakerHex } from "./speakers";
import { makeEditor } from "./testFixtures";

function editorWithSpeakers() {
  const e = makeEditor();
  e.withoutRegistration(() => {
    e.doc.speakerRegistry = [
      { id: 1, name: "Speaker 1", color: [0, 0, 1, 1], centroid: [0.1] },
      { id: 2, name: "Speaker 2", color: [0, 1, 0, 1], centroid: [0.2] },
    ];
  });
  return e;
}

describe("speaker registry mutations", () => {
  it("renames only the matching speaker without an undo entry", () => {
    const e = editorWithSpeakers();
    expect(renameSpeaker(e, 2, "Host")).toBe(true);
    expect(e.doc.speakerRegistry.map((s) => s.name)).toEqual(["Speaker 1", "Host"]);
    expect(e.undo()).toBeNull();
  });

  it("ignores unknown ids", () => {
    const e = editorWithSpeakers();
    const before = e.store.revision;
    expect(renameSpeaker(e, 9, "x")).toBe(false);
    expect(setSpeakerColor(e, 9, [1, 1, 1, 1])).toBe(false);
    expect(removeSpeaker(e, 9)).toBe(false);
    expect(e.store.revision).toBe(before);
  });

  it("sets colour and removes", () => {
    const e = editorWithSpeakers();
    setSpeakerColor(e, 1, [1, 0, 0, 1]);
    expect(e.doc.speakerRegistry[0]?.color).toEqual([1, 0, 0, 1]);
    removeSpeaker(e, 1);
    expect(e.doc.speakerRegistry.map((s) => s.id)).toEqual([2]);
  });

  it("converts colours", () => {
    expect(speakerHex([1, 0, 0.5, 1])).toBe("#ff0080");
    expect(hexToRgba("#ff0000")).toEqual([1, 0, 0, 1]);
    expect(hexToRgba("nope")).toBeUndefined();
    expect(speakerCssColor([1, 0, 0, 1])).toBe("rgb(255 0 0 / 1)");
    expect(speakerCssColor([1])).toBe("#0a84ff");
  });
});
