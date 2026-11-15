// Pure view model of the Media tab (MediaTab, +Grids, +Search): sort / filter / search, folder / flat / grouped
// sections, breadcrumb, item counts. No DOM and no signals.
import {
  mediaAssetIsGenerated, type ClipType, type MediaAsset, type MediaFolder, type Timeline,
} from "../model";
import { makeMediaFolderIndex, mediaFolderIndexPath } from "../media/folderIndex";
import { mediaPanelFolderKey, mediaPanelTimelineKey } from "../media/mediaLibrary";
import { swiftRound } from "../util/math";

export type ViewMode = "folder" | "flat" | "grouped";
export type SortMode = "name" | "dateAdded" | "duration" | "type";

export const viewModes: readonly ViewMode[] = ["folder", "flat", "grouped"];
export const viewModeTitles: Record<ViewMode, string> = { folder: "Folders", flat: "Flat", grouped: "Grouped" };
export const sortModes: readonly SortMode[] = ["name", "dateAdded", "duration", "type"];
export const sortModeTitles: Record<SortMode, string> = {
  name: "Name", dateAdded: "Date Added", duration: "Duration", type: "Type",
};
/** Only types that can appear in the panel; text clips never become assets. */
export const filterableTypes: readonly ClipType[] = ["video", "audio", "image", "subtitle"];
export const thumbnailPresets = [
  { title: "Small", size: 80 },
  { title: "Medium", size: 110 },
  { title: "Large", size: 150 },
  { title: "Extra Large", size: 200 },
] as const;
export const defaultThumbnailSize = 80;

export interface PanelFilters {
  sortMode: SortMode;
  filterTypes: ReadonlySet<ClipType>;
  filterAI: boolean;
  searchQuery: string;
}

export interface PanelData {
  assets: readonly MediaAsset[];
  folders: readonly MediaFolder[];
  timelines: readonly Timeline[];
}

export interface PanelItem {
  key: string;
  kind: "folder" | "timeline" | "asset";
  id: string;
}

export interface PanelSection {
  /** "" is the Library root; folder id otherwise; "timelines" / "files" in search results. */
  key: string;
  /** Null for the headerless folder and flat modes. */
  title: string | null;
  /** Grouped mode only: opens this folder. */
  folderId?: string;
  collapsible: boolean;
  collapsed: boolean;
  items: PanelItem[];
}

const collator = new Intl.Collator(undefined, { sensitivity: "accent" });

export function trimmedQuery(query: string): string {
  return query.trim();
}

/** `localizedCaseInsensitiveContains`; an empty query matches everything. */
export function nameMatches(name: string, query: string): boolean {
  const q = trimmedQuery(query);
  return q === "" || name.toLocaleLowerCase().includes(q.toLocaleLowerCase());
}

export function hasActiveFilters(f: Pick<PanelFilters, "filterTypes" | "filterAI">): boolean {
  return f.filterTypes.size > 0 || f.filterAI;
}

export function passesFilters(asset: MediaAsset, f: PanelFilters): boolean {
  const typeOk = f.filterTypes.size === 0 || f.filterTypes.has(asset.type);
  const aiOk = !f.filterAI || mediaAssetIsGenerated(asset);
  return typeOk && aiOk && nameMatches(asset.name, f.searchQuery);
}

export function sortAndFilter(assets: readonly MediaAsset[], f: PanelFilters): MediaAsset[] {
  const filtered = assets.filter((a) => passesFilters(a, f));
  switch (f.sortMode) {
    case "dateAdded": return filtered;
    case "name": return filtered.sort((a, b) => collator.compare(a.name, b.name));
    case "duration": return filtered.sort((a, b) => b.duration - a.duration);
    case "type": return filtered.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  }
}

export function timelinesMatchingName<T extends { name: string }>(timelines: readonly T[], query: string): T[] {
  return timelines.filter((t) => nameMatches(t.name, query));
}

const assetItem = (a: MediaAsset): PanelItem => ({ key: a.id, kind: "asset", id: a.id });
const timelineItem = (t: Timeline): PanelItem => ({ key: mediaPanelTimelineKey(t.id), kind: "timeline", id: t.id });
const folderItem = (f: MediaFolder): PanelItem => ({ key: mediaPanelFolderKey(f.id), kind: "folder", id: f.id });

export function subfoldersOf(folders: readonly MediaFolder[], parentId: string | undefined): MediaFolder[] {
  return folders.filter((f) => f.parentFolderId === parentId).sort((a, b) => collator.compare(a.name, b.name));
}

/** Folders (name-filtered by the query), then timelines, then assets of one folder. */
export function folderModeItems(data: PanelData, currentFolderId: string | undefined, f: PanelFilters): PanelItem[] {
  const folders = subfoldersOf(data.folders, currentFolderId).filter((x) => nameMatches(x.name, f.searchQuery));
  const timelines = timelinesMatchingName(data.timelines.filter((t) => t.folderId === currentFolderId), f.searchQuery);
  const assets = sortAndFilter(data.assets.filter((a) => a.folderId === currentFolderId), f);
  return [...folders.map(folderItem), ...timelines.map(timelineItem), ...assets.map(assetItem)];
}

export function flatModeItems(data: PanelData, f: PanelFilters): PanelItem[] {
  return [
    ...timelinesMatchingName(data.timelines, f.searchQuery).map(timelineItem),
    ...sortAndFilter(data.assets, f).map(assetItem),
  ];
}

export interface FolderWithPath {
  folder: MediaFolder;
  /** "A / B / C". */
  path: string;
  depth: number;
}

/** Every folder ordered by full path so parents precede children and siblings cluster. */
export function foldersWithPaths(folders: readonly MediaFolder[]): FolderWithPath[] {
  const index = makeMediaFolderIndex(folders);
  return folders
    .map((folder) => {
      const chain = mediaFolderIndexPath(index, folder.id);
      return { folder, path: chain.map((p) => p.name).join(" / "), depth: chain.length - 1 };
    })
    .sort((a, b) => collator.compare(a.path, b.path));
}

/** Library first, then every folder ordered by full path so parents precede children. */
export function groupedModeSections(data: PanelData, f: PanelFilters, collapsedKeys: ReadonlySet<string>): PanelSection[] {
  const buckets = new Map<string | undefined, MediaAsset[]>();
  for (const asset of data.assets) {
    const bucket = buckets.get(asset.folderId);
    if (bucket) bucket.push(asset);
    else buckets.set(asset.folderId, [asset]);
  }
  const withPath = foldersWithPaths(data.folders);
  const sectionFor = (key: string, title: string, folderId: string | undefined): PanelSection => ({
    key,
    title,
    ...(folderId !== undefined ? { folderId } : {}),
    collapsible: true,
    collapsed: collapsedKeys.has(key),
    items: [
      ...timelinesMatchingName(data.timelines.filter((t) => t.folderId === folderId), f.searchQuery).map(timelineItem),
      ...sortAndFilter(buckets.get(folderId) ?? [], f).map(assetItem),
    ],
  });
  const sections: PanelSection[] = [];
  const root = sectionFor("", "Library", undefined);
  if (root.items.length > 0) sections.push(root);
  for (const { folder, path } of withPath) sections.push(sectionFor(folder.id, path, folder.id));
  return sections;
}

/**
 * Name search replaces the browse view: visual moments (best match first), matching timelines, then matching files across
 * the whole library. A tile appears once, so a file already shown under Moments is left out of Files.
 */
export function searchSections(data: PanelData, f: PanelFilters, momentAssetIds: readonly string[] = []): PanelSection[] {
  const known = new Set(data.assets.map((a) => a.id));
  const momentIds = [...new Set(momentAssetIds)].filter((id) => known.has(id));
  const moments = momentIds.map((id): PanelItem => ({ key: id, kind: "asset", id }));
  const shown = new Set(momentIds);
  const timelines = timelinesMatchingName(data.timelines, f.searchQuery).map(timelineItem);
  const files = sortAndFilter(data.assets, f).filter((a) => !shown.has(a.id)).map(assetItem);
  const sections: PanelSection[] = [];
  if (moments.length > 0) sections.push({ key: "moments", title: "Moments", collapsible: false, collapsed: false, items: moments });
  if (timelines.length > 0) sections.push({ key: "timelines", title: "Timelines", collapsible: false, collapsed: false, items: timelines });
  if (files.length > 0) sections.push({ key: "files", title: "Files", collapsible: false, collapsed: false, items: files });
  return sections;
}

export interface SectionInput {
  data: PanelData;
  filters: PanelFilters;
  viewMode: ViewMode;
  currentFolderId: string | undefined;
  collapsedGroupedKeys: ReadonlySet<string>;
  /** Assets whose frames matched a visual search of the query, best first. */
  momentAssetIds?: readonly string[];
}

export function buildSections(input: SectionInput): PanelSection[] {
  const { data, filters } = input;
  if (trimmedQuery(filters.searchQuery) !== "") return searchSections(data, filters, input.momentAssetIds);
  const headerless = (items: PanelItem[]): PanelSection[] => [
    { key: "", title: null, collapsible: false, collapsed: false, items },
  ];
  switch (input.viewMode) {
    case "folder": return headerless(folderModeItems(data, input.currentFolderId, filters));
    case "flat": return headerless(flatModeItems(data, filters));
    case "grouped": return groupedModeSections(data, filters, input.collapsedGroupedKeys);
  }
}

/** Display order across expanded sections; an item shown twice keeps its first position. */
export function orderedItemKeys(sections: readonly PanelSection[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const section of sections) {
    if (section.collapsed) continue;
    for (const item of section.items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);
      out.push(item.key);
    }
  }
  return out;
}

/** `searchOrderedItemIds`: collapsed moment / spoken sections drop out; later duplicates are removed. */
export function searchOrderedItemIds(p: {
  momentAssetIds: readonly string[];
  spokenAssetIds: readonly string[];
  timelineItemIds: readonly string[];
  fileAssetIds: readonly string[];
  collapsedSectionTitles: ReadonlySet<string>;
}): string[] {
  const sections = [
    p.collapsedSectionTitles.has("Moments") ? [] : p.momentAssetIds,
    p.collapsedSectionTitles.has("Spoken") ? [] : p.spokenAssetIds,
    p.timelineItemIds,
    p.fileAssetIds,
  ];
  const seen = new Set<string>();
  return sections.flat().filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export interface BreadcrumbItem {
  folderId: string | undefined;
  name: string;
}

export function breadcrumbItems(folderPath: readonly MediaFolder[]): BreadcrumbItem[] {
  return [{ folderId: undefined, name: "Library" }, ...folderPath.map((f) => ({ folderId: f.id, name: f.name }))];
}

export function itemCountLabel(count: number): string {
  return count === 1 ? "1 item" : `${count} items`;
}

/** Swift counts the current folder's contents in every view mode. */
export function currentFolderItemCount(data: PanelData, currentFolderId: string | undefined, f: PanelFilters): number {
  return folderModeItems(data, currentFolderId, f).length;
}

export function showsEmptyState(data: PanelData): boolean {
  return data.assets.length === 0 && data.folders.length === 0;
}

/** Folder navigation state machine: opening a folder from flat / grouped remembers the mode to return to. */
export interface Navigation {
  currentFolderId: string | undefined;
  viewMode: ViewMode;
  folderReturnViewMode: ViewMode | undefined;
}

export function openFolder(nav: Navigation, id: string): Navigation {
  return {
    currentFolderId: id,
    viewMode: "folder",
    folderReturnViewMode: nav.viewMode !== "folder" ? nav.viewMode : nav.folderReturnViewMode,
  };
}

export function navigateToFolder(nav: Navigation, folderId: string | undefined): Navigation {
  if (folderId === undefined && nav.folderReturnViewMode !== undefined) {
    return { currentFolderId: undefined, viewMode: nav.folderReturnViewMode, folderReturnViewMode: undefined };
  }
  return { ...nav, currentFolderId: folderId };
}

export function setViewMode(nav: Navigation, mode: ViewMode): Navigation {
  return { ...nav, viewMode: mode, folderReturnViewMode: undefined };
}

export function navigateUp(nav: Navigation, folders: readonly MediaFolder[]): Navigation {
  const current = nav.currentFolderId;
  if (current === undefined) return nav;
  const folder = folders.find((f) => f.id === current);
  return folder ? navigateToFolder(nav, folder.parentFolderId) : nav;
}

/** `formatMediaTileDuration`: 0s, 45s, 2:05, 1:02:03. */
export function formatMediaTileDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || !(seconds > 0)) return "0s";
  const total = Math.max(1, swiftRound(seconds));
  const hours = Math.trunc(total / 3600);
  const minutes = Math.trunc((total % 3600) / 60);
  const secs = total % 60;
  const two = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  if (hours > 0) return `${hours}:${two(minutes)}:${two(secs)}`;
  if (minutes > 0) return `${minutes}:${two(secs)}`;
  return `${secs}s`;
}
