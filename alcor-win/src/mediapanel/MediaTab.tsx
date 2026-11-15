import ArrowUpDown from "lucide-solid/icons/arrow-up-down";
import ChevronRight from "lucide-solid/icons/chevron-right";
import CircleCheck from "lucide-solid/icons/circle-check";
import Ellipsis from "lucide-solid/icons/ellipsis";
import Images from "lucide-solid/icons/images";
import LayoutGrid from "lucide-solid/icons/layout-grid";
import ListFilter from "lucide-solid/icons/list-filter";
import TriangleAlert from "lucide-solid/icons/triangle-exclamation-point";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { clipTypeTrackLabel, type ClipType, type MediaAsset, type Timeline } from "../model";
import type { Editor } from "../editor/editor";
import {
  clearMediaPanelSelection, createMediaPanelFolder, deleteMediaPanelItems, handleClipboardPaste,
  mediaPanelSelectedKeys, moveMediaSelection, resolveTextDrop, selectAllMediaPanelItems, selectMediaPanelItem,
  type MediaSelectionDirection,
} from "../editor/mutations/mediaPanel";
import { activateTimeline, duplicateTimeline, renameTimeline } from "../editor/mutations/timelines";
import {
  folderPath, mediaPanelFolderIdFromKey, mediaPanelFolderKey, mediaPanelTimelineIdFromKey,
  moveAssetsToFolder, relinkAsset, renameFolder, renameMediaAsset, createFolder,
} from "../media/library";
import { CapsuleButton } from "../ui/CapsuleButton";
import { aiEditAssetMenuItems } from "../generation/aiEditMenu";
import { ContextMenu, menuSections, type ContextMenuItem } from "../ui/ContextMenu";
import { ExpandableSearch } from "../ui/ExpandableSearch";
import { IconMenuButton } from "../ui/IconMenuButton";
import type { MenuItem } from "../ui/Menu";
import { mediaDropEventName, type MediaDropDetail } from "./dragSession";
import { searchIndexFor } from "../visualsearch/searchService";
import { SearchIndexStatus } from "../visualsearch/SearchIndexStatus";
import { MediaGrid } from "./MediaGrid";
import { installOsFileDrop } from "./osFileDrop";
import {
  breadcrumbItems, buildSections, currentFolderItemCount, defaultThumbnailSize, filterableTypes, foldersWithPaths,
  hasActiveFilters, itemCountLabel, navigateToFolder, navigateUp, openFolder, setViewMode, showsEmptyState,
  sortModes, sortModeTitles, thumbnailPresets, viewModes, viewModeTitles,
  type Navigation, type PanelData, type PanelFilters, type PanelSection, type SortMode, type ViewMode,
} from "./panelModel";
import { tauriMediaPanelServices, type MediaPanelServices } from "./services";
import { defaultThumbnailProvider, type ThumbnailProvider } from "./thumbnailProvider";
import "./mediaPanel.css";

export interface MediaTabProps {
  editor: Editor;
  onGenerate?: () => void;
  generationPanel?: () => JSX.Element;
  thumbnailProvider?: ThumbnailProvider;
  services?: MediaPanelServices;
}

const imageExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/tiff": "tiff", "image/gif": "gif", "image/bmp": "bmp",
};

const arrowDirections: Record<string, MediaSelectionDirection> = {
  ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
};

export function MediaTab(props: MediaTabProps) {
  const editor = props.editor;
  const services = props.services ?? tauriMediaPanelServices;
  const provider = props.thumbnailProvider ?? defaultThumbnailProvider;

  const [sortMode, setSortMode] = createSignal<SortMode>("dateAdded");
  const [filterTypes, setFilterTypes] = createSignal<ReadonlySet<ClipType>>(new Set());
  const [filterAI, setFilterAI] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [momentAssetIds, setMomentAssetIds] = createSignal<readonly string[]>([]);
  const [thumbnailSize, setThumbnailSize] = createSignal(defaultThumbnailSize);
  const [nav, setNav] = createSignal<Navigation>({ currentFolderId: undefined, viewMode: "folder", folderReturnViewMode: undefined });
  const [renamingKey, setRenamingKey] = createSignal<string | null>(null);
  const [collapsedKeys, setCollapsedKeys] = createSignal<ReadonlySet<string>>(new Set());
  const [osDropHover, setOsDropHover] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  let root!: HTMLDivElement;

  const data = createMemo<PanelData>(() => ({
    assets: editor.mediaAssets,
    folders: editor.doc.mediaManifest.folders,
    timelines: editor.timelines,
  }));
  const filters = createMemo<PanelFilters>(() => ({
    sortMode: sortMode(), filterTypes: filterTypes(), filterAI: filterAI(), searchQuery: searchQuery(),
  }));
  const sections = createMemo<PanelSection[]>(
    () => buildSections({
      data: data(), filters: filters(), viewMode: nav().viewMode,
      currentFolderId: nav().currentFolderId, collapsedGroupedKeys: collapsedKeys(), momentAssetIds: momentAssetIds(),
    }),
    [],
    {
      equals: (a, b) =>
        a.length === b.length &&
        a.every((s, i) => {
          const o = b[i];
          return s.key === o.key && s.title === o.title && s.collapsed === o.collapsed && s.items.length === o.items.length &&
            s.items.every((item, j) => item.key === o.items[j].key);
        }),
    },
  );

  const assetById = createMemo(() => new Map(editor.mediaAssets.map((a) => [a.id, a])));
  const timelineById = createMemo(() => new Map(editor.timelines.map((t) => [t.id, t])));
  const folderById = createMemo(() => new Map(editor.doc.mediaManifest.folders.map((f) => [f.id, f])));
  const usedAssets = createMemo(() => {
    const ids = new Set<string>();
    for (const track of editor.timeline.tracks) for (const clip of track.clips) ids.add(clip.mediaRef);
    return ids;
  });
  const childCounts = createMemo(() => {
    const counts = new Map<string, number>();
    const bump = (id: string | undefined) => {
      if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
    };
    for (const f of editor.doc.mediaManifest.folders) bump(f.parentFolderId);
    for (const a of editor.mediaAssets) bump(a.folderId);
    return counts;
  });
  const selectedAssets = createMemo(() => editor.ui.selectedMediaAssetIds);
  const selectedFolders = createMemo(() => editor.ui.selectedFolderIds);
  const selectedTimelines = createMemo(() => editor.ui.selectedTimelineIds);
  const isSelected = (key: string): boolean => {
    const folderId = mediaPanelFolderIdFromKey(key);
    if (folderId !== undefined) return selectedFolders().has(folderId);
    const timelineId = mediaPanelTimelineIdFromKey(key);
    if (timelineId !== undefined) return selectedTimelines().has(timelineId);
    return selectedAssets().has(key);
  };
  const timelinePosterAsset = (t: Timeline): MediaAsset | undefined => {
    for (const track of t.tracks) {
      if (track.type !== "video") continue;
      for (const clip of track.clips) {
        if (clip.mediaType !== "video" && clip.mediaType !== "image") continue;
        const asset = assetById().get(clip.mediaRef);
        if (asset) return asset;
      }
    }
    return undefined;
  };

  // ---- navigation ----

  createEffect(() => {
    editor.ui.mediaPanelCurrentFolderId = nav().currentFolderId ?? null;
  });
  createEffect(() => {
    const current = nav().currentFolderId;
    if (current !== undefined && !folderById().has(current)) setNav((n) => navigateToFolder(n, undefined));
    const renaming = renamingKey();
    if (renaming !== null) {
      const folderId = mediaPanelFolderIdFromKey(renaming);
      if (folderId !== undefined && !folderById().has(folderId)) setRenamingKey(null);
    }
  });
  createEffect(() => {
    if (showsEmptyState(data())) clearMediaPanelSelection(editor);
  });

  const open = (id: string) => {
    if (!folderById().has(id)) return;
    setNav((n) => openFolder(n, id));
    clearMediaPanelSelection(editor);
  };
  const goUp = () => setNav((n) => navigateUp(n, data().folders));
  const openKey = (key: string) => {
    const folderId = mediaPanelFolderIdFromKey(key);
    const timelineId = mediaPanelTimelineIdFromKey(key);
    if (folderId !== undefined) open(folderId);
    else if (timelineId !== undefined) activateTimeline(editor, timelineId);
  };
  const newFolderInCurrent = () => {
    setSearchQuery("");
    setNav((n) => setViewMode(n, "folder"));
    setRenamingKey(mediaPanelFolderKey(createMediaPanelFolder(editor, nav().currentFolderId)));
  };

  // ---- import / OS actions ----

  const importFiles = async () => {
    const paths = await services.pickMediaFiles();
    if (paths && paths.length > 0) await services.importPaths(editor, paths, nav().currentFolderId);
  };
  const importFolder = async () => {
    const path = await services.pickFolder();
    if (path) await services.importPaths(editor, [path], nav().currentFolderId);
  };
  const relink = async (asset: MediaAsset) => {
    const path = await services.pickRelinkFile(asset.name);
    if (path) relinkAsset(editor, asset.id, path);
  };
  const assetsForIds = (ids: readonly string[]) => editor.mediaAssets.filter((a) => ids.includes(a.id));

  // ---- rename ----

  const commitRename = (key: string, name: string) => {
    const folderId = mediaPanelFolderIdFromKey(key);
    const timelineId = mediaPanelTimelineIdFromKey(key);
    if (folderId !== undefined) renameFolder(editor, folderId, name);
    else if (timelineId !== undefined) renameTimeline(editor, timelineId, name);
    else renameMediaAsset(editor, key, name);
    setRenamingKey(null);
  };

  // ---- context menus ----

  const moveMenu = (targetIds: Set<string>): ContextMenuItem[] => {
    const anyInFolder = [...targetIds].some((id) => editor.mediaAsset(id)?.folderId !== undefined);
    const move = (folderId: string | undefined) => moveAssetsToFolder(editor, targetIds, folderId);
    return [{
      kind: "item",
      label: "Move to Folder",
      submenu: [
        {
          kind: "item", label: "New Folder",
          onSelect: () => {
            const id = createFolder(editor, "New Folder", nav().currentFolderId);
            move(id);
            setRenamingKey(mediaPanelFolderKey(id));
          },
        },
        ...(nav().currentFolderId !== undefined || anyInFolder
          ? [{ kind: "item" as const, label: "Library", onSelect: () => move(undefined) }]
          : []),
        { kind: "divider" },
        ...foldersWithPaths(data().folders).map<ContextMenuItem>(({ folder, path }) => ({
          kind: "item", label: path, onSelect: () => move(folder.id),
        })),
      ],
    }];
  };

  const assetMenu = (asset: MediaAsset): ContextMenuItem[] => {
    const ids = isSelected(asset.id) ? editor.mediaAssets.filter((a) => selectedAssets().has(a.id)).map((a) => a.id) : [asset.id];
    const single = ids.length === 1;
    const missing = editor.ui.missingMediaRefs.has(asset.id);
    const targets = assetsForIds(ids);
    return menuSections(
      moveMenu(new Set(ids)),
      single
        ? [
            ...(missing ? [{ kind: "item" as const, label: "Relink…", onSelect: () => void relink(asset) }] : []),
            { kind: "item", label: "Rename", onSelect: () => setRenamingKey(asset.id) },
            ...aiEditAssetMenuItems(editor, asset),
          ]
        : [],
      [
        { kind: "item", label: "Show in Explorer", onSelect: () => void services.revealInExplorer(targets.map((a) => a.url)) },
        { kind: "item", label: "Copy Path", onSelect: () => void services.copyText(targets.map((a) => a.url).join("\n")) },
      ],
      [{ kind: "item", label: "Delete", destructive: true, onSelect: () => deleteMediaPanelItems(editor, asset.id) }],
    );
  };

  const folderMenu = (id: string): ContextMenuItem[] => {
    const key = mediaPanelFolderKey(id);
    return menuSections(
      [
        { kind: "item", label: "Open", onSelect: () => open(id) },
        { kind: "item", label: "Rename", onSelect: () => setRenamingKey(key) },
      ],
      [{ kind: "item", label: "Delete", destructive: true, onSelect: () => deleteMediaPanelItems(editor, key) }],
    );
  };

  const timelineMenu = (id: string, key: string): ContextMenuItem[] => {
    const canDelete = editor.timelines.length > 1;
    return menuSections(
      [
        { kind: "item", label: "Open", onSelect: () => activateTimeline(editor, id) },
        { kind: "item", label: "Rename", onSelect: () => setRenamingKey(key) },
        { kind: "item", label: "Duplicate", onSelect: () => void duplicateTimeline(editor, id) },
      ],
      [{
        kind: "item", label: "Delete", destructive: true, disabled: !canDelete,
        onSelect: () => deleteMediaPanelItems(editor, key),
      }],
    );
  };

  const backgroundMenu = (): ContextMenuItem[] => [
    { kind: "item", label: "New Folder", onSelect: newFolderInCurrent },
    { kind: "item", label: "Import Media…", onSelect: () => void importFiles() },
  ];

  const onContextMenu = (e: MouseEvent, key: string | null, headerFolderId: string | undefined) => {
    let items: ContextMenuItem[];
    if (headerFolderId !== undefined) items = folderMenu(headerFolderId);
    else if (key === null) items = backgroundMenu();
    else {
      if (!isSelected(key)) {
        // Windows convention: right-clicking an unselected tile selects it first.
        selectMediaPanelItem(editor, key);
      }
      const folderId = mediaPanelFolderIdFromKey(key);
      const timelineId = mediaPanelTimelineIdFromKey(key);
      if (folderId !== undefined) items = folderMenu(folderId);
      else if (timelineId !== undefined) items = timelineMenu(timelineId, key);
      else {
        const asset = editor.mediaAsset(key);
        items = asset ? assetMenu(asset) : [];
      }
    }
    if (items.length > 0) setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---- toolbar menus ----

  const viewItems = (): MenuItem[] => [
    ...viewModes.map<MenuItem>((mode: ViewMode) => ({
      kind: "item", label: viewModeTitles[mode], checked: nav().viewMode === mode,
      onSelect: () => setNav((n) => setViewMode(n, mode)),
    })),
    { kind: "divider" },
    ...thumbnailPresets.map<MenuItem>((p) => ({
      kind: "item", label: p.title, checked: thumbnailSize() === p.size, onSelect: () => setThumbnailSize(p.size),
    })),
  ];
  const sortItems = (): MenuItem[] =>
    sortModes.map((mode) => ({
      kind: "item", label: sortModeTitles[mode], checked: sortMode() === mode, onSelect: () => setSortMode(mode),
    }));
  const clearFilters = () => {
    setFilterTypes(new Set<ClipType>());
    setFilterAI(false);
  };
  const filterItems = (): MenuItem[] => [
    ...filterableTypes.map<MenuItem>((type) => ({
      kind: "item", label: clipTypeTrackLabel(type), checked: filterTypes().has(type),
      onSelect: () => setFilterTypes((s) => {
        const next = new Set(s);
        if (!next.delete(type)) next.add(type);
        return next;
      }),
    })),
    { kind: "divider" },
    { kind: "item", label: "AI Generated", checked: filterAI(), onSelect: () => setFilterAI((v) => !v) },
    { kind: "divider" },
    { kind: "item", label: "Clear Filters", onSelect: clearFilters },
  ];
  const overflowItems = (): MenuItem[] => [
    { kind: "item", label: "New Folder", onSelect: newFolderInCurrent },
    { kind: "item", label: "Import Folder…", onSelect: () => void importFolder() },
  ];

  // ---- keyboard, paste, drops ----

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
    const direction = arrowDirections[e.key];
    const handled = (): void => e.preventDefault();
    if (direction && plain) {
      handled();
      moveMediaSelection(editor, direction);
    } else if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
      handled();
      selectAllMediaPanelItems(editor);
    } else if (e.key === "Delete" && plain) {
      if (mediaPanelSelectedKeys(editor).size > 0) {
        handled();
        deleteMediaPanelItems(editor);
      }
    } else if ((e.key === "Backspace" && plain) || (e.key === "ArrowUp" && (e.altKey || e.ctrlKey) && !e.shiftKey)) {
      handled();
      goUp();
    } else if (e.key === "F2" && plain) {
      const keys = [...mediaPanelSelectedKeys(editor)];
      if (keys.length === 1) {
        handled();
        setRenamingKey(keys[0]);
      }
    } else if (e.key === "Enter" && plain) {
      const keys = [...mediaPanelSelectedKeys(editor)];
      if (keys.length === 1) {
        handled();
        openKey(keys[0]);
      }
    } else if (e.ctrlKey && e.key.toLowerCase() === "k" && !e.shiftKey) {
      handled();
      root.querySelector<HTMLElement>(".mp-search-slot .search-icon-button, .mp-search-slot input")?.click();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
      handled();
      newFolderInCurrent();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type in imageExtensions);
    if (files.length === 0) return;
    e.preventDefault();
    void (async () => {
      const images = await Promise.all(
        files.map(async (f) => ({ extension: imageExtensions[f.type] ?? "png", data: new Uint8Array(await f.arrayBuffer()) })),
      );
      images.sort((a, b) => Number(b.extension === "png") - Number(a.extension === "png"));
      await handleClipboardPaste(editor, { paths: [], images }, nav().currentFolderId);
    })();
  };

  const folderOfTarget = (target: Element | null): string | undefined => {
    const id = target?.closest<HTMLElement>("[data-drop-folder]")?.dataset["dropFolder"];
    return id === undefined || id === "" ? undefined : id;
  };

  onMount(() => {
    const onMediaDrop = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest("[data-drop-folder]")) return;
      resolveTextDrop(editor, (e as CustomEvent<MediaDropDetail>).detail.payload, folderOfTarget(target));
    };
    root.addEventListener(mediaDropEventName, onMediaDrop);
    const unlisten = installOsFileDrop(root, {
      onHover: setOsDropHover,
      onDrop: (paths, target) => {
        const dest = target?.closest("[data-drop-folder]") ? folderOfTarget(target) : nav().currentFolderId;
        void services.importPaths(editor, paths, dest);
      },
      onUnsupported: (message) => editor.showToast(message, "error"),
    });
    onCleanup(() => {
      root.removeEventListener(mediaDropEventName, onMediaDrop);
      unlisten();
    });
  });

  // ---- toast ----

  createEffect(
    on(
      () => editor.ui.toast,
      (toast) => {
        if (!toast) return;
        const timer = setTimeout(() => {
          if (editor.ui.toast?.id === toast.id) editor.ui.toast = null;
        }, 4000);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );

  // ---- visual search (Swift scheduleMomentSearch / searchIndex triggers) ----

  const searchIndex = searchIndexFor(editor);
  onMount(() => void searchIndex.projectOpened());
  {
    const seen = new Set<string>();
    createEffect(() => {
      for (const asset of editor.mediaAssets) {
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        searchIndex.schedule(asset);
      }
    });
  }
  createEffect(on(() => searchIndex.model.state().kind, (kind) => {
    if (kind === "ready") searchIndex.sweep();
  }));
  createEffect(() => {
    const query = searchQuery().trim();
    void searchIndex.batchCompleted; // re-rank as more of the library gets indexed
    void searchIndex.model.state();
    if (query === "") {
      setMomentAssetIds([]);
      return;
    }
    const timer = setTimeout(() => {
      void searchIndex.search(query).then((hits) => {
        if (searchQuery().trim() === query) setMomentAssetIds(hits.map((h) => h.assetID));
      });
    }, 250);
    onCleanup(() => clearTimeout(timer));
  });

  const crumbs = createMemo(() => breadcrumbItems(folderPath(editor, nav().currentFolderId)));

  return (
    <div
      ref={root}
      class="media-tab"
      tabindex={-1}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onPointerDown={(e) => {
        if (!(e.target as HTMLElement).closest("input, button")) root.focus({ preventScroll: true });
      }}
    >
      <div class="mp-toolbar">
        <div class="mp-actions">
          <div class="mp-actions-left">
            <CapsuleButton title="Import" onClick={() => void importFiles()}>Import</CapsuleButton>
            <Show when={props.onGenerate}>
              {(generate) => (
                <CapsuleButton variant="prominent" title="Generate" onClick={() => generate()()}>Generate</CapsuleButton>
              )}
            </Show>
            <IconMenuButton icon={<Ellipsis size={11} />} title="More" items={overflowItems} />
          </div>
          <div class="mp-search-slot">
            <ExpandableSearch value={searchQuery()} onInput={setSearchQuery} placeholder="Search" label="Search (Ctrl+K)" />
          </div>
          <IconMenuButton icon={<LayoutGrid size={11} />} title="View" items={viewItems} />
          <IconMenuButton icon={<ArrowUpDown size={11} />} title="Sort" items={sortItems} />
          <IconMenuButton
            icon={<ListFilter size={11} />}
            title="Filter"
            items={filterItems}
            active={hasActiveFilters({ filterTypes: filterTypes(), filterAI: filterAI() })}
          />
        </div>
        <div class="mp-context">
          <Show when={nav().viewMode === "folder"} fallback={<span class="mp-view-title">{viewModeTitles[nav().viewMode]}</span>}>
            <div class="mp-breadcrumb">
              <For each={crumbs()}>
                {(item, i) => (
                  <>
                    <Show when={i() > 0}>
                      <ChevronRight size={8} class="mp-crumb-sep" />
                    </Show>
                    <button
                      type="button"
                      class="mp-crumb hover-highlight"
                      classList={{ leaf: i() === crumbs().length - 1 }}
                      data-drop-folder={item.folderId ?? ""}
                      onClick={() => {
                        if (i() < crumbs().length - 1) setNav((n) => navigateToFolder(n, item.folderId));
                      }}
                    >
                      {item.name}
                    </button>
                  </>
                )}
              </For>
            </div>
          </Show>
          <SearchIndexStatus editor={editor} />
          <span class="mp-count">{itemCountLabel(currentFolderItemCount(data(), nav().currentFolderId, filters()))}</span>
        </div>
      </div>

      <div class="mp-body">
        <Show
          when={!showsEmptyState(data())}
          fallback={
            <div class="mp-empty">
              <Images size={36} stroke-width={1} />
              <h2>No media yet</h2>
              <p>Drop files here or import from disk</p>
            </div>
          }
        >
          <Show
            when={sections().length > 0}
            fallback={
              <Show when={searchQuery().trim() !== ""}>
                <p class="mp-no-matches">No matches for “{searchQuery().trim()}”</p>
              </Show>
            }
          >
            <MediaGrid
              editor={editor}
              provider={provider}
              sections={sections}
              thumbnailSize={thumbnailSize}
              asset={(id) => assetById().get(id)}
              timeline={(id) => timelineById().get(id)}
              folder={(id) => folderById().get(id)}
              isSelected={isSelected}
              isOnTimeline={(id) => usedAssets().has(id)}
              folderChildCount={(id) => childCounts().get(id) ?? 0}
              timelinePosterAsset={timelinePosterAsset}
              renamingKey={renamingKey}
              commitRename={commitRename}
              cancelRename={() => setRenamingKey(null)}
              onOpenKey={openKey}
              onBeginRename={setRenamingKey}
              onToggleSection={(key) =>
                setCollapsedKeys((s) => {
                  const next = new Set(s);
                  if (!next.delete(key)) next.add(key);
                  return next;
                })
              }
              onOpenFolder={open}
              onContextMenu={onContextMenu}
            />
          </Show>
        </Show>
        <Show when={osDropHover()}>
          <div class="mp-drop-highlight" />
        </Show>
        <Show when={editor.ui.toast}>
          {(toast) => (
            <button
              type="button"
              class="mp-toast"
              onClick={() => {
                editor.ui.toast = null;
              }}
            >
              <Show when={toast().kind === "error"} fallback={<CircleCheck size={12} class="mp-toast-ok" />}>
                <TriangleAlert size={12} class="mp-toast-warn" />
              </Show>
              <span>{toast().message}</span>
            </button>
          )}
        </Show>
      </div>

      <Show when={editor.ui.showGenerationPanel && props.generationPanel}>
        {(render) => <div class="mp-generation">{render()()}</div>}
      </Show>

      <Show when={menu()}>
        {(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(null)} />}
      </Show>
    </div>
  );
}
