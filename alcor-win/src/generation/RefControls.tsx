// Port of UI/ReferenceControls.swift + DropZoneView.swift: reference cards, dashed drop tiles and labelled frame slots.
import CircleX from "lucide-solid/icons/circle-x";
import Film from "lucide-solid/icons/film";
import ImageIcon from "lucide-solid/icons/image";
import ImagePlus from "lucide-solid/icons/image-plus";
import Plus from "lucide-solid/icons/plus";
import AudioWaveform from "lucide-solid/icons/audio-waveform";
import { createEffect, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import type { ClipType, MediaAsset } from "../model";
import { decodeMediaDrag } from "../mediapanel/dragPayload";
import { activeMediaDrag, mediaDropEventName, type MediaDropDetail } from "../mediapanel/dragSession";
import { defaultThumbnailProvider, hasPoster, type ThumbnailProvider } from "../mediapanel/thumbnailProvider";
import type { Editor } from "../editor/editor";
import "./generation.css";

export type DropIcon = "image" | "video" | "audio" | "plus";

function DropIconView(props: { icon: DropIcon }) {
  return (
    <>
      {props.icon === "plus" ? <Plus size={14} /> : props.icon === "video" ? <Film size={14} /> : props.icon === "audio" ? <AudioWaveform size={14} /> : <ImagePlus size={14} />}
    </>
  );
}

export function assetsFromDragPayload(editor: Editor, payload: string): MediaAsset[] {
  return decodeMediaDrag(payload).assets.flatMap((a) => editor.mediaAsset(a.id) ?? []);
}

function Poster(props: { asset: MediaAsset; provider: ThumbnailProvider }) {
  let canvas!: HTMLCanvasElement;
  const [drawn, setDrawn] = createSignal(false);
  createEffect(() => {
    const { url, type } = props.asset;
    const ready = props.asset.generationStatus.kind === "none";
    setDrawn(false);
    if (!hasPoster(type) || !ready) return;
    const controller = new AbortController();
    const draw = (src: Awaited<ReturnType<ThumbnailProvider["load"]>>) => {
      if (!src || controller.signal.aborted) return;
      canvas.width = src.width;
      canvas.height = src.height;
      canvas.getContext("2d")?.drawImage(src, 0, 0);
      setDrawn(true);
    };
    const cached = props.provider.peek({ path: url, type });
    if (cached) draw(cached);
    else props.provider.load({ path: url, type }, controller.signal).then(draw, () => undefined);
    onCleanup(() => controller.abort());
  });
  return (
    <div class="gen-ref-preview" title={props.asset.name}>
      <canvas ref={canvas} style={{ display: drawn() ? "block" : "none" }} />
      <Show when={!drawn()}>
        {props.asset.type === "audio" ? <AudioWaveform size={16} /> : props.asset.type === "video" ? <Film size={16} /> : <ImageIcon size={16} />}
      </Show>
    </div>
  );
}

export function RefCard(props: { asset: MediaAsset; tag?: string; provider?: ThumbnailProvider; onRemove?: () => void }) {
  return (
    <div class="gen-ref-card">
      <Poster asset={props.asset} provider={props.provider ?? defaultThumbnailProvider} />
      <Show when={props.tag}>{(tag) => <span class="gen-ref-tag">{tag()}</span>}</Show>
      <Show when={props.onRemove}>
        {(remove) => (
          <button type="button" class="gen-ref-remove" aria-label={`Remove ${props.asset.name}`} onClick={() => remove()()}>
            <CircleX size={13} />
          </button>
        )}
      </Show>
    </div>
  );
}

/** Dashed drop tile; delivers dragged media-panel assets of the accepted types. */
export function RefDropZone(props: {
  editor: Editor;
  accepting?: ReadonlySet<ClipType>;
  icon?: DropIcon;
  onDrop: (asset: MediaAsset) => void;
}) {
  let el!: HTMLDivElement;
  const [hover, setHover] = createSignal(false);
  onMount(() => {
    const onDropEvent = (e: Event) => {
      const detail = (e as CustomEvent<MediaDropDetail>).detail;
      setHover(false);
      for (const asset of assetsFromDragPayload(props.editor, detail.payload)) {
        if (!props.accepting || props.accepting.has(asset.type)) props.onDrop(asset);
      }
    };
    const enter = () => setHover(activeMediaDrag() !== null);
    const leave = () => setHover(false);
    el.addEventListener(mediaDropEventName, onDropEvent);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointermove", enter);
    el.addEventListener("pointerleave", leave);
    onCleanup(() => {
      el.removeEventListener(mediaDropEventName, onDropEvent);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointermove", enter);
      el.removeEventListener("pointerleave", leave);
    });
  });
  return (
    <div ref={el} class="gen-drop" classList={{ targeted: hover() }} role="button" aria-label="Drop media here">
      <DropIconView icon={props.icon ?? "image"} />
    </div>
  );
}

/** Labelled single-asset slot: the asset thumbnail or a drop zone reporting type mismatches through `onError`. */
export function FrameSlot(props: {
  editor: Editor;
  label: string;
  asset: MediaAsset | undefined;
  accepting?: ReadonlySet<ClipType>;
  icon?: DropIcon;
  provider?: ThumbnailProvider;
  onDrop: (asset: MediaAsset) => void;
  onClear: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const accepting = (): ReadonlySet<ClipType> => props.accepting ?? new Set<ClipType>(["image"]);
  return (
    <div class="gen-slot">
      <span class="gen-label">{props.label}</span>
      <Show
        when={props.asset}
        fallback={
          <RefDropZone
            editor={props.editor}
            icon={props.icon}
            onDrop={(dropped) => {
              if (accepting().has(dropped.type)) props.onDrop(dropped);
              else props.onError(`Drop ${[...accepting()].sort().join(" or ")} here.`);
            }}
          />
        }
      >
        {(asset) => <RefCard asset={asset()} provider={props.provider} onRemove={props.onClear} />}
      </Show>
    </div>
  );
}
