import Heart from "lucide-solid/icons/heart";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { makeTextStyle, makeTransform, cloneTextStyle } from "../model";
import { AnimatedCaptionCanvas } from "../captions/AnimatedCaptionCanvas";
import { captionPreviewClip, captionPreviewLoopFrames, drawCaptionPreviewFrame } from "../captions/captionPreviewRender";
import { armMediaDrag } from "../mediapanel/dragSession";
import { TextRenderer } from "../preview/textRenderer";
import { buildPresetEffects } from "../editor/mutations/presets";
import type { LibraryController, LibraryItem } from "./libraryController";
import { startHoverPreview, titleDragString } from "./libraryActions";
import { drawTitlePreview, lookRenderer, sampleImage, thumbH, thumbW } from "./previews";
import type { Preset } from "./presetFormat";
import type { Editor } from "../editor/editor";

const hoverDelayMs = 140;
let textRenderer: TextRenderer | undefined;

function LookArt(props: { preset: Extract<Preset, { kind: "look" | "effect" }>; controller: LibraryController; canvas: (el: HTMLCanvasElement) => void }) {
  let canvas: HTMLCanvasElement | undefined;
  createEffect(() => {
    props.controller.lutVersion();
    if (!canvas) return;
    const renderer = lookRenderer();
    const built = buildPresetEffects(props.preset.effects, { resolveResource: props.controller.resolveResource });
    // A look whose LUT is still loading keeps the unprocessed sample until the file lands.
    if (!renderer?.render(built.effects, canvas, props.controller.loadLut)) canvas.getContext("2d")?.drawImage(sampleImage(), 0, 0, canvas.width, canvas.height);
  });
  return <canvas ref={(el) => { canvas = el; props.canvas(el); }} width={thumbW} height={thumbH} />;
}

function TextArt(props: { preset: Extract<Preset, { kind: "textStyle" }>; canvas: (el: HTMLCanvasElement) => void }) {
  let canvas: HTMLCanvasElement | undefined;
  createEffect(() => {
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    textRenderer ??= new TextRenderer();
    const style = cloneTextStyle(props.preset.style);
    // fontScale grows font, outline, shadow and box together so the thumbnail reads at 108 px tall.
    style.fontScale = Math.min(3, 190 / Math.max(1, style.fontSize));
    const clip = captionPreviewClip({
      content: "Aa Bb", style, preset: "none", highlight: undefined,
      transform: makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.92, height: 0.55 }),
    });
    drawCaptionPreviewFrame(textRenderer, ctx, clip, 0, { width: canvas.width, height: canvas.height });
  });
  return <canvas ref={(el) => { canvas = el; props.canvas(el); }} width={thumbW} height={thumbH} />;
}

function TitleArt(props: { preset: Extract<Preset, { kind: "title" }>; canvas: (el: HTMLCanvasElement) => void }) {
  let canvas: HTMLCanvasElement | undefined;
  createEffect(() => {
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    drawTitlePreview(props.preset, canvas);
  });
  return <canvas ref={(el) => { canvas = el; props.canvas(el); }} width={thumbW} height={thumbH} />;
}

function AnimationArt(props: { preset: Extract<Preset, { kind: "textAnimation" }>; hovering: () => boolean }) {
  const clip = createMemo(() =>
    captionPreviewClip({
      content: "Aa Bb Cc",
      style: makeTextStyle({ fontSize: 300 }),
      transform: makeTransform({ centerX: 0.5, centerY: 0.5, width: 0.92, height: 0.55 }),
      preset: props.preset.animation.preset,
      highlight: props.preset.animation.highlight,
    }),
  );
  return (
    <AnimatedCaptionCanvas
      clip={clip}
      width={() => 150}
      height={() => 84}
      animating={() => props.preset.animation.preset !== "none" && props.hovering()}
      posterFrame={() => captionPreviewLoopFrames(props.preset.animation.preset) - 1}
    />
  );
}

/** One grid cell: live thumbnail, name, favourite toggle, licence badge; click applies, drag (titles) places. */
export function PresetTile(props: {
  item: LibraryItem;
  editor: Editor;
  controller: LibraryController;
  onApply: (preset: Preset) => void;
}) {
  const preset = (): Preset => props.item.preset;
  const [hovering, setHovering] = createSignal(false);
  let art: HTMLCanvasElement | undefined;
  let revert: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const favourite = (): boolean => props.controller.favourites().has(preset().id);
  const options = () => ({ resolveResource: props.controller.resolveResource });

  const stopPreview = (): void => {
    clearTimeout(timer);
    revert?.();
    revert = undefined;
  };
  onCleanup(stopPreview);

  const enter = (): void => {
    setHovering(true);
    if (preset().kind !== "look" && preset().kind !== "effect") return;
    timer = setTimeout(() => {
      revert = startHoverPreview(props.editor, preset(), options());
    }, hoverDelayMs);
  };
  const leave = (): void => {
    setHovering(false);
    stopPreview();
  };

  const licence = (): string | undefined => {
    const pack = props.item.pack?.pack;
    return pack?.licence.requiresAttribution ? pack.licence.name : undefined;
  };

  return (
    <div
      class="lib-tile"
      role="button"
      tabIndex={0}
      title={preset().name}
      data-preset-id={preset().id}
      onPointerEnter={enter}
      onPointerLeave={leave}
      onPointerDown={(e) => {
        stopPreview();
        const p = preset();
        if (p.kind === "title" && !(e.target as HTMLElement).closest(".lib-fav")) {
          armMediaDrag(e, () => ({ payload: titleDragString(p.id), label: p.name, count: 1, previewCanvas: art ?? null }));
        }
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest(".lib-fav")) return;
        stopPreview();
        props.onApply(preset());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          stopPreview();
          props.onApply(preset());
        }
      }}
    >
      <div class="lib-art" classList={{ text: preset().kind !== "look" && preset().kind !== "effect" }}>
        {(() => {
          const p = preset();
          const setArt = (el: HTMLCanvasElement): void => { art = el; };
          switch (p.kind) {
            case "look":
            case "effect": return <LookArt preset={p} controller={props.controller} canvas={setArt} />;
            case "textStyle": return <TextArt preset={p} canvas={setArt} />;
            case "title": return <TitleArt preset={p} canvas={setArt} />;
            case "textAnimation": return <AnimationArt preset={p} hovering={hovering} />;
          }
        })()}
        <button
          type="button"
          class="lib-fav"
          classList={{ on: favourite() }}
          aria-label={favourite() ? `Remove ${preset().name} from favourites` : `Add ${preset().name} to favourites`}
          aria-pressed={favourite()}
          onClick={() => props.controller.toggleFavourite(preset().id)}
        >
          <Heart size={11} fill={favourite() ? "currentColor" : "none"} />
        </button>
        <Show when={licence()}>{(name) => <span class="lib-badge">{name()}</span>}</Show>
      </div>
      <span class="lib-name">{preset().name}</span>
    </div>
  );
}
