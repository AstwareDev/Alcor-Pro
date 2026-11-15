import { describe, expect, it } from "vitest";
import { defaultFootageMatteColor, makeRGBA, makeTextStyle } from "../../model";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

function toolProperties(name: string): Json {
  const tool = mcpServerTools().find((r) => r.definition.name === name);
  if (!tool) throw new Error(`tool ${name} not listed`);
  return (tool.definition.inputSchema as Json).properties as Json;
}

describe("MCP text fill modes", () => {
  it("discoveryAddUpdateReadbackValidationAndUndo", async () => {
    const original = Fixtures.clip({ id: "title", mediaRef: "text", mediaType: "text", start: 0, duration: 60 });
    original.textContent = "Original";
    original.textStyle = makeTextStyle();
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [original] })] }));

    const expectedModes = ["color", "footage", "inverted"];
    expect((toolProperties("update_text").fillMode as Json).enum).toEqual(expectedModes);
    const entryProperties = (((toolProperties("add_texts").entries as Json).items as Json).properties) as Json;
    expect((entryProperties.fillMode as Json).enum).toEqual(expectedModes);

    const findByText = (text: string) => h.editor.timeline.tracks.flatMap((t) => t.clips).find((c) => c.textContent === text);
    const timelineClip = async (): Promise<Json> => {
      const payload = await h.runOK("get_timeline");
      const clips = (payload.tracks as Json[]).flatMap((t) => (t.clips as Json[] | undefined) ?? []);
      const found = clips.find((c) => c.id === original.id);
      if (!found) throw new Error("clip not in timeline");
      return found;
    };
    const addText = (content: string, extra: Json = {}) =>
      h.runRaw("add_texts", { entries: [{ startFrame: 0, endFrame: 60, content, ...extra }] });

    const add = await addText("Invert me", { fillMode: "inverted" });
    expect(add.isError, ToolHarness.textOf(add)).toBe(false);
    const added = findByText("Invert me");
    expect(added?.textFillMode).toBe("inverted");
    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(h.editor.clipFor(added?.id ?? "")).toBeNull();

    const addFootage = await addText("Stencil me", { fillMode: "footage" });
    expect(addFootage.isError, ToolHarness.textOf(addFootage)).toBe(false);
    const addedFootage = findByText("Stencil me");
    expect(addedFootage?.textFillMode).toBe("footage");
    expect(addedFootage?.textStyle?.color).toEqual(defaultFootageMatteColor());
    expect((await h.runRaw("undo")).isError).toBe(false);

    const addColoredFootage = await addText("Green stencil", { fillMode: "footage", style: { color: "#00FF00" } });
    expect(addColoredFootage.isError, ToolHarness.textOf(addColoredFootage)).toBe(false);
    const addedColored = findByText("Green stencil");
    expect(addedColored?.textFillMode).toBe("footage");
    expect(addedColored?.textStyle?.color).toEqual(makeRGBA({ r: 0, g: 1, b: 0, a: 1 }));
    expect((await h.runRaw("undo")).isError).toBe(false);

    const footageUpdate = await h.runRaw("update_text", { clipIds: [original.id], fillMode: "footage" });
    expect(footageUpdate.isError, ToolHarness.textOf(footageUpdate)).toBe(false);
    expect(h.editor.clipFor(original.id)?.textFillMode).toBe("footage");
    expect(h.editor.clipFor(original.id)?.textStyle?.color).toEqual(defaultFootageMatteColor());
    expect((await timelineClip()).textFillMode).toBe("footage");
    expect((await h.runRaw("undo")).isError).toBe(false);

    const update = await h.runRaw("update_text", { clipIds: [original.id], fillMode: "inverted" });
    expect(update.isError, ToolHarness.textOf(update)).toBe(false);
    expect(h.editor.clipFor(original.id)?.textFillMode).toBe("inverted");
    expect((await timelineClip()).textFillMode).toBe("inverted");

    expect((await h.runRaw("undo")).isError).toBe(false);
    expect(h.editor.clipFor(original.id)?.textFillMode).toBeUndefined();

    const invalid = await h.runRaw("update_text", { clipIds: [original.id], fillMode: "difference" });
    expect(invalid.isError).toBe(true);
    expect(h.editor.clipFor(original.id)?.textFillMode).toBeUndefined();
  });
});
