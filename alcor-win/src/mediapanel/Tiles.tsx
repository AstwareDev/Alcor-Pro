import Captions from "lucide-solid/icons/captions";
import AudioWaveform from "lucide-solid/icons/audio-waveform";
import Film from "lucide-solid/icons/film";
import Folder from "lucide-solid/icons/folder";
import ImageIcon from "lucide-solid/icons/image";
import Sparkles from "lucide-solid/icons/sparkles";
import TriangleAlert from "lucide-solid/icons/triangle-exclamation-point";
import Type from "lucide-solid/icons/type";
import Video from "lucide-solid/icons/video";
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js";
import {
  mediaAssetIsGenerated, mediaAssetIsGenerating, timelineTotalFrames, type ClipType, type MediaAsset, type Timeline,
} from "../model";
import type { MediaFolder } from "../model";
import type { Editor } from "../editor/editor";
import { isMediaOffline } from "../media/library";
import { InlineRenameField } from "../ui/InlineRenameField";
import { formatMediaTileDuration } from "./panelModel";
import { measureText, truncateMiddle } from "./textFit";
import { hasPoster, type ThumbnailProvider, type ThumbnailSource } from "./thumbnailProvider";

/** Shared, reactive context of every tile in one grid. */
export interface TileEnv {
  editor: Editor;
  provider: ThumbnailProvider;
  tileWidth: () => number;
  artHeight: () => number;
  asset: (id: string) => MediaAsset | undefined;
  timeline: (id: string) => Timeline | undefined;
  folder: (id: string) => MediaFolder | undefined;
  isSelected: (key: string) => boolean;
  isOnTimeline: (assetId: string) => boolean;
  folderChildCount: (folderId: string) => number;
  renamingKey: () => string | null;
  commitRename: (key: string, name: string) => void;
  cancelRename: () => void;
  /** First visual clip's asset of a timeline, for its poster. */
  timelinePosterAsset: (timeline: Timeline) => MediaAsset | undefined;
}

const typeIcons: Record<ClipType, (p: { size: number }) => JSX.Element> = {
  video: (p) => <Video size={p.size} />,
  audio: (p) => <AudioWaveform size={p.size} />,
  image: (p) => <ImageIcon size={p.size} />,
  text: (p) => <Type size={p.size} />,
  lottie: (p) => <Sparkles size={p.size} />,
  sequence: (p) => <Film size={p.size} />,
  subtitle: (p) => <Captions size={p.size} />,
};

let nameFontFamily: string | undefined;
function nameFont(weight: number): string {
  nameFontFamily ??= getComputedStyle(document.body).fontFamily;
  return `${weight} 9px ${nameFontFamily}`;
}

function drawSource(canvas: HTMLCanvasElement, source: ThumbnailSource, fit: "contain" | "cover"): void {
  const ctx = canvas.getContext("2d");
  if (!ctx || source.width === 0 || source.height === 0) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale =
    fit === "cover"
      ? Math.max(canvas.width / source.width, canvas.height / source.height)
      : Math.min(canvas.width / source.width, canvas.height / source.height);
  const w = source.width * scale;
  const h = source.height * scale;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

/** Per-tile poster canvas: the request starts shortly after mount and is aborted when the tile scrolls away. */
function PosterCanvas(props: {
  path: string;
  type: ClipType;
  provider: ThumbnailProvider;
  width: number;
  height: number;
  fit: "contain" | "cover";
  onReady: (ready: boolean) => void;
}) {
  let canvas!: HTMLCanvasElement;
  createEffect(() => {
    const { path, type, provider, width, height, fit } = props;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    props.onReady(false);
    if (!hasPoster(type)) return;
    const request = { path, type };
    const cached = provider.peek(request);
    if (cached && provider.isLive(cached)) {
      drawSource(canvas, cached, fit);
      props.onReady(true);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const source = await provider.load(request, controller.signal);
            if (controller.signal.aborted || !source) return;
            if (provider.isLive(source)) {
              drawSource(canvas, source, fit);
              props.onReady(true);
              return;
            }
          }
        } catch {
          // aborted or undecodable: the icon fallback stays
        }
      })();
    }, 50);
    onCleanup(() => {
      clearTimeout(timer);
      controller.abort();
    });
  });
  return <canvas ref={canvas} class="mp-poster" style={{ width: `${props.width}px`, height: `${props.height}px` }} />;
}

function TileName(props: {
  env: TileEnv;
  tileKey: string;
  name: string;
  weight: number;
  active?: boolean;
  emphasis: boolean;
}) {
  const label = createMemo(() =>
    truncateMiddle(props.name, props.env.tileWidth() - 8 - (props.active ? 8 : 0), (s) => measureText(s, nameFont(props.weight), 9)),
  );
  return (
    <div class="mp-name" classList={{ renaming: props.env.renamingKey() === props.tileKey }}>
      <Show
        when={props.env.renamingKey() === props.tileKey}
        fallback={
          <>
            <Show when={props.active}>
              <span class="mp-active-dot" />
            </Show>
            <span class="mp-name-text" classList={{ strong: props.emphasis }} style={{ "font-weight": props.weight }} title={props.name}>
              {label()}
            </span>
          </>
        }
      >
        <InlineRenameField
          originalName={props.name}
          placeholder="Name"
          onCommit={(name) => props.env.commitRename(props.tileKey, name)}
          onCancel={() => props.env.cancelRename()}
        />
      </Show>
    </div>
  );
}

function generatingLabel(asset: MediaAsset): string {
  switch (asset.generationStatus.kind) {
    case "downloading": return "Downloading…";
    case "rendering": return "Rendering…";
    default: return "Generating…";
  }
}

function GeneratingOverlay(props: { label: string }) {
  return (
    <div class="mp-generating">
      <span>{props.label}</span>
      <div class="mp-generating-bar"><div /></div>
    </div>
  );
}

export function AssetTile(props: { env: TileEnv; id: string }) {
  const env = props.env;
  const asset = createMemo(() => env.asset(props.id));
  const selected = createMemo(() => env.isSelected(props.id));
  const [posterReady, setPosterReady] = createSignal(false);
  return (
    <Show when={asset()}>
      {(a) => {
        const generating = () => mediaAssetIsGenerating(a());
        const failed = () => {
          const s = a().generationStatus;
          return s.kind === "failed" ? s.message : undefined;
        };
        const offline = createMemo(() => a().generationStatus.kind === "none" && isMediaOffline(env.editor, props.id));
        const showsDuration = () => (a().type === "video" || a().type === "audio") && a().duration > 0;
        return (
          <div class="mp-tile" data-key={props.id} data-kind="asset" classList={{ selected: selected() }} style={{ "--art-h": `${env.artHeight()}px` }}>
            <div class="mp-art mp-art-asset" style={{ height: `${env.artHeight()}px` }}>
              <Show when={!generating() && failed() === undefined && !offline()}>
                <PosterCanvas
                  path={a().url}
                  type={a().type}
                  provider={env.provider}
                  width={env.tileWidth()}
                  height={env.artHeight()}
                  fit="contain"
                  onReady={setPosterReady}
                />
                <Show when={!posterReady()}>
                  <span class="mp-type-icon">{typeIcons[a().type]({ size: 18 })}</span>
                </Show>
              </Show>
              <Show when={generating()}>
                <GeneratingOverlay label={generatingLabel(a())} />
              </Show>
              <Show when={failed()}>
                {(message) => (
                  <div class="mp-art-status" title={message()}>
                    <TriangleAlert size={14} class="mp-status-failed" />
                    <b>Failed</b>
                    <small>{message()}</small>
                  </div>
                )}
              </Show>
              <Show when={offline()}>
                <div
                  class="mp-art-status"
                  title="Alcor Pro couldn't load this source file. It may be missing, on an ejected drive, or unreadable."
                >
                  <TriangleAlert size={14} class="mp-status-offline" />
                  <b>Media Offline</b>
                </div>
              </Show>
              <Show when={mediaAssetIsGenerated(a()) && !generating()}>
                <span class="mp-badge mp-badge-ai">AI</span>
              </Show>
              <Show when={showsDuration()}>
                <span class="mp-badge mp-badge-duration">{formatMediaTileDuration(a().duration)}</span>
              </Show>
              <div class="mp-ring" classList={{ selected: selected(), offline: offline() }} />
            </div>
            <Show when={env.isOnTimeline(props.id)}>
              <div class="mp-used" style={{ background: `var(--track-${a().type})` }} />
            </Show>
            <TileName env={env} tileKey={props.id} name={a().name} weight={400} emphasis={selected()} />
          </div>
        );
      }}
    </Show>
  );
}

export function FolderTile(props: { env: TileEnv; id: string; tileKey: string }) {
  const env = props.env;
  const folder = createMemo(() => env.folder(props.id));
  const selected = createMemo(() => env.isSelected(props.tileKey));
  return (
    <Show when={folder()}>
      {(f) => (
        <div
          class="mp-tile"
          data-key={props.tileKey}
          data-kind="folder"
          data-drop-folder={props.id}
          classList={{ selected: selected() }}
        >
          <div class="mp-art mp-art-tinted" style={{ height: `${env.artHeight()}px` }}>
            <Folder size={36} stroke-width={1} fill="currentColor" class="mp-folder-icon" />
            <Show when={env.folderChildCount(props.id) > 0}>
              <span class="mp-badge mp-badge-count">{env.folderChildCount(props.id)}</span>
            </Show>
            <div class="mp-ring" classList={{ selected: selected() }} />
          </div>
          <TileName env={env} tileKey={props.tileKey} name={f().name} weight={500} emphasis />
        </div>
      )}
    </Show>
  );
}

export function TimelineTile(props: { env: TileEnv; id: string; tileKey: string }) {
  const env = props.env;
  const timeline = createMemo(() => env.timeline(props.id));
  const selected = createMemo(() => env.isSelected(props.tileKey));
  const posterAsset = createMemo(() => {
    const t = timeline();
    return t ? env.timelinePosterAsset(t) : undefined;
  });
  const [posterLoaded, setPosterLoaded] = createSignal(false);
  const posterReady = () => posterLoaded() && posterAsset() !== undefined;
  return (
    <Show when={timeline()}>
      {(t) => {
        const active = () => env.editor.doc.activeTimelineId === props.id;
        const frames = () => timelineTotalFrames(t());
        return (
          <div class="mp-tile" data-key={props.tileKey} data-kind="timeline" classList={{ selected: selected() }}>
            <div class="mp-art mp-art-tinted" style={{ height: `${env.artHeight()}px` }}>
              <Show when={posterAsset()}>
                {(p) => (
                  <PosterCanvas
                    path={p().url}
                    type={p().type}
                    provider={env.provider}
                    width={env.tileWidth()}
                    height={env.artHeight()}
                    fit="cover"
                    onReady={setPosterLoaded}
                  />
                )}
              </Show>
              <Show when={!posterReady()}>
                <Film size={18} stroke-width={1.25} class="mp-timeline-icon" />
              </Show>
              <Show when={frames() > 0}>
                <span class="mp-badge mp-badge-duration">
                  {formatMediaTileDuration(frames() / Math.max(t().fps, 1))}
                </span>
              </Show>
              <Show when={posterReady()}>
                <span class="mp-badge mp-badge-type" classList={{ active: active() }}>
                  <Film size={9} />
                </span>
              </Show>
              <div class="mp-ring" classList={{ selected: selected() }} />
            </div>
            <TileName env={env} tileKey={props.tileKey} name={t().name} weight={500} active={active()} emphasis />
          </div>
        );
      }}
    </Show>
  );
}
