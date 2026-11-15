import ChevronDown from "lucide-solid/icons/chevron-down";
import Folder from "lucide-solid/icons/folder";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { MediaAsset, MediaFolder, Timeline } from "../model";
import type { Editor } from "../editor/editor";
import {
  applyMediaPanelSelection, clearMediaPanelScrollTarget, clearMediaPanelSelection, mediaPanelScrollTarget,
  mediaPanelSelectedKeys, mediaPanelSelectionMode, pruneMediaPanelSelectionAnchor, selectMediaPanelItem,
  setMediaPanelLayout,
} from "../editor/mutations/mediaPanel";
import { mediaPanelFolderIdFromKey, mediaPanelTimelineIdFromKey } from "../media/library";
import { encodeMediaDrag } from "./dragPayload";
import { armMediaDrag, type MediaDragSource } from "./dragSession";
import {
  artHeight, computeGridLayout, keysInRect, scrollTopToReveal, visibleRowRange, type GridLayout, type Rect,
  gridPadding, gridSpacing,
} from "./gridMath";
import { orderedItemKeys, type PanelSection } from "./panelModel";
import { AssetTile, FolderTile, TimelineTile, type TileEnv } from "./Tiles";
import type { ThumbnailProvider } from "./thumbnailProvider";

const overscanPx = 240;
const marqueeThresholdPx = 3;

export interface MediaGridProps {
  editor: Editor;
  provider: ThumbnailProvider;
  sections: () => PanelSection[];
  thumbnailSize: () => number;
  asset: (id: string) => MediaAsset | undefined;
  timeline: (id: string) => Timeline | undefined;
  folder: (id: string) => MediaFolder | undefined;
  isSelected: (key: string) => boolean;
  isOnTimeline: (assetId: string) => boolean;
  folderChildCount: (folderId: string) => number;
  timelinePosterAsset: (timeline: Timeline) => MediaAsset | undefined;
  renamingKey: () => string | null;
  commitRename: (key: string, name: string) => void;
  cancelRename: () => void;
  onOpenKey: (key: string) => void;
  onBeginRename: (key: string) => void;
  onToggleSection: (key: string) => void;
  onOpenFolder: (folderId: string) => void;
  /** key is null on empty space; `headerFolderId` when the target is a grouped section header. */
  onContextMenu: (e: MouseEvent, key: string | null, headerFolderId: string | undefined) => void;
  /** Reports the scroll element so the owner can focus it or read the layout. */
  scrollRef?: (el: HTMLDivElement) => void;
}

function sameIndices(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function dragSourceFor(editor: Editor, props: MediaGridProps, key: string, tile: HTMLElement): MediaDragSource | null {
  const folderId = mediaPanelFolderIdFromKey(key);
  if (folderId !== undefined) {
    const name = props.folder(folderId)?.name ?? "Folder";
    return { payload: encodeMediaDrag({ folderIds: [folderId] }), label: name, count: 1 };
  }
  const timelineId = mediaPanelTimelineIdFromKey(key);
  if (timelineId !== undefined) {
    const name = props.timeline(timelineId)?.name ?? "Timeline";
    return { payload: encodeMediaDrag({ timelineIds: [timelineId] }), label: name, count: 1 };
  }
  const asset = props.asset(key);
  if (!asset) return null;
  const selected = editor.ui.selectedMediaAssetIds;
  const ids = selected.has(key) ? editor.mediaAssets.filter((a) => selected.has(a.id)).map((a) => a.id) : [key];
  return {
    payload: encodeMediaDrag({ assets: ids.map((id) => ({ id })) }),
    label: asset.name,
    count: ids.length,
    previewCanvas: tile.querySelector("canvas"),
  };
}

export function MediaGrid(props: MediaGridProps) {
  const editor = props.editor;
  let scroller!: HTMLDivElement;
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = createSignal(0);
  const [marquee, setMarquee] = createSignal<Rect | null>(null);

  const layout = createMemo<GridLayout>(() => computeGridLayout(props.sections(), size().width, props.thumbnailSize()));
  const range = createMemo(
    () => visibleRowRange(layout().rows, scrollTop(), size().height, overscanPx),
    undefined,
    { equals: (a, b) => a.start === b.start && a.end === b.end },
  );
  const visibleIndices = createMemo(
    () => {
      const { start, end } = range();
      return Array.from({ length: end - start }, (_, i) => start + i);
    },
    [],
    { equals: sameIndices },
  );

  createEffect(() => setMediaPanelLayout(editor, orderedItemKeys(props.sections()), layout().cols));

  const env: TileEnv = {
    editor,
    provider: props.provider,
    tileWidth: () => layout().tileWidth,
    artHeight: () => artHeight(layout().tileWidth),
    asset: (id) => props.asset(id),
    timeline: (id) => props.timeline(id),
    folder: (id) => props.folder(id),
    isSelected: (key) => props.isSelected(key),
    isOnTimeline: (id) => props.isOnTimeline(id),
    folderChildCount: (id) => props.folderChildCount(id),
    renamingKey: () => props.renamingKey(),
    commitRename: (key, name) => props.commitRename(key, name),
    cancelRename: () => props.cancelRename(),
    timelinePosterAsset: (t) => props.timelinePosterAsset(t),
  };

  onMount(() => {
    props.scrollRef?.(scroller);
    const observer = new ResizeObserver(() => {
      const box = scroller.getBoundingClientRect();
      // A hidden tab reports 0: keep the last layout instead of collapsing it.
      if (box.width > 0) setSize({ width: scroller.clientWidth, height: scroller.clientHeight });
    });
    observer.observe(scroller);
    onCleanup(() => observer.disconnect());
  });

  let scrollFrame = 0;
  const onScroll = () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      setScrollTop(scroller.scrollTop);
    });
  };
  onCleanup(() => cancelAnimationFrame(scrollFrame));

  createEffect(
    on(
      () => mediaPanelScrollTarget(editor),
      (key) => {
        if (key === null) return;
        const target = scrollTopToReveal(layout(), key, scroller.scrollTop, size().height);
        if (target !== undefined) {
          scroller.scrollTop = target;
          setScrollTop(target);
        }
        clearMediaPanelScrollTarget(editor);
      },
    ),
  );

  const contentPoint = (e: PointerEvent) => {
    const box = scroller.getBoundingClientRect();
    return { x: e.clientX - box.left + scroller.scrollLeft, y: e.clientY - box.top + scroller.scrollTop };
  };

  const startMarquee = (e: PointerEvent) => {
    const origin = contentPoint(e);
    const extending = e.shiftKey;
    const base = extending ? mediaPanelSelectedKeys(editor) : new Set<string>();
    let active = false;
    scroller.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = contentPoint(ev);
      if (!active) {
        if (Math.hypot(p.x - origin.x, p.y - origin.y) < marqueeThresholdPx) return;
        active = true;
        if (!extending) clearMediaPanelSelection(editor);
      }
      const rect: Rect = {
        x: Math.min(origin.x, p.x),
        y: Math.min(origin.y, p.y),
        width: Math.abs(p.x - origin.x),
        height: Math.abs(p.y - origin.y),
      };
      setMarquee(rect);
      applyMediaPanelSelection(editor, new Set([...base, ...keysInRect(layout(), rect)]), null);
    };
    const end = () => {
      scroller.removeEventListener("pointermove", move);
      scroller.removeEventListener("pointerup", end);
      scroller.removeEventListener("pointercancel", end);
      setMarquee(null);
      if (active) pruneMediaPanelSelectionAnchor(editor);
      else clearMediaPanelSelection(editor);
    };
    scroller.addEventListener("pointermove", move);
    scroller.addEventListener("pointerup", end);
    scroller.addEventListener("pointercancel", end);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("input, button")) return;
    const tile = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
    if (tile?.dataset["key"] !== undefined) {
      const key = tile.dataset["key"];
      armMediaDrag(e, () => dragSourceFor(editor, props, key, tile));
    } else if (!(e.target as HTMLElement).closest(".mp-section-header")) startMarquee(e);
  };

  const keyOf = (target: EventTarget | null): string | null =>
    (target as HTMLElement | null)?.closest<HTMLElement>("[data-key]")?.dataset["key"] ?? null;

  const onClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("input")) return;
    const key = keyOf(e.target);
    if (key === null) return;
    selectMediaPanelItem(editor, key, mediaPanelSelectionMode({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
  };

  const onDblClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input")) return;
    const key = keyOf(target);
    if (key === null) return;
    if (mediaPanelFolderIdFromKey(key) !== undefined || mediaPanelTimelineIdFromKey(key) !== undefined) props.onOpenKey(key);
    else if (target.closest(".mp-name")) props.onBeginRename(key);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    const header = target.closest<HTMLElement>(".mp-section-header");
    props.onContextMenu(e, keyOf(target), header?.dataset["folder"] || undefined);
  };

  const rowDropKey = (section: PanelSection): string | undefined =>
    section.collapsible ? (section.folderId ?? "") : undefined;

  const RowView = (rowProps: { index: number }) => {
    const row = () => layout().rows[rowProps.index];
    const section = () => {
      const r = row();
      return r ? props.sections()[r.section] : undefined;
    };
    return (
      <Show when={row()}>
        {(r) => (
          <div
            class="mp-row"
            data-drop-folder={section() ? rowDropKey(section()!) : undefined /* section is defined while its row exists */}
            style={{ top: `${r().top}px`, height: `${r().height}px` }}
          >
            <Show when={r().kind === "header" && section()}>
              {(s) => <SectionHeader section={s()} />}
            </Show>
            <Show when={r().kind === "empty"}>
              <span class="mp-section-empty">Empty</span>
            </Show>
            <Show when={r().kind === "tiles"}>
              <div
                class="mp-tiles"
                style={{
                  "grid-template-columns": `repeat(${layout().cols}, ${layout().tileWidth}px)`,
                  "--tile-w": `${layout().tileWidth}px`,
                }}
              >
                <For each={(r() as { keys?: string[] }).keys ?? []}>{(key) => <Tile tileKey={key} />}</For>
              </div>
            </Show>
          </div>
        )}
      </Show>
    );
  };

  const Tile = (tileProps: { tileKey: string }) => {
    const folderId = mediaPanelFolderIdFromKey(tileProps.tileKey);
    const timelineId = mediaPanelTimelineIdFromKey(tileProps.tileKey);
    if (folderId !== undefined) return <FolderTile env={env} id={folderId} tileKey={tileProps.tileKey} />;
    if (timelineId !== undefined) return <TimelineTile env={env} id={timelineId} tileKey={tileProps.tileKey} />;
    return <AssetTile env={env} id={tileProps.tileKey} />;
  };

  const SectionHeader = (headerProps: { section: PanelSection }) => {
    const segments = () => (headerProps.section.title ?? "").split(" / ");
    return (
      <div class="mp-section-header" data-folder={headerProps.section.folderId ?? ""}>
        <Show when={headerProps.section.collapsible}>
          <button
            type="button"
            class="mp-section-toggle hover-highlight"
            classList={{ collapsed: headerProps.section.collapsed }}
            title={headerProps.section.collapsed ? "Expand" : "Collapse"}
            onClick={() => props.onToggleSection(headerProps.section.key)}
          >
            <ChevronDown size={9} />
          </button>
        </Show>
        <Show
          when={headerProps.section.folderId}
          fallback={<SectionTitle segments={segments()} />}
        >
          {(folderId) => (
            <button
              type="button"
              class="mp-section-folder hover-highlight"
              title={`Open ${headerProps.section.title ?? ""}`}
              onClick={() => props.onOpenFolder(folderId())}
            >
              <Folder size={10} fill="currentColor" class="mp-section-folder-icon" />
              <SectionTitle segments={segments()} />
            </button>
          )}
        </Show>
        <span class="mp-section-count">{headerProps.section.items.length}</span>
      </div>
    );
  };

  return (
    <div
      ref={scroller}
      class="mp-grid"
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDblClick={onDblClick}
      onContextMenu={onContextMenu}
    >
      <div class="mp-grid-content" style={{ height: `${layout().totalHeight + gridPadding}px`, "--grid-pad": `${gridPadding}px`, "--grid-gap": `${gridSpacing}px` }}>
        <For each={visibleIndices()}>{(index) => <RowView index={index} />}</For>
        <Show when={marquee()}>
          {(m) => (
            <div
              class="mp-marquee"
              style={{ left: `${m().x}px`, top: `${m().y}px`, width: `${m().width}px`, height: `${m().height}px` }}
            />
          )}
        </Show>
      </div>
    </div>
  );
}

function SectionTitle(props: { segments: string[] }) {
  return (
    <span class="mp-section-title">
      <For each={props.segments}>
        {(segment, i) => (
          <>
            <Show when={i() > 0}>
              <span class="mp-section-sep">/</span>
            </Show>
            <span classList={{ leaf: i() === props.segments.length - 1 }}>{segment}</span>
          </>
        )}
      </For>
    </span>
  );
}
