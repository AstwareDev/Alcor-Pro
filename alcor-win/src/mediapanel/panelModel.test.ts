import { describe, expect, it } from "vitest";
import {
  makeGenerationInput, makeMediaAsset, makeMediaFolder, makeTimeline, type ClipType, type MediaAsset,
} from "../model";
import { mediaPanelFolderKey, mediaPanelTimelineKey } from "../media/library";
import {
  breadcrumbItems, buildSections, currentFolderItemCount, folderModeItems, formatMediaTileDuration, itemCountLabel,
  nameMatches, navigateToFolder, navigateUp, openFolder, orderedItemKeys, searchOrderedItemIds, setViewMode,
  sortAndFilter, timelinesMatchingName, type Navigation, type PanelData, type PanelFilters, type SectionInput,
} from "./panelModel";

let n = 0;
function asset(name: string, p: { type?: ClipType; duration?: number; folderId?: string; ai?: boolean } = {}): MediaAsset {
  n += 1;
  const a = makeMediaAsset({ id: `a${n}`, url: `/x/${name}`, type: p.type ?? "video", name, duration: p.duration ?? 0 });
  if (p.folderId !== undefined) a.folderId = p.folderId;
  if (p.ai) a.generationInput = makeGenerationInput({ prompt: "p", model: "m", duration: 1, aspectRatio: "16:9" });
  return a;
}
const filters = (p: Partial<PanelFilters> = {}): PanelFilters => ({
  sortMode: "dateAdded", filterTypes: new Set<ClipType>(), filterAI: false, searchQuery: "", ...p,
});

describe("sort / filter / search", () => {
  const assets = [
    asset("banana", { duration: 5, type: "audio" }),
    asset("Apple", { duration: 30 }),
    asset("cherry", { duration: 10, type: "image", ai: true }),
  ];
  it("dateAddedKeepsImportOrder", () => {
    expect(sortAndFilter(assets, filters()).map((a) => a.name)).toEqual(["banana", "Apple", "cherry"]);
  });
  it("nameSortIsCaseInsensitive", () => {
    expect(sortAndFilter(assets, filters({ sortMode: "name" })).map((a) => a.name)).toEqual(["Apple", "banana", "cherry"]);
  });
  it("durationSortsLongestFirst", () => {
    expect(sortAndFilter(assets, filters({ sortMode: "duration" })).map((a) => a.name)).toEqual(["Apple", "cherry", "banana"]);
  });
  it("typeSortsByRawValue", () => {
    expect(sortAndFilter(assets, filters({ sortMode: "type" })).map((a) => a.type)).toEqual(["audio", "image", "video"]);
  });
  it("typeFilterAndAIFilter", () => {
    expect(sortAndFilter(assets, filters({ filterTypes: new Set<ClipType>(["audio", "image"]) }))).toHaveLength(2);
    expect(sortAndFilter(assets, filters({ filterAI: true })).map((a) => a.name)).toEqual(["cherry"]);
  });
  it("searchIsCaseInsensitiveAndTrimmed", () => {
    expect(sortAndFilter(assets, filters({ searchQuery: "  APP " })).map((a) => a.name)).toEqual(["Apple"]);
    expect(nameMatches("x", "   ")).toBe(true);
    expect(nameMatches("x", "y")).toBe(false);
  });
  it("sortAndFilterDoesNotMutateInput", () => {
    const copy = [...assets];
    sortAndFilter(assets, filters({ sortMode: "name" }));
    expect(assets).toEqual(copy);
  });
});

describe("timelinesMatchingName", () => {
  it("filtersCaseInsensitively", () => {
    const interview = makeTimeline({ name: "Interview Cut" });
    const broll = makeTimeline({ name: "B-Roll" });
    const cold = makeTimeline({ name: "Cold Open" });
    expect(timelinesMatchingName([interview, broll, cold], " cut ").map((t) => t.id)).toEqual([interview.id]);
    expect(timelinesMatchingName([interview, broll], "B-ROLL").map((t) => t.id)).toEqual([broll.id]);
    expect(timelinesMatchingName([interview], "   ").map((t) => t.id)).toEqual([interview.id]);
    expect(timelinesMatchingName([interview, broll], "missing")).toEqual([]);
  });
});

describe("search ordering", () => {
  it("orderIncludesVisibleSectionsAndDeduplicatesAssets", () => {
    const timelineKey = mediaPanelTimelineKey("tl-1");
    expect(searchOrderedItemIds({
      momentAssetIds: ["moment", "shared"], spokenAssetIds: ["spoken", "shared"], timelineItemIds: [timelineKey],
      fileAssetIds: ["file", "shared"], collapsedSectionTitles: new Set(["Spoken"]),
    })).toEqual(["moment", "shared", timelineKey, "file"]);
  });
});

describe("sections", () => {
  const root = makeMediaFolder({ name: "Root" });
  const child = makeMediaFolder({ name: "Child", parentFolderId: root.id });
  const zed = makeMediaFolder({ name: "Zed" });
  const inRoot = asset("in-root", { folderId: root.id });
  const inChild = asset("in-child", { folderId: child.id });
  const loose = asset("loose");
  const tl = makeTimeline({ name: "Cut", folderId: root.id });
  const tlLoose = makeTimeline({ name: "Main" });
  const data: PanelData = { assets: [inRoot, inChild, loose], folders: [zed, child, root], timelines: [tlLoose, tl] };
  const input = (p: Partial<SectionInput> = {}): SectionInput => ({
    data, filters: filters(), viewMode: "folder", currentFolderId: undefined, collapsedGroupedKeys: new Set<string>(), ...p,
  });

  it("folderModeListsFoldersThenTimelinesThenAssets", () => {
    expect(folderModeItems(data, undefined, filters()).map((i) => i.key)).toEqual([
      mediaPanelFolderKey(root.id), mediaPanelFolderKey(zed.id), mediaPanelTimelineKey(tlLoose.id), loose.id,
    ]);
    expect(folderModeItems(data, root.id, filters()).map((i) => i.key)).toEqual([
      mediaPanelFolderKey(child.id), mediaPanelTimelineKey(tl.id), inRoot.id,
    ]);
  });
  it("flatModeShowsEveryTimelineAndAssetWithoutFolders", () => {
    const keys = orderedItemKeys(buildSections(input({ viewMode: "flat" })));
    expect(keys).toEqual([mediaPanelTimelineKey(tlLoose.id), mediaPanelTimelineKey(tl.id), inRoot.id, inChild.id, loose.id]);
  });
  it("groupedModeOrdersByPathAndHonoursCollapse", () => {
    const sections = buildSections(input({ viewMode: "grouped" }));
    expect(sections.map((s) => s.title)).toEqual(["Library", "Root", "Root / Child", "Zed"]);
    const collapsed = buildSections(input({ viewMode: "grouped", collapsedGroupedKeys: new Set([root.id]) }));
    expect(orderedItemKeys(collapsed)).not.toContain(inRoot.id);
    expect(orderedItemKeys(collapsed)).toContain(inChild.id);
  });
  it("searchReplacesBrowseViewWithTimelinesThenFiles", () => {
    const sections = buildSections(input({ filters: filters({ searchQuery: "i" }) }));
    expect(sections.map((s) => s.key)).toEqual(["timelines", "files"]);
    expect(buildSections(input({ filters: filters({ searchQuery: "zzz" }) }))).toEqual([]);
  });
  it("searchPutsVisualMomentsFirstAndShowsEachFileOnce", () => {
    const sections = buildSections(input({
      filters: filters({ searchQuery: "i" }), momentAssetIds: [loose.id, "gone", inRoot.id, loose.id],
    }));
    expect(sections.map((s) => s.key)[0]).toBe("moments");
    expect(sections[0]?.items.map((i) => i.key)).toEqual([loose.id, inRoot.id]);
    const keys = orderedItemKeys(sections);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe(loose.id);
  });
  it("itemCountCountsCurrentFolderContents", () => {
    expect(currentFolderItemCount(data, undefined, filters())).toBe(4);
    expect(itemCountLabel(1)).toBe("1 item");
    expect(itemCountLabel(4)).toBe("4 items");
  });
});

describe("breadcrumb and navigation", () => {
  const nav: Navigation = { currentFolderId: undefined, viewMode: "flat", folderReturnViewMode: undefined };
  const a = makeMediaFolder({ name: "A" });
  const b = makeMediaFolder({ name: "B", parentFolderId: a.id });
  it("breadcrumbStartsAtLibrary", () => {
    expect(breadcrumbItems([a, b]).map((c) => c.name)).toEqual(["Library", "A", "B"]);
    expect(breadcrumbItems([])).toEqual([{ folderId: undefined, name: "Library" }]);
  });
  it("openingFromFlatReturnsToFlatAtRoot", () => {
    const inside = openFolder(nav, a.id);
    expect(inside).toEqual({ currentFolderId: a.id, viewMode: "folder", folderReturnViewMode: "flat" });
    expect(navigateToFolder(inside, b.id).viewMode).toBe("folder");
    expect(navigateToFolder(inside, undefined)).toEqual({ currentFolderId: undefined, viewMode: "flat", folderReturnViewMode: undefined });
  });
  it("navigateUpGoesToParentAndStopsAtRoot", () => {
    const at: Navigation = { currentFolderId: b.id, viewMode: "folder", folderReturnViewMode: undefined };
    expect(navigateUp(at, [a, b]).currentFolderId).toBe(a.id);
    expect(navigateUp(navigateUp(at, [a, b]), [a, b]).currentFolderId).toBeUndefined();
    expect(navigateUp({ ...at, currentFolderId: undefined }, [a, b]).currentFolderId).toBeUndefined();
  });
  it("settingAViewModeForgetsTheReturnMode", () => {
    expect(setViewMode(openFolder(nav, a.id), "grouped").folderReturnViewMode).toBeUndefined();
  });
});

describe("formatMediaTileDuration", () => {
  it.each([[0, "0s"], [NaN, "0s"], [0.2, "1s"], [45, "45s"], [125, "2:05"], [3723, "1:02:03"], [59.6, "1:00"]])("%s -> %s", (s, out) => {
    expect(formatMediaTileDuration(s)).toBe(out);
  });
});
