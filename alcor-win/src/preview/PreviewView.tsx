import Camera from "lucide-solid/icons/camera";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Ellipsis from "lucide-solid/icons/ellipsis";
import Pause from "lucide-solid/icons/pause";
import Play from "lucide-solid/icons/play";
import SkipBack from "lucide-solid/icons/skip-back";
import SkipForward from "lucide-solid/icons/skip-forward";
import StepBack from "lucide-solid/icons/step-back";
import StepForward from "lucide-solid/icons/step-forward";
import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import type { Editor } from "../editor/editor";
import { timelineTotalFrames, type Timeline } from "../model/timeline";
import { formatTimecode } from "../util/timeFormatting";
import type { CubeLUT } from "./effects/lutLoader";
import {
  canvasFormats, canvasGrids, canvasGuides, canvasOverlays, canvasOverlaysEmpty, emptyCanvasOverlays, formatLabels, gridLabel,
  guideLabels, setCanvasOverlays, toggleGuide,
} from "./overlays/canvasGuides";
import { PlaybackEngine } from "./playback";
import type { PreviewSeekMode } from "./previewPlaybackRate";
import type { PreviewQuality } from "./renderer";
import "./PreviewView.css";

export interface PreviewViewProps {
  editor: Editor;
  resolveUrl?: (mediaRef: string) => string | null;
  loadLut?: (path: string) => CubeLUT | undefined;
  /** Frame capture (camera button); receives a PNG of the current frame at full resolution. */
  onCaptureFrame?: (png: Blob) => void;
  /** Exposes the engine (dev page, export hooks). */
  onEngine?: (engine: PlaybackEngine) => void;
  /** Interactive layers drawn over the canvas (captions, transform, crop); sized and placed like the canvas. */
  overlay?: (canvas: { width: number; height: number }, size: { width: number; height: number }) => JSX.Element;
}

const zoomPresets: { label: string; value: number }[] = [
  { label: "25%", value: 0.25 },
  { label: "50%", value: 0.5 },
  { label: "75%", value: 0.75 },
  { label: "Fit", value: 1 },
  { label: "125%", value: 1.25 },
  { label: "150%", value: 1.5 },
  { label: "200%", value: 2 },
];

const shuttleLadder = [1, 2, 4, 10];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function aspectLabel(w: number, h: number): string {
  if (!(w > 0 && h > 0)) return "–";
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

function resolutionLabel(height: number): string {
  if (height >= 2160) return "4K";
  if (height >= 1440) return "QHD";
  if (height >= 1080) return "FHD";
  if (height >= 720) return "HD";
  return `${height}p`;
}

interface MenuEntry {
  label: string;
  selected: boolean;
  run: () => void;
  /** Non-interactive section title. */
  heading?: boolean;
  /** Keep the list open after running (toggle items). */
  keepOpen?: boolean;
  disabled?: boolean;
}

function Menu(props: { label: JSX.Element; title: string; items: MenuEntry[] }) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  const close = (e: PointerEvent): void => {
    if (root && !root.contains(e.target as Node)) setOpen(false);
  };
  onMount(() => document.addEventListener("pointerdown", close));
  onCleanup(() => document.removeEventListener("pointerdown", close));
  return (
    <div class="preview-menu" ref={root}>
      <button class="preview-badge hover-highlight" title={props.title} aria-label={props.title} onClick={() => setOpen((v) => !v)}>
        {props.label}
      </button>
      <Show when={open()}>
        <div class="preview-menu-list" role="menu">
          <For each={props.items}>
            {(item) => (
              <Show
                when={!item.heading}
                fallback={<div class="preview-menu-heading">{item.label}</div>}
              >
                <button
                  class="preview-menu-item"
                  role="menuitemradio"
                  aria-checked={item.selected}
                  disabled={item.disabled}
                  onClick={() => {
                    item.run();
                    if (!item.keepOpen) setOpen(false);
                  }}
                >
                  <span>{item.label}</span>
                  <span class="preview-menu-check">{item.selected ? "✓" : ""}</span>
                </button>
              </Show>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** Port of PreviewContainerView (timeline tab): tab strip, aspect-fit canvas with zoom/pan, scrub bar, transport. */
export function PreviewView(props: PreviewViewProps) {
  const editor = props.editor;
  let canvas: HTMLCanvasElement | undefined;
  let area: HTMLDivElement | undefined;
  const [engine, setEngine] = createSignal<PlaybackEngine | null>(null);
  const [areaSize, setAreaSize] = createSignal({ width: 0, height: 0 });

  const timeline = createMemo((): Timeline | undefined => {
    const doc = editor.doc;
    return doc.timelines.find((t) => t.id === doc.activeTimelineId);
  });
  const fps = () => timeline()?.fps ?? 30;
  const duration = createMemo(() => {
    const t = timeline();
    return t ? timelineTotalFrames(t) : 0;
  });
  const frame = () => engine()?.frame() ?? editor.ui.currentFrame;
  const playing = () => engine()?.playing() ?? false;

  const canvasPlacement = (): JSX.CSSProperties => ({
    width: `${fitSize().width * editor.ui.canvasZoom}px`,
    height: `${fitSize().height * editor.ui.canvasZoom}px`,
    transform: `translate(calc(-50% + ${editor.ui.canvasOffset.width}px), calc(-50% + ${editor.ui.canvasOffset.height}px))`,
  });

  const fitSize = createMemo(() => {
    const t = timeline();
    const { width, height } = areaSize();
    const aspect = t && t.height > 0 ? t.width / t.height : 16 / 9;
    const widthFromHeight = height * aspect;
    return widthFromHeight <= width ? { width: widthFromHeight, height } : { width, height: width / aspect };
  });

  // Overlays are rebuilt when these change, so keep them stable across document edits (a drag edits every move).
  const sameSize = (a: { width: number; height: number }, b: { width: number; height: number }): boolean =>
    a.width === b.width && a.height === b.height;
  const canvasPixels = createMemo(() => ({ width: timeline()?.width ?? 1920, height: timeline()?.height ?? 1080 }), undefined, { equals: sameSize });
  const displayedSize = createMemo(
    () => ({ width: fitSize().width * editor.ui.canvasZoom, height: fitSize().height * editor.ui.canvasZoom }),
    undefined,
    { equals: sameSize },
  );


  onMount(() => {
    if (!canvas || !area) return;
    const e = new PlaybackEngine({ editor, canvas, resolveUrl: props.resolveUrl, loadLut: props.loadLut });
    setEngine(e);
    props.onEngine?.(e);
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setAreaSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(area);
    onCleanup(() => {
      ro.disconnect();
      e.dispose();
    });
  });

  const seekTo = (f: number, mode: PreviewSeekMode = "exact"): void => engine()?.seek(f, mode);

  const onKeyDown = (ev: KeyboardEvent): void => {
    const e = engine();
    if (!e) return;
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const f = e.frame();
    switch (ev.key) {
      case " ":
        e.toggle();
        break;
      case "ArrowLeft":
        seekTo(f - (ev.shiftKey ? 5 : 1), "audibleStepBackward");
        break;
      case "ArrowRight":
        seekTo(f + (ev.shiftKey ? 5 : 1), "audibleStepForward");
        break;
      case "Home":
        seekTo(0);
        break;
      case "End":
        seekTo(duration());
        break;
      case "k": case "K":
        e.pause();
        break;
      case "l": case "L": {
        const s = e.shuttle();
        const next = s > 0 ? shuttleLadder[Math.min(shuttleLadder.length - 1, shuttleLadder.indexOf(s) + 1)] : 1;
        e.setRate(next ?? 1);
        break;
      }
      case "j": case "J": {
        const s = -e.shuttle();
        const next = s > 0 ? shuttleLadder[Math.min(shuttleLadder.length - 1, shuttleLadder.indexOf(s) + 1)] : 1;
        e.setRate(-(next ?? 1));
        break;
      }
      default:
        return;
    }
    ev.preventDefault();
  };

  // Ctrl+wheel zooms around the cursor (PreviewNSView.onCmdScroll); plain wheel pans when zoomed.
  const onWheel = (ev: WheelEvent): void => {
    if (!canvas) return;
    if (ev.ctrlKey) {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const oldZoom = editor.ui.canvasZoom;
      const delta = -ev.deltaY * (ev.deltaMode === 0 ? 0.005 : 0.05);
      const newZoom = Math.min(Math.max(oldZoom * Math.exp(delta), 0.1), 8);
      if (Math.abs(newZoom - oldZoom) < 0.0001) return;
      const fitW = rect.width / oldZoom, fitH = rect.height / oldZoom;
      const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
      const dx = (fitW * (newZoom - oldZoom)) / 2 + px * (1 - newZoom / oldZoom);
      const dy = (fitH * (newZoom - oldZoom)) / 2 + py * (1 - newZoom / oldZoom);
      const o = editor.ui.canvasOffset;
      editor.ui.canvasOffset = { width: o.width + dx, height: o.height + dy };
      editor.ui.canvasZoom = newZoom;
    } else if (editor.ui.canvasZoom !== 1) {
      ev.preventDefault();
      const o = editor.ui.canvasOffset;
      editor.ui.canvasOffset = { width: o.width - ev.deltaX, height: o.height - ev.deltaY };
    }
  };

  let scrubWasPlaying = false;
  const scrubFrame = (ev: PointerEvent, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0)) return 0;
    const fraction = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    return Math.trunc(fraction * Math.max(0, duration()));
  };
  const onScrubDown = (ev: PointerEvent): void => {
    const el = ev.currentTarget as HTMLElement;
    el.setPointerCapture(ev.pointerId);
    scrubWasPlaying = playing();
    if (scrubWasPlaying) engine()?.pause();
    editor.ui.isScrubbing = true;
    seekTo(scrubFrame(ev, el), "interactiveScrub");
  };
  const onScrubMove = (ev: PointerEvent): void => {
    if (!editor.ui.isScrubbing) return;
    seekTo(scrubFrame(ev, ev.currentTarget as HTMLElement), "interactiveScrub");
  };
  const onScrubUp = (ev: PointerEvent): void => {
    if (!editor.ui.isScrubbing) return;
    editor.ui.isScrubbing = false;
    seekTo(scrubFrame(ev, ev.currentTarget as HTMLElement));
    if (scrubWasPlaying) engine()?.play();
  };

  const capture = (): void => {
    const e = engine();
    if (!e) return;
    void e.captureFrame().then((png) => props.onCaptureFrame?.(png));
  };

  const qualityItems = () => {
    const t = timeline();
    const h = t?.height ?? 1080;
    const q = engine()?.quality() ?? "full";
    const entries: [PreviewQuality, string, number][] = [["full", "Full", 1], ["half", "Half", 0.5], ["quarter", "Quarter", 0.25]];
    return entries.map(([value, name, scale]) => ({
      label: `${name} (${resolutionLabel(Math.round(h * scale))})`,
      selected: q === value,
      run: () => engine()?.setQuality(value),
    }));
  };
  const qualityLabel = () => {
    const h = timeline()?.height ?? 1080;
    const q = engine()?.quality() ?? "full";
    return resolutionLabel(Math.round(h * (q === "full" ? 1 : q === "half" ? 0.5 : 0.25)));
  };
  const guideItems = (): MenuEntry[] => {
    const sel = canvasOverlays();
    const item = (label: string, selected: boolean, run: () => void): MenuEntry => ({ label, selected, run, keepOpen: true });
    return [
      { label: "Grid", selected: false, run: () => {}, heading: true },
      item("None", sel.grid === null, () => setCanvasOverlays({ ...sel, grid: null })),
      ...canvasGrids.map((g) => item(gridLabel(g), sel.grid === g, () => setCanvasOverlays({ ...sel, grid: g }))),
      { label: "Safe Zones", selected: false, run: () => {}, heading: true },
      ...canvasGuides.map((g) => item(guideLabels[g], sel.guides.includes(g), () => setCanvasOverlays({ ...sel, guides: toggleGuide(sel.guides, g) }))),
      { label: "Format References", selected: false, run: () => {}, heading: true },
      item("None", sel.format === null, () => setCanvasOverlays({ ...sel, format: null })),
      ...canvasFormats.map((f) => item(formatLabels[f], sel.format === f, () => setCanvasOverlays({ ...sel, format: f }))),
      { label: "Hide Guides", selected: false, run: () => setCanvasOverlays(emptyCanvasOverlays), disabled: canvasOverlaysEmpty(sel) },
    ];
  };
  const zoomLabel = () => {
    const z = editor.ui.canvasZoom;
    return Math.abs(z - 1) < 0.01 ? "Fit" : `${Math.trunc(z * 100)}%`;
  };

  return (
    <div class="panel preview-panel" tabIndex={0} onKeyDown={onKeyDown}>
      <div class="panel-header preview-tabbar">
        <div class="preview-nav">
          <button class="preview-nav-button" disabled title="Back" aria-label="Back"><ChevronLeft size={14} /></button>
          <button class="preview-nav-button" disabled title="Forward" aria-label="Forward"><ChevronRight size={14} /></button>
        </div>
        <div class="preview-tab active" role="tab" aria-selected="true">{timeline()?.name ?? "Timeline"}</div>
        <div class="preview-tabbar-spacer" />
        <button class="preview-nav-button hover-highlight" title="More" aria-label="More"><Ellipsis size={14} /></button>
      </div>

      <div class="preview-canvas-area" ref={area} onWheel={onWheel}>
        <canvas ref={canvas} class="preview-canvas" classList={{ zoomed: editor.ui.canvasZoom < 1 }} style={canvasPlacement()} />
        <Show when={props.overlay}>
          {(overlay) => (
            <div class="preview-overlay" style={canvasPlacement()}>
              {overlay()(canvasPixels(), displayedSize())}
            </div>
          )}
        </Show>
      </div>

      <div
        class="preview-scrub"
        classList={{ active: editor.ui.isScrubbing }}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
      >
        <div class="preview-scrub-track" />
        <div class="preview-scrub-fill" style={{ width: `${duration() > 0 ? (frame() / duration()) * 100 : 0}%` }} />
        <div class="preview-scrub-thumb" style={{ left: `${duration() > 0 ? (frame() / duration()) * 100 : 0}%` }} />
      </div>

      <div class="preview-transport">
        <span class="preview-timecode">
          <span class="timecode">{formatTimecode(frame(), fps())}</span>
          <span class="preview-timecode-sep"> / </span>
          <span class="preview-timecode-total">{formatTimecode(duration(), fps())}</span>
        </span>
        <div class="preview-transport-buttons">
          <button class="preview-transport-button hover-highlight" title="Go to Start" aria-label="Go to Start" onClick={() => seekTo(0)}>
            <SkipBack size={13} fill="currentColor" />
          </button>
          <button class="preview-transport-button hover-highlight" title="Step Back" aria-label="Step Back" onClick={() => seekTo(frame() - 1)}>
            <StepBack size={13} fill="currentColor" />
          </button>
          <button
            class="preview-transport-button hover-highlight"
            title={playing() ? "Pause" : "Play"}
            aria-label={playing() ? "Pause" : "Play"}
            onClick={() => engine()?.toggle()}
          >
            <Show when={playing()} fallback={<Play size={13} fill="currentColor" />}>
              <Pause size={13} fill="currentColor" />
            </Show>
          </button>
          <button class="preview-transport-button hover-highlight" title="Step Forward" aria-label="Step Forward" onClick={() => seekTo(frame() + 1)}>
            <StepForward size={13} fill="currentColor" />
          </button>
          <button class="preview-transport-button hover-highlight" title="Go to End" aria-label="Go to End" onClick={() => seekTo(duration())}>
            <SkipForward size={13} fill="currentColor" />
          </button>
        </div>
        <div class="preview-accessories">
          <button class="preview-icon-button hover-highlight" title="Capture Frame" aria-label="Capture Frame" onClick={capture}>
            <Camera size={13} />
          </button>
          <span class="preview-badge-label" title="Aspect Ratio">{aspectLabel(timeline()?.width ?? 0, timeline()?.height ?? 0)}</span>
          <span class="preview-badge-label" title="Frame Rate">{fps()}</span>
          <Menu label={canvasOverlaysEmpty(canvasOverlays()) ? "Guides" : "Guides ●"} title="Canvas Guides" items={guideItems()} />
          <Menu label={qualityLabel()} title="Preview Quality" items={qualityItems()} />
          <Menu
            label={zoomLabel()}
            title="Canvas Zoom"
            items={zoomPresets.map((p) => ({
              label: p.label,
              selected: Math.abs(editor.ui.canvasZoom - p.value) < 0.01,
              run: () => {
                editor.ui.canvasOffset = { width: 0, height: 0 };
                editor.ui.canvasZoom = p.value;
              },
            }))}
          />
        </div>
      </div>
    </div>
  );
}
