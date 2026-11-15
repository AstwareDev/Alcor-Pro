import { describe, expect, it } from "vitest";
import {
  makeRGBA, makeTextAnimation, makeTextShadow, makeTextStyle, rgbaFromHex, textLayoutNaturalSize,
  type Clip, type MediaAsset, type TextStyle,
} from "../../model";
import { createFolder } from "../../media/folders";
import { insertTrack } from "../../editor/mutations/tracks";
import { Fixtures } from "../../editor/mutations/testFixtures";
import { registeredTools } from "./toolRegistry";
import "./index";
import { fakeMeasure, ToolHarness } from "./testHarness";

type Json = Record<string, unknown>;

function props(schema: unknown): Json {
  return (schema as Json).properties as Json;
}

function textClip(id: string, start: number, duration: number, content: string, p: { group?: string; style?: boolean } = {}): Clip {
  const c = Fixtures.clip({ id, mediaRef: "text", mediaType: "text", start, duration });
  if (p.group !== undefined) c.captionGroupId = p.group;
  c.textContent = content;
  if (p.style) c.textStyle = makeTextStyle();
  return c;
}

function makeNamedAsset(h: ToolHarness, name: string): MediaAsset {
  const asset = h.addAsset();
  h.editor.withoutRegistration(() => {
    const a = h.editor.doc.mediaAssets.find((x) => x.id === asset.id);
    if (a) a.name = name;
  });
  return asset;
}

const folders = (h: ToolHarness) => h.editor.doc.mediaManifest.folders;
const assetNamed = (h: ToolHarness, id: string) => h.editor.doc.mediaAssets.find((a) => a.id === id);

function addVideoTrack(h: ToolHarness): void {
  insertTrack(h.editor, 0, "video");
}

function spansOf(h: ToolHarness): number[][] {
  return [...h.editor.timeline.tracks[0].clips]
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((c) => [c.startFrame, c.startFrame + c.durationFrames]);
}

describe("ToolExecutor — text and folder handlers", () => {
  // MARK: - add_texts

  it("textSchemasExposeAlignmentRelativePositionWithoutBoxDimensions", () => {
    const updateTool = registeredTools().find((r) => r.definition.name === "update_text");
    if (!updateTool) throw new Error("update_text not registered");
    const updateProperties = props(updateTool.definition.inputSchema);
    const styleProperties = props(updateProperties.style);
    const num = (key: string, field: string) => (styleProperties[key] as Json)[field];

    expect(num("widthScale", "minimum")).toBe(0.1);
    expect(num("widthScale", "maximum")).toBe(10);
    expect(num("heightScale", "minimum")).toBe(0.1);
    expect(num("heightScale", "maximum")).toBe(10);
    expect(num("blur", "maximum")).toBe(100);

    const transformKeys = ["x", "y", "rotation", "rotationX", "rotationY"].sort();
    expect(Object.keys(props(updateProperties.transform)).sort()).toEqual(transformKeys);

    const addTool = registeredTools().find((r) => r.definition.name === "add_texts");
    if (!addTool) throw new Error("add_texts not registered");
    const entries = props(addTool.definition.inputSchema).entries as Json;
    const entryProperties = props(entries.items);
    expect(props(entryProperties.style).blur).toBeDefined();
    expect(Object.keys(props(entryProperties.transform)).sort()).toEqual(transformKeys);
    // add_captions is not registered in the Windows port, so its schema assertions are skipped.
  });

  it("addTextsCreatesNewTrackWhenIndexOmitted", async () => {
    const h = new ToolHarness();
    const initialTrackCount = h.editor.timeline.tracks.length;
    const result = await h.runRaw("add_texts", { entries: [{ startFrame: 0, endFrame: 90, content: "Hello" }] });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks.length).toBe(initialTrackCount + 1);
    const textClips = h.editor.timeline.tracks.flatMap((t) => t.clips).filter((c) => c.mediaType === "text");
    expect(textClips.length).toBe(1);
    expect(textClips[0].textContent).toBe("Hello");
    expect(textClips[0].durationFrames).toBe(90);
  });

  it("addTextsPlacesOnExplicitTrack", async () => {
    const h = new ToolHarness();
    addVideoTrack(h);
    const result = await h.runRaw("add_texts", {
      entries: [{ trackIndex: 0, startFrame: 30, endFrame: 90, content: "Caption", style: { fontSize: 48 } }],
    });
    expect(result.isError).toBe(false);
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(clip.textContent).toBe("Caption");
    expect(clip.textStyle?.fontSize).toBe(48);
  });

  it("addTextsPositionsXAtTheSelectedAlignmentEdge", async () => {
    const h = new ToolHarness();
    addVideoTrack(h);
    const result = await h.runRaw("add_texts", {
      entries: [{ trackIndex: 0, startFrame: 0, endFrame: 60, content: "Left anchored", style: { alignment: "left" }, transform: { x: 0.1 } }],
    });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(Math.abs(clip.transform.centerX - clip.transform.width / 2 - 0.1)).toBeLessThan(0.0001);
    expect(clip.transform.centerY).toBe(0.5);

    const payload = JSON.parse(ToolHarness.textOf(result)) as Json;
    const transform = ((payload.clips as Json[])[0]).transform as Json;
    expect(Math.abs((transform.x as number) - 0.1)).toBeLessThan(0.0001);
    expect(transform.y).toBe(0.5);
    expect(transform.centerX).toBeUndefined();
    expect(transform.centerY).toBeUndefined();
    expect(transform.width).toBeUndefined();
    expect(transform.height).toBeUndefined();
  });

  it("addTextsAllowsYWithoutChangingTheDefaultHorizontalCenter", async () => {
    const h = new ToolHarness();
    addVideoTrack(h);
    const result = await h.runRaw("add_texts", {
      entries: [{ trackIndex: 0, startFrame: 0, endFrame: 60, content: "Vertically placed", transform: { y: 0.8 } }],
    });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const clip = h.editor.timeline.tracks[0].clips[0];
    expect(clip.transform.centerX).toBe(0.5);
    expect(clip.transform.centerY).toBe(0.8);
  });

  it("updateTextAutoFitsContentAtRequestedAnchor", async () => {
    const clip = Fixtures.clip({ id: "title", mediaRef: "", mediaType: "text", start: 0, duration: 60 });
    clip.textContent = "I";
    const style = makeTextStyle();
    style.alignment = "right";
    clip.textStyle = style;
    Object.assign(clip.transform, { centerX: 0.5, centerY: 0.5, width: 0.8, height: 0.6 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const content = "A much longer title";
    const result = await h.runRaw("update_text", { clipIds: [clip.id], content, transform: { x: 0.2, y: 0.3 } });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const updated = h.editor.clipFor(clip.id);
    if (!updated) throw new Error("clip missing");
    const tl = h.editor.timeline;
    // Size comes from the deterministic fakeMeasure, not real font metrics.
    const natural = textLayoutNaturalSize(content, style, tl.width * 0.9, tl.height, fakeMeasure);
    expect(Math.abs(updated.transform.centerX + updated.transform.width / 2 - 0.2)).toBeLessThan(0.0001);
    expect(updated.transform.centerY).toBe(0.3);
    expect(Math.abs(updated.transform.width - natural.width / tl.width)).toBeLessThan(0.0001);
    expect(Math.abs(updated.transform.height - natural.height / tl.height)).toBeLessThan(0.0001);

    const resize = await h.runRaw("update_text", { clipIds: [clip.id], content: `${content} that keeps growing` });
    expect(resize.isError, ToolHarness.textOf(resize)).toBe(false);
    const resized = h.editor.clipFor(clip.id);
    if (!resized) throw new Error("clip missing");
    expect(resized.transform.width).toBeGreaterThan(updated.transform.width);
    expect(Math.abs(resized.transform.centerX + resized.transform.width / 2 - 0.2)).toBeLessThan(0.0001);
  });

  it("updateTextKeepsTheAnchorWhenAlignmentChanges", async () => {
    const clip = Fixtures.clip({ id: "title", mediaRef: "", mediaType: "text", start: 0, duration: 60 });
    clip.textContent = "Title";
    clip.textStyle = makeTextStyle();
    Object.assign(clip.transform, { centerX: 0.4, centerY: 0.6, width: 0.2, height: 0.1 });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("update_text", { clipIds: [clip.id], style: { alignment: "left" } });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const updated = h.editor.clipFor(clip.id);
    if (!updated) throw new Error("clip missing");
    expect(updated.textStyle?.alignment).toBe("left");
    expect(Math.abs(updated.transform.centerX - updated.transform.width / 2 - 0.4)).toBeLessThan(0.0001);
    expect(updated.transform.centerY).toBe(0.6);
  });

  it("addTextsAppliesRichTextStyleFields", async () => {
    const h = new ToolHarness();
    addVideoTrack(h);
    const result = await h.runRaw("add_texts", {
      entries: [
        {
          trackIndex: 0,
          startFrame: 0,
          endFrame: 60,
          content: "Styled",
          style: {
            fontSize: 54,
            widthScale: 1.5,
            heightScale: 0.8,
            tracking: 5,
            lineSpacing: 12,
            fontCase: "uppercase",
            underline: true,
            strikethrough: true,
            overline: true,
            outline: { enabled: true, width: 3 },
            shadow: { opacity: 0.4, offset: { x: 0, y: -3 } },
            background: { enabled: true, padding: { x: 20, y: 10 }, cornerRadius: 9 },
          },
        },
      ],
    });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const style = h.editor.timeline.tracks[0].clips[0].textStyle;
    expect(style?.fontSize).toBe(54);
    expect(style?.widthScale).toBe(1.5);
    expect(style?.heightScale).toBe(0.8);
    expect(style?.tracking).toBe(5);
    expect(style?.lineSpacing).toBe(12);
    expect(style?.fontCase).toBe("uppercase");
    expect(style?.isUnderlined).toBe(true);
    expect(style?.isStruckThrough).toBe(true);
    expect(style?.isOverlined).toBe(true);
    expect(style?.border.enabled).toBe(true);
    expect(style?.border.width).toBe(3);
    expect(style?.shadow.color.a).toBe(0.4);
    expect(style?.shadow.offsetX).toBe(0);
    expect(style?.shadow.offsetY).toBe(-3);
    expect(style?.background.enabled).toBe(true);
    expect(style?.background.paddingX).toBe(20);
    expect(style?.background.paddingY).toBe(10);
    expect(style?.background.cornerRadius).toBe(9);
  });

  it("addTextsRejectsLegacyStyleField", async () => {
    const h = new ToolHarness();
    addVideoTrack(h);
    const result = await h.runRaw("add_texts", {
      entries: [{ trackIndex: 0, startFrame: 0, endFrame: 60, content: "Invalid", fontSize: 48 }],
    });
    expect(result.isError).toBe(true);
  });

  it("addTextsRejectsOutOfRangeTextScale", async () => {
    const h = new ToolHarness();
    addVideoTrack(h);
    const result = await h.runRaw("add_texts", {
      entries: [{ trackIndex: 0, startFrame: 0, endFrame: 60, content: "Invalid", style: { widthScale: 0 } }],
    });
    expect(result.isError).toBe(true);
    expect(h.editor.timeline.tracks[0].clips.length).toBe(0);
  });

  it("addTextsRejectsAudioTargetTrack", async () => {
    const h = new ToolHarness();
    insertTrack(h.editor, 0, "audio");
    const result = await h.runRaw("add_texts", { entries: [{ trackIndex: 0, startFrame: 0, endFrame: 30, content: "Subtitle" }] });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result).toLowerCase()).toContain("audio");
  });

  it("addTextsRejectsMixedTrackIndexUsage", async () => {
    const h = new ToolHarness();
    addVideoTrack(h);
    const result = await h.runRaw("add_texts", {
      entries: [
        { trackIndex: 0, startFrame: 0, endFrame: 30, content: "A" },
        { startFrame: 60, endFrame: 90, content: "B" }, // missing trackIndex
      ],
    });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("Mixed trackIndex");
  });

  it("addTextsRejectsZeroDuration", async () => {
    const h = new ToolHarness();
    addVideoTrack(h);
    const result = await h.runRaw("add_texts", { entries: [{ trackIndex: 0, startFrame: 0, endFrame: 0, content: "x" }] });
    expect(result.isError).toBe(true);
  });

  // MARK: - organize_media

  it("organizeCreatesNestedFolderPathsAndIsIdempotent", async () => {
    const h = new ToolHarness();
    const json = await h.runOK("organize_media", { createFolders: ["Refs/Stills"] });
    expect(json.createdFolders).toEqual(["Refs", "Refs/Stills"]);
    expect(folders(h).length).toBe(2);

    // Get-or-create: re-running reports an empty result and creates nothing.
    const again = await h.runOK("organize_media", { createFolders: ["Refs/Stills"] });
    expect(again.createdFolders).toBeUndefined();
    expect(folders(h).length).toBe(2);
  });

  it("organizeMovesAssetsIntoPathCreatedOnDemand", async () => {
    const h = new ToolHarness();
    const asset = makeNamedAsset(h, "clip");
    const json = await h.runOK("organize_media", { moves: [{ items: [asset.id], into: "Refs" }] });
    expect(json.moved).toBe(1);
    expect(json.createdFolders).toEqual(["Refs"]);
    const folderId = folders(h).find((f) => f.name === "Refs")?.id;
    expect(assetNamed(h, asset.id)?.folderId).toBe(folderId);

    // Omitting 'into' moves back to the root.
    await h.runOK("organize_media", { moves: [{ items: [asset.id] }] });
    expect(assetNamed(h, asset.id)?.folderId).toBeUndefined();
  });

  it("organizeReparentsFoldersAndRejectsCycles", async () => {
    const h = new ToolHarness();
    const a = createFolder(h.editor, "A");
    createFolder(h.editor, "B", a);

    const result = await h.runRaw("organize_media", { moves: [{ items: ["A"], into: "A/B" }] });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("into itself");

    // A rejected cycle must not leave partially-created destination folders behind.
    const deepCycle = await h.runRaw("organize_media", { moves: [{ items: ["A"], into: "A/B/Deep" }] });
    expect(deepCycle.isError).toBe(true);
    expect(folders(h).length).toBe(2);

    await h.runOK("organize_media", { moves: [{ items: ["A/B"], into: "Elsewhere" }] });
    const moved = folders(h).find((f) => f.name === "B");
    const elsewhere = folders(h).find((f) => f.name === "Elsewhere");
    expect(moved?.parentFolderId).toBe(elsewhere?.id);
  });

  it("organizeRenamesAssetsAndFoldersByPath", async () => {
    const h = new ToolHarness();
    const asset = makeNamedAsset(h, "raw");
    createFolder(h.editor, "Old");

    const json = await h.runOK("organize_media", {
      renames: [
        { item: asset.id, name: "Hero take" },
        { item: "Old", name: "New" },
      ],
    });
    expect(json.renamed).toBe(2);
    expect(assetNamed(h, asset.id)?.name).toBe("Hero take");
    expect(folders(h)[0]?.name).toBe("New");
  });

  it("organizeRejectsUnknownItemBeforeMutation", async () => {
    const h = new ToolHarness();
    const asset = makeNamedAsset(h, "keep");
    const result = await h.runRaw("organize_media", {
      moves: [
        { items: [asset.id], into: "Refs" },
        { items: ["ghost"], into: "Refs" },
      ],
    });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("not an asset id");
    expect(assetNamed(h, asset.id)?.folderId).toBeUndefined();
    expect(folders(h).length).toBe(0);
  });

  it("organizeDeletesAssetsAndReportsRemovedClips", async () => {
    const h = new ToolHarness();
    const asset = makeNamedAsset(h, "used");
    h.editor.withoutRegistration(() => {
      h.editor.timeline.tracks = [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", mediaRef: asset.id, start: 0, duration: 60 })] })];
    });

    const json = await h.runOK("organize_media", { deletes: [asset.id] });
    expect((json.deleted as Json).assets).toBe(1);
    expect(json.clipsRemoved).toBe(1);
    expect(h.editor.doc.mediaAssets.length).toBe(0);
    expect(h.editor.timeline.tracks.flatMap((t) => t.clips).length).toBe(0);
  });

  it("organizeDeletesFolderCascadeWithoutPhantomClipClaims", async () => {
    const h = new ToolHarness();
    const refs = createFolder(h.editor, "Refs");
    createFolder(h.editor, "Sub", refs);

    const json = await h.runOK("organize_media", { deletes: ["Refs"] });
    expect((json.deleted as Json).folders).toBe(1);
    // Empty folder: no clips were touched, so no clipsRemoved claim.
    expect(json.clipsRemoved).toBeUndefined();
    expect(folders(h).length).toBe(0);
  });

  it("organizeDeletesAcceptShortIdPrefixes", async () => {
    const h = new ToolHarness();
    const asset = makeNamedAsset(h, "prefixed");
    const json = await h.runOK("organize_media", { deletes: [asset.id.slice(0, 8)] });
    expect((json.deleted as Json).assets).toBe(1);
    expect(h.editor.doc.mediaAssets.length).toBe(0);
  });

  it("organizeRequiresAtLeastOneOperation", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("organize_media");
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("Nothing to do");
  });

  // MARK: - ripple_delete_ranges

  /** Seconds are the default unit and convert through fps/trim/speed — the inspect_media path. */
  it("rippleDeleteRangesConvertsSecondsThroughTrimAndSpeed", async () => {
    // 30fps, clip starts at frame 30, trimmed 60 source frames in. Source second 4.0 ->
    // frame 30 + (120 - 60) = 90; second 5.0 -> 30 + (150 - 60) = 120. Removing [90,120)
    // (30 frames) leaves the head [30,90) and slides the tail left to meet it.
    const h = new ToolHarness(
      Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 30, duration: 300, trimStart: 60 })] })] }),
    );
    const result = await h.runRaw("ripple_delete_ranges", { clipId: "c1", ranges: [[4.0, 5.0]], units: "seconds" });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    expect(spansOf(h)).toEqual([[30, 90], [90, 300]]);
  });

  it("rippleDeleteRangesDefaultsToFrames", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })] }));
    // No units -> frames. These are project frames, the unit inspect_media(clipId) emits.
    const result = await h.runRaw("ripple_delete_ranges", { clipId: "c1", ranges: [[40, 50]] });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    expect(spansOf(h)).toEqual([[0, 40], [40, 90]]);
  });

  it("rippleDeleteRangesRejectsUnknownClip", async () => {
    const h = new ToolHarness();
    const result = await h.runRaw("ripple_delete_ranges", { clipId: "missing", ranges: [[1.0, 2.0]] });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("Clip not found");
  });

  it("rippleDeleteRangesRejectsRangesOutsideClip", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 30 })] })] }));
    // Clip is 1s long at 30fps; a [10s, 11s] range can't overlap it.
    const result = await h.runRaw("ripple_delete_ranges", { clipId: "c1", ranges: [[10.0, 11.0]], units: "seconds" });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("within clip");
  });

  it("rippleDeleteRangesRejectsBadUnits", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 30 })] })] }));
    const result = await h.runRaw("ripple_delete_ranges", { clipId: "c1", ranges: [[0.0, 0.5]], units: "minutes" });
    expect(result.isError).toBe(true);
    expect(ToolHarness.textOf(result)).toContain("units");
  });

  it("rippleDeleteRangesReturnsResultingFragments", async () => {
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [Fixtures.clip({ id: "c1", start: 0, duration: 100 })] })] }));
    const json = await h.runOK("ripple_delete_ranges", { clipId: "c1", ranges: [[40, 50]] });
    expect(json.removedFrames).toBe(10);
    const clips = (json.clips as Json[] | undefined) ?? [];
    expect(clips.length).toBe(2);
    // Head keeps c1 at [0,40); tail is a new id at [40,90).
    expect(clips[0]?.id).toBe("c1");
    expect(clips[0]?.frames).toEqual([0, 40]);
    expect(clips[clips.length - 1]?.frames).toEqual([40, 90]);
    expect(clips[clips.length - 1]?.id).not.toBe("c1");
  });
});

describe("ToolExecutor — set_clip_properties", () => {
  it("updateTextCaptionGroupCollapsesToSummary", async () => {
    const clips = [0, 1, 2].map((i) => textClip(`cap-${i}`, i * 30, 30, `word${i}`, { group: "g1" }));
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips })] }));

    const result = await h.runRaw("update_text", { captionGroupId: "g1", style: { color: "#FF0000" } });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const json = JSON.parse(ToolHarness.textOf(result)) as Json;
    // >=3 caption members collapse to the group summary, not an enumeration.
    expect(json.clips).toBeUndefined();
    const group = (json.captionGroups as Json[] | undefined)?.[0];
    expect(group?.captionGroupId).toBe("g1");
    expect(group?.clipCount).toBe(3);
    expect(group?.textPreview).toBe("word0 … word2");
  });

  it("updateTextSingleCaptionReceiptPreservesDeviantStyle", async () => {
    const clips = [0, 1, 2].map((i) => textClip(`cap-${i}`, i * 30, 30, `word${i}`, { group: "g1", style: true }));
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips })] }));

    const result = await h.runRaw("update_text", { clipIds: ["cap-1"], style: { color: "#FF0000" } });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const json = JSON.parse(ToolHarness.textOf(result)) as Json;
    const receipt = (json.clips as Json[] | undefined)?.[0];
    const color = (receipt?.textStyle as Json | undefined)?.color as Json | undefined;
    expect(receipt?.id).toBe("cap-1");
    expect(receipt?.captionGroupId).toBe("g1");
    expect(color?.r).toBeUndefined();
    expect(color?.g).toBe(0);
    expect(color?.b).toBe(0);
  });

  it("updateTextCaptionGroupAcceptsRichTextStyleFields", async () => {
    const a = textClip("cap-a", 0, 30, "one", { group: "captions", style: true });
    const b = textClip("cap-b", 30, 30, "two", { group: "captions", style: true });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [a, b] })] }));

    const result = await h.runRaw("update_text", {
      captionGroupId: "captions",
      style: { alignment: "left", outline: { enabled: true, color: "#FFFFFF" }, background: { enabled: true, color: "#00000080" } },
    });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const json = JSON.parse(ToolHarness.textOf(result)) as Json;
    expect((json.clips as Json[] | undefined)?.length).toBe(2);
    for (const clip of h.editor.timeline.tracks[0].clips) {
      expect(clip.textStyle?.alignment).toBe("left");
      expect(clip.textStyle?.border.enabled).toBe(true);
      expect(clip.textStyle?.border.color).toEqual(rgbaFromHex("#FFFFFF"));
      expect(clip.textStyle?.background.enabled).toBe(true);
      expect(clip.textStyle?.background.color).toEqual(rgbaFromHex("#00000080"));
    }
  });

  it("updateTextNestedColorPreservesSeparateOpacity", async () => {
    const clip = Fixtures.clip({ id: "title", mediaRef: "text", mediaType: "text", start: 0, duration: 60 });
    const style: TextStyle = makeTextStyle();
    style.shadow = makeTextShadow({ color: makeRGBA({ r: 0, g: 0, b: 0, a: 0.25 }) });
    clip.textStyle = style;
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("update_text", { clipIds: ["title"], style: { shadow: { color: "#FF0000" } } });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks[0].clips[0].textStyle?.shadow.color).toEqual({ r: 1, g: 0, b: 0, a: 0.25 });
  });

  it("updateTextAnimationPreservesExistingHighlight", async () => {
    const highlight = makeRGBA({ r: 1, g: 0, b: 0, a: 1 });
    const clip = Fixtures.clip({ id: "title", mediaRef: "text", mediaType: "text", start: 0, duration: 60 });
    clip.textContent = "Title";
    clip.textAnimation = makeTextAnimation({ preset: "highlightPop", perWordFrames: 12, highlight });
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("update_text", { clipIds: ["title"], animation: "wordSlide" });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    const animation = h.editor.timeline.tracks[0].clips[0].textAnimation;
    expect(animation?.preset).toBe("wordSlide");
    expect(animation?.perWordFrames).toBe(12);
    expect(animation?.highlight).toEqual(highlight);
  });

  it("updateTextContentClearsWordTimings", async () => {
    const clip = textClip("title", 0, 60, "old text", { style: true });
    clip.mediaRef = "text";
    clip.wordTimings = [
      { text: "old", startFrame: 0, endFrame: 30 },
      { text: "text", startFrame: 30, endFrame: 60 },
    ];
    const h = new ToolHarness(Fixtures.timeline({ tracks: [Fixtures.videoTrack({ clips: [clip] })] }));

    const result = await h.runRaw("update_text", { clipIds: ["title"], content: "new text" });
    expect(result.isError, ToolHarness.textOf(result)).toBe(false);
    expect(h.editor.timeline.tracks[0].clips[0].wordTimings).toBeUndefined();
  });
});
