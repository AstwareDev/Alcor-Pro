import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import {
  Defaults,
  Layout,
  TimelineAutoScroll,
  mediaAssetIsGenerating,
  timelineDisplayFrames,
  timelineTotalFrames,
  type Clip,
  type MediaAsset,
} from "../../model";
import type { Editor } from "../../editor/editor";
import { timelineFor, type SourceSegment } from "../../editor/mutations/core";
import { nestTimeline } from "../../editor/mutations/nesting";
import { placeDroppedAssets } from "../../editor/mutations/linking";
import { viewStateFor } from "../../editor/mutations/timelines";
import { unprocessableMediaRefs } from "../../media/libraryCore";
import { onVisualReady } from "../../media/visualEvents";
import { decodeMediaDrag, type MediaDragPayload } from "../../mediapanel/dragPayload";
import { activeMediaDrag, mediaDropEventName, type MediaDropDetail } from "../../mediapanel/dragSession";
import { ContextMenu, type ContextMenuItem } from "../../ui/ContextMenu";
import { contentBottom, makeTimelineGeometryForTimeline, type TimelineGeometry } from "../timelineGeometry";
import { minZoomScale, playheadAnchoredScrollX } from "../timelineInput";
import type { TimelineKeyframeLaneState } from "../timelineKeyframeLaneState";
import { readCanvasPalette, type CanvasPalette } from "./canvasPalette";
import { clipDrawStyles } from "./clipRenderer";
import { TransitionInteraction, transitionDragScheme } from "../../transitions/timelineTransitions";
import { timelineContextMenu } from "./contextMenus";
import { cssCursor } from "./cursors";
import { TimelineInputController, type TimelinePointer, type TimelineViewHost } from "./inputController";
import { sharedTimelineClipColorPalette } from "./timelineClipColors";
import { drawClipsLayer, drawOverlay, overlayColors, type OverlayColors } from "./timelineRenderer";
import { timelineToolMode } from "./toolMode";
import { makeMediaVisualSource, type TimelineVisualSource } from "./visualSource";

export interface TimelineRenderStats {
  clipsMs: number;
  overlayMs: number;
}

/** The pieces of the canvas view the pane's headers, toolbar and shortcuts drive. */
export interface TimelineSurface {
  controller: TimelineInputController;
  scrollY: () => number;
  geometry: () => TimelineGeometry;
  zoomBy(factor: number): void;
  zoomToFit(): void;
  invalidate(): void;
}

function segmentsOf(payload: MediaDragPayload): Record<string, SourceSegment> {
  const out: Record<string, SourceSegment> = {};
  for (const a of payload.assets) if (a.segment) out[a.id] = { lowerBound: a.segment.start, upperBound: a.segment.end };
  return out;
}

export function TimelineCanvas(props: {
  editor: Editor;
  laneState: TimelineKeyframeLaneState;
  laneRevision: () => number;
  visuals?: TimelineVisualSource;
  onReady: (surface: TimelineSurface) => void;
  onScrollY: (y: number) => void;
  onRenderStats?: (stats: TimelineRenderStats) => void;
  onPresentMarkerEditor: (id: string, anchor: { x: number; y: number }) => void;
  /** Swift `addClipsWithSettingsCheck` mismatch prompt; without it the drop proceeds. */
  onSettingsMismatch?: (assets: readonly MediaAsset[], proceed: () => void) => void;
  importOsFiles?: (paths: string[], cursor: { kind: "existingTrack" | "newTrackAt"; index: number }, frame: number, ripple: boolean) => void;
}) {
  const editor = props.editor;
  const ui = editor.ui;
  let area!: HTMLDivElement;
  let scroller!: HTMLDivElement;
  let spacer!: HTMLDivElement;
  let clipsCanvas!: HTMLCanvasElement;
  let overlayCanvas!: HTMLCanvasElement;
  let clipsCtx: CanvasRenderingContext2D | null = null;
  let overlayCtx: CanvasRenderingContext2D | null = null;

  let viewW = 0;
  let viewH = 0;
  let dpr = 1;
  let scrollX = 0;
  let scrollY = 0;
  let contentW = 0;
  let contentH = 0;
  let palette: CanvasPalette | undefined;
  let colors: OverlayColors | undefined;
  const clipColors = sharedTimelineClipColorPalette();
  const visuals = props.visuals ?? makeMediaVisualSource(() => scheduleClips());

  let clipsDirty = true;
  let overlayDirty = true;
  let frameRequest = 0;
  let autoScrollRequest = 0;
  let lastAutoScrollTime = 0;
  let lastZoom: number | undefined;
  let controllerZoom: number | undefined;
  let geometryCache: { key: unknown[]; value: TimelineGeometry } | undefined;
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  const geometry = (): TimelineGeometry => {
    const key = [editor.timeline, ui.zoomScale, props.laneRevision(), contentW];
    if (geometryCache && geometryCache.key.every((k, i) => k === key[i])) return geometryCache.value;
    const value = makeTimelineGeometryForTimeline({
      timeline: editor.timeline,
      zoomScale: ui.zoomScale,
      bounds: { x: 0, y: 0, width: contentW, height: contentH },
      laneState: props.laneState,
    });
    geometryCache = { key, value };
    return value;
  };

  /** TimelineView.updateContentSize. */
  const updateContentSize = () => {
    const frames = timelineDisplayFrames(editor.timeline);
    contentW = Math.max(viewW, ui.zoomScale * frames + viewW * 0.5);
    const geo = geometry();
    contentH = editor.timeline.tracks.length === 0 ? viewH : Math.max(viewH, contentBottom(geo) + Layout.dropZoneHeight);
    spacer.style.width = `${contentW}px`;
    spacer.style.height = `${contentH}px`;
  };

  const applyScroll = (x: number, y: number) => {
    const maxX = Math.max(0, contentW - viewW);
    const maxY = Math.max(0, contentH - viewH);
    const nx = Math.min(maxX, Math.max(0, x));
    const ny = Math.min(maxY, Math.max(0, y));
    if (nx !== scrollX) scroller.scrollLeft = nx;
    if (ny !== scrollY) scroller.scrollTop = ny;
    syncScrollFromDom();
  };

  const syncScrollFromDom = () => {
    const x = scroller.scrollLeft;
    const y = scroller.scrollTop;
    if (x === scrollX && y === scrollY) return;
    const yChanged = y !== scrollY;
    scrollX = x;
    scrollY = y;
    if (ui.timelineScrollOffsetX !== x) ui.timelineScrollOffsetX = x;
    if (yChanged) props.onScrollY(y);
    clipsDirty = true;
    overlayDirty = true;
    requestFrame();
  };

  const host: TimelineViewHost = {
    geometry,
    scrollX: () => scrollX,
    scrollY: () => scrollY,
    viewportWidth: () => viewW,
    setScrollX: (x) => {
      updateContentSize();
      applyScroll(x, scrollY);
    },
    setScrollY: (y) => applyScroll(scrollX, y),
    laneState: () => props.laneState,
    toolMode: () => timelineToolMode(editor),
    invalidate: () => scheduleClips(),
    invalidateOverlay: () => scheduleOverlay(),
    setCursor: (c) => {
      scroller.style.cursor = cssCursor(c);
    },
    presentMarkerEditor: (id) => {
      const marker = editor.timeline.markers.find((m) => m.id === id);
      const rect = area.getBoundingClientRect();
      const x = marker ? marker.startFrame * ui.zoomScale - scrollX + rect.left : rect.left;
      props.onPresentMarkerEditor(id, { x, y: rect.top + Layout.rulerHeight });
    },
    setAutoScrollActive: (active) => {
      if (!active) {
        cancelAnimationFrame(autoScrollRequest);
        autoScrollRequest = 0;
        return;
      }
      if (autoScrollRequest !== 0) return;
      const tick = (t: number) => {
        if (t - lastAutoScrollTime >= TimelineAutoScroll.interval * 1000 * 0.9) {
          lastAutoScrollTime = t;
          controller.autoScrollTick();
        }
        if (autoScrollRequest !== 0) autoScrollRequest = requestAnimationFrame(tick);
      };
      autoScrollRequest = requestAnimationFrame(tick);
    },
  };
  const controller = new TimelineInputController(editor, host);
  const transitions = new TransitionInteraction(controller);
  const originalApplyZoom = controller.applyZoom.bind(controller);
  controller.applyZoom = (factor, anchor) => {
    originalApplyZoom(factor, anchor);
    controllerZoom = ui.zoomScale;
  };

  function scheduleClips(): void {
    clipsDirty = true;
    overlayDirty = true;
    requestFrame();
  }
  function scheduleOverlay(): void {
    overlayDirty = true;
    requestFrame();
  }
  function requestFrame(): void {
    if (frameRequest === 0) frameRequest = requestAnimationFrame(renderFrame);
  }

  // Per-frame status lookups: one pass over the media state instead of reactive reads per clip.
  let styles: { revision: number; value: ReturnType<typeof clipDrawStyles> } | undefined;
  let status: { doc: unknown; offline: Set<string>; refs: [Set<string>, Set<string>, ReadonlySet<string>]; generating: Set<string> } | undefined;
  const refreshStatus = () => {
    const refs: [Set<string>, Set<string>, ReadonlySet<string>] = [ui.offlineMediaRefs, ui.missingMediaRefs, unprocessableMediaRefs(editor)];
    if (status && status.doc === editor.doc && status.refs.every((r, i) => r === refs[i])) return status;
    const generating = new Set<string>();
    for (const a of editor.mediaAssets) if (mediaAssetIsGenerating(a)) generating.add(a.id);
    status = { doc: editor.doc, offline: new Set([...refs[0], ...refs[1], ...refs[2]]), refs, generating };
    return status;
  };
  const timelineIds = () => new Set(editor.doc.timelines.map((t) => t.id));
  let timelineIdCache: { doc: unknown; ids: Set<string> } | undefined;
  const isOffline = (clip: Clip) => {
    if (clip.sourceClipType === "sequence") {
      if (timelineIdCache?.doc !== editor.doc) timelineIdCache = { doc: editor.doc, ids: timelineIds() };
      return !timelineIdCache.ids.has(clip.mediaRef);
    }
    return clip.mediaType !== "text" && (status as NonNullable<typeof status>).offline.has(clip.mediaRef);
  };
  const isGenerating = (clip: Clip) => clip.mediaType !== "text" && (status as NonNullable<typeof status>).generating.has(clip.mediaRef);

  function renderFrame(): void {
    frameRequest = 0;
    if (!clipsCtx || !overlayCtx || !palette || !colors || viewW === 0) return;
    // Keep the playhead in view during playback (TimelineContainerView.updateNSView).
    if (ui.isPlaying) {
      const px = ui.currentFrame * ui.zoomScale;
      const margin = 60;
      if (px < scrollX + margin || px > scrollX + viewW - margin) {
        applyScroll(Math.max(0, px - viewW * 0.25), scrollY);
      }
    }
    let clipsMs = 0;
    let overlayMs = 0;
    if (clipsDirty) {
      clipsDirty = false;
      const t0 = performance.now();
      refreshStatus();
      const revision = clipColors.revision();
      if (styles?.revision !== revision) styles = { revision, value: clipDrawStyles(clipColors) };
      drawClipsLayer(clipsCtx, {
        editor,
        controller,
        geometry: geometry(),
        laneState: props.laneState,
        palette,
        styles: styles.value,
        visuals,
        scrollX,
        scrollY,
        width: viewW,
        height: viewH,
        dpr,
        isClipOffline: isOffline,
        isClipGenerating: isGenerating,
      });
      clipsMs = performance.now() - t0;
    }
    if (overlayDirty) {
      overlayDirty = false;
      const t0 = performance.now();
      drawOverlay(overlayCtx, {
        controller,
        pixelsPerFrame: ui.zoomScale,
        currentFrame: ui.currentFrame,
        scrollX,
        scrollY,
        width: viewW,
        height: viewH,
        dpr,
        colors,
      });
      overlayMs = performance.now() - t0;
    }
    props.onRenderStats?.({ clipsMs, overlayMs });
  }

  const resize = () => {
    const w = scroller.clientWidth;
    const h = scroller.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    if (w === viewW && h === viewH && ratio === dpr) return;
    const firstLayout = ui.timelineVisibleWidth === 0;
    viewW = w;
    viewH = h;
    dpr = ratio;
    for (const c of [clipsCanvas, overlayCanvas]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    if (ui.timelineVisibleWidth !== w) {
      ui.timelineVisibleWidth = w;
      const minZoom = minZoomScale(editor.timeline, w);
      if (firstLayout) ui.zoomScale = timelineDisplayFrames(editor.timeline) === 0 ? Defaults.pixelsPerFrame : minZoom;
      else if (ui.zoomScale < minZoom) ui.zoomScale = minZoom;
      lastZoom = ui.zoomScale;
    }
    updateContentSize();
    scheduleClips();
  };

  const pointerFrom = (e: PointerEvent | MouseEvent | WheelEvent): TimelinePointer => {
    const rect = scroller.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      clickCount: e.detail || 1,
    };
  };

  const inScrollbar = (p: TimelinePointer) => p.x >= scroller.clientWidth || p.y >= scroller.clientHeight;

  onMount(() => {
    clipsCtx = clipsCanvas.getContext("2d", { alpha: false });
    overlayCtx = overlayCanvas.getContext("2d");
    palette = readCanvasPalette();
    colors = overlayColors(palette);

    const ro = new ResizeObserver(resize);
    ro.observe(scroller);
    resize();
    applyScroll(ui.timelineScrollOffsetX, 0);

    const themeObserver = new MutationObserver(() => {
      palette = readCanvasPalette();
      colors = overlayColors(palette);
      scheduleClips();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const dprQuery = () => resize();
    window.addEventListener("resize", dprQuery);

    const onScroll = () => syncScrollFromDom();
    scroller.addEventListener("scroll", onScroll, { passive: true });

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewH : 1;
      controller.wheel(pointerFrom(e), e.deltaX * scale, e.deltaY * scale);
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });

    const unlistenVisual = onVisualReady(() => scheduleClips());

    // Media-panel drags are pointer driven (dragSession.ts): follow the pointer while one is in flight.
    let dragPayload: { source: string; decoded: MediaDragPayload } | undefined;
    const onMediaDragMove = (e: PointerEvent) => {
      lastCtrl = e.ctrlKey;
      const source = activeMediaDrag();
      if (!source) return;
      if (dragPayload?.source !== source.payload) dragPayload = { source: source.payload, decoded: decodeMediaDrag(source.payload) };
      const p = pointerFrom(e);
      if (p.x < 0 || p.y < 0 || p.x > scroller.clientWidth || p.y > scroller.clientHeight) {
        controller.externalDragLeave();
        return;
      }
      controller.externalDragUpdate(p, mediaAssets(dragPayload.decoded), segmentsOf(dragPayload.decoded));
    };
    window.addEventListener("pointermove", onMediaDragMove, true);
    const onMediaDropEvent = (e: Event) => onMediaDrop(e as CustomEvent<MediaDropDetail>);
    scroller.addEventListener(mediaDropEventName, onMediaDropEvent);

    let unlistenOs: (() => void) | undefined;
    let disposed = false;
    void setupOsDrop().then((u) => {
      if (disposed) u?.();
      else unlistenOs = u;
    });

    onCleanup(() => {
      disposed = true;
      ro.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("resize", dprQuery);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      unlistenVisual();
      unlistenOs?.();
      window.removeEventListener("pointermove", onMediaDragMove, true);
      scroller.removeEventListener(mediaDropEventName, onMediaDropEvent);
      cancelAnimationFrame(frameRequest);
      cancelAnimationFrame(autoScrollRequest);
    });

    props.onReady({
      controller,
      scrollY: () => scrollY,
      geometry,
      zoomBy: (factor) => {
        const min = minZoomScale(editor.timeline, ui.timelineVisibleWidth);
        ui.zoomScale = Math.min(40, Math.max(min, ui.zoomScale * factor));
      },
      zoomToFit: () => {
        ui.zoomScale = minZoomScale(editor.timeline, ui.timelineVisibleWidth);
        controllerZoom = ui.zoomScale;
        updateContentSize();
        applyScroll(0, scrollY);
      },
      invalidate: scheduleClips,
    });
  });

  // OS file drops arrive through Tauri with physical-pixel positions relative to the webview.
  async function setupOsDrop(): Promise<(() => void) | undefined> {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) return undefined;
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const { dropPlaceholderAssets } = await import("../../media/mediaLibrary");
    let placeholders: MediaAsset[] = [];
    let paths: string[] = [];
    const toPointer = (pos: { x: number; y: number }): TimelinePointer | undefined => {
      const ratio = window.devicePixelRatio || 1;
      const rect = scroller.getBoundingClientRect();
      const x = pos.x / ratio - rect.left;
      const y = pos.y / ratio - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) return undefined;
      return { x, y, shift: false, ctrl: false, alt: false, clickCount: 1 };
    };
    return getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        paths = payload.paths;
        placeholders = dropPlaceholderAssets(paths);
      }
      if (payload.type === "leave") {
        controller.externalDragLeave();
        return;
      }
      const p = toPointer(payload.position);
      if (!p) {
        controller.externalDragLeave();
        return;
      }
      if (payload.type === "drop") {
        const drop = controller.externalDrop(p, placeholders, {});
        props.importOsFiles?.(payload.paths, drop.cursor, drop.frame, drop.ripple);
        return;
      }
      controller.externalDragUpdate(p, placeholders, {});
    });
  }

  // Redraw triggers: document, zoom, selection and media status redraw the clips layer; the playhead only the overlay.
  createEffect(
    on(
      [
        () => editor.store.revision,
        () => ui.selectedClipIds,
        () => ui.selectedGap,
        () => ui.selectedTransitionId,
        () => ui.selectedTimelineRange,
        () => ui.selectedTimelineMarkerIds,
        () => ui.timelineMarkerPreview,
        () => ui.offlineMediaRefs,
        () => ui.missingMediaRefs,
        () => clipColors.revision(),
        props.laneRevision,
      ],
      () => {
        if (!spacer) return;
        updateContentSize();
        scheduleClips();
      },
    ),
  );
  createEffect(on(() => ui.currentFrame, scheduleOverlay));
  createEffect(
    on(
      () => ui.zoomScale,
      (zoom) => {
        if (!spacer) return;
        const previous = lastZoom;
        lastZoom = zoom;
        updateContentSize();
        if (previous !== undefined && previous !== zoom && controllerZoom !== zoom) {
          // Toolbar zoom keeps the playhead where it is on screen.
          const x = playheadAnchoredScrollX({ previousZoom: previous, zoomScale: zoom, activeFrame: ui.currentFrame, originX: scrollX, visibleWidth: viewW });
          if (x !== undefined) applyScroll(x, scrollY);
        }
        controllerZoom = undefined;
        scheduleClips();
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => editor.doc.activeTimelineId,
      (id) => {
        if (!spacer) return;
        controller.cancelActiveDrag();
        lastZoom = ui.zoomScale;
        updateContentSize();
        applyScroll(viewStateFor(editor, id).scrollOffsetX, 0);
        scheduleClips();
      },
      { defer: true },
    ),
  );

  // MARK: - Pointer wiring

  let pointerActive = false;
  let lastCtrl = false;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = pointerFrom(e);
    if (inScrollbar(p)) return;
    area.focus({ preventScroll: true });
    scroller.setPointerCapture(e.pointerId);
    pointerActive = true;
    if (transitions.pointerDown(p)) return;
    controller.pointerDown(p);
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = pointerFrom(e);
    if (pointerActive) {
      if (transitions.dragging) transitions.pointerDrag(p);
      else controller.pointerDrag(p);
    } else if (!inScrollbar(p) && !transitions.hover(p)) controller.hover(p);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!pointerActive) return;
    pointerActive = false;
    if (scroller.hasPointerCapture(e.pointerId)) scroller.releasePointerCapture(e.pointerId);
    if (transitions.dragging) transitions.pointerUp();
    else controller.pointerUp(pointerFrom(e));
  };
  const onPointerCancel = () => {
    if (!pointerActive) return;
    pointerActive = false;
    transitions.cancel();
    controller.cancelActiveDrag();
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const p = pointerFrom(e);
    if (inScrollbar(p) || controller.isDragging) return;
    const items = transitions.contextMenu(p) ?? timelineContextMenu(controller, p);
    if (items) setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // MARK: - Media panel drops (pointer-driven drag session, `palmier-media-drop` on release)

  const mediaAssets = (payload: MediaDragPayload): MediaAsset[] =>
    payload.assets.flatMap((a) => {
      const asset = editor.mediaAsset(a.id);
      return asset ? [asset] : [];
    });

  createEffect(
    on(activeMediaDrag, (drag) => {
      if (!drag) controller.externalDragLeave();
    }, { defer: true }),
  );

  function onMediaDrop(e: CustomEvent<MediaDropDetail>): void {
    const rect = scroller.getBoundingClientRect();
    if (e.detail.payload.includes(transitionDragScheme)) {
      const at: TimelinePointer = { x: e.detail.clientX - rect.left, y: e.detail.clientY - rect.top, shift: false, ctrl: false, alt: false, clickCount: 1 };
      if (transitions.dropLibraryPayload(e.detail.payload, at)) return;
    }
    const payload = decodeMediaDrag(e.detail.payload);
    const p: TimelinePointer = {
      x: e.detail.clientX - rect.left,
      y: e.detail.clientY - rect.top,
      shift: false,
      ctrl: lastCtrl,
      alt: false,
      clickCount: 1,
    };
    if (payload.timelineIds.length > 0) {
      const drop = controller.externalDrop(p, [], {});
      let frame = drop.frame;
      for (const id of payload.timelineIds) {
        if (!nestTimeline(editor, id, drop.cursor, frame)) continue;
        const nested = timelineFor(editor, id);
        frame += nested ? timelineTotalFrames(nested) : 0;
      }
      return;
    }
    const assets = mediaAssets(payload);
    const segments = segmentsOf(payload);
    const drop = controller.externalDrop(p, assets, segments);
    // Subtitle assets become captions in Swift (placeCaptions); not ported yet.
    const media = assets.filter((a) => a.type !== "subtitle");
    if (media.length === 0) return;
    const place = () => placeDroppedAssets(editor, media, drop.cursor, drop.frame, { segments, ripple: drop.ripple });
    if (props.onSettingsMismatch) props.onSettingsMismatch(media, place);
    else place();
  }

  return (
    <div ref={area} class="timeline-canvas-area" tabIndex={-1}>
      <canvas ref={clipsCanvas} class="timeline-canvas" />
      <canvas ref={overlayCanvas} class="timeline-canvas timeline-overlay" />
      <div
        ref={scroller}
        class="timeline-scroller"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => {
          if (!pointerActive) controller.leave();
        }}
        onContextMenu={onContextMenu}
      >
        <div ref={spacer} class="timeline-spacer" />
      </div>
      <Show when={menu()}>{(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(null)} />}</Show>
    </div>
  );
}
