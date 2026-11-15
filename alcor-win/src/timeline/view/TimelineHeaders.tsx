import { createMemo, createSignal, For, Index, Show, type JSX } from "solid-js";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Diamond from "lucide-solid/icons/diamond";
import Eye from "lucide-solid/icons/eye";
import EyeOff from "lucide-solid/icons/eye-off";
import Link from "lucide-solid/icons/link";
import Menu from "lucide-solid/icons/menu";
import Unlink from "lucide-solid/icons/unlink";
import Volume2 from "lucide-solid/icons/volume-2";
import VolumeX from "lucide-solid/icons/volume-x";
import {
  TrackName,
  animatablePropertyDisplayName,
  animatablePropertyLanes,
  clipSupportsKeyframes,
  clipHasActiveKeyframes,
  type AnimatableProperty,
  type Timeline,
  type Track,
} from "../../model";
import type { Editor } from "../../editor/editor";
import { seekToFrame } from "../../editor/mutations/core";
import { hasKeyframe, toggleKeyframe } from "../../editor/mutations/keyframes";
import { zones } from "../../editor/mutations/linking";
import {
  commitTrackReorder,
  reorderTrackLive,
  setTrackHeight,
  setTrackName,
  timelineTrackDisplayLabel,
  toggleTrackHidden,
  toggleTrackMute,
  toggleTrackSyncLock,
} from "../../editor/mutations/tracks";
import { snapshot } from "../../util/snapshot";
import { ContextMenu, type ContextMenuItem } from "../../ui/ContextMenu";
import { InlineRenameField } from "../../ui/InlineRenameField";
import { laneY, makeTimelineGeometryForTimeline, timelineKeyframeLaneHeight, trackAt, trackBlockBottomAt, trackYAt } from "../timelineGeometry";
import { keyframeLaneNavigationTargets, keyframeLaneTarget } from "../timelineInput";
import { laneStateToggle, type TimelineKeyframeLaneState } from "../timelineKeyframeLaneState";
import { trackHeaderContextMenu } from "./contextMenus";
import { resizeHandleTrackAt, resizedTrackHeight, trackHeaderLayout } from "./headerLayout";
import type { TimelineInputController } from "./inputController";
import { clipTypeThemeColorKind, readableForeground, rgbCss, sharedTimelineClipColorPalette } from "./timelineClipColors";

// Port of TimelineHeaderView: DOM rows positioned from the same geometry as the canvas.

type HeaderDrag =
  | { kind: "reorder"; id: string; before: Timeline }
  | { kind: "resize"; trackIndex: number; originalHeight: number; laneCount: number };

export function TimelineHeaders(props: {
  editor: Editor;
  controller: () => TimelineInputController | undefined;
  laneState: TimelineKeyframeLaneState;
  laneRevision: () => number;
  width: number;
  scrollY: () => number;
  onChanged: () => void;
}) {
  const editor = props.editor;
  const colors = sharedTimelineClipColorPalette();
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [drag, setDrag] = createSignal<HeaderDrag | null>(null);
  const [cursor, setCursor] = createSignal("default");
  let container!: HTMLDivElement;

  const geometry = createMemo(() => {
    props.laneRevision();
    return makeTimelineGeometryForTimeline({ timeline: editor.timeline, zoomScale: editor.ui.zoomScale, bounds: { x: 0, y: 0, width: props.width, height: 0 }, laneState: props.laneState });
  });
  const divider = createMemo(() => {
    const z = zones(editor);
    return z.videoTrackCount > 0 && z.audioTrackCount > 0 ? trackYAt(geometry(), z.firstAudioIndex) : undefined;
  });

  const docY = (e: PointerEvent | MouseEvent) => e.clientY - container.getBoundingClientRect().top + props.scrollY();

  const finishDrag = (cancel: boolean) => {
    const d = drag();
    setDrag(null);
    if (!d) return;
    if (d.kind === "reorder") {
      if (cancel) {
        editor.withoutRegistration(() => {
          editor.timeline.tracks = structuredClone(d.before.tracks);
        });
      } else commitTrackReorder(editor, d.before);
    } else {
      const track = editor.timeline.tracks[d.trackIndex];
      const final = track?.displayHeight ?? d.originalHeight;
      if (final !== d.originalHeight) {
        editor.withoutRegistration(() => {
          const t = editor.timeline.tracks[d.trackIndex];
          if (t) t.displayHeight = d.originalHeight;
        });
        if (!cancel) setTrackHeight(editor, d.trackIndex, final);
      }
    }
    props.onChanged();
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input")) return;
    const y = docY(e);
    if (y < props.scrollY() + 28) return;
    const ti = resizeHandleTrackAt(geometry(), y);
    if (ti === undefined) return;
    const track = editor.timeline.tracks[ti];
    if (!track) return;
    container.setPointerCapture(e.pointerId);
    setDrag({ kind: "resize", trackIndex: ti, originalHeight: track.displayHeight, laneCount: geometry().laneProperties[ti]?.length ?? 0 });
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag();
    const y = docY(e);
    if (!d) {
      setCursor(resizeHandleTrackAt(geometry(), y) !== undefined ? "ns-resize" : "default");
      return;
    }
    if (d.kind === "reorder") {
      reorderTrackLive(editor, d.id, trackAt(geometry(), y));
      props.onChanged();
      return;
    }
    const height = resizedTrackHeight(geometry(), d.trackIndex, y, d.laneCount, timelineKeyframeLaneHeight);
    if (editor.timeline.tracks[d.trackIndex]?.displayHeight !== height) {
      editor.withoutRegistration(() => {
        const t = editor.timeline.tracks[d.trackIndex];
        if (t) t.displayHeight = height;
      });
      props.onChanged();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && drag()) {
      e.stopPropagation();
      finishDrag(true);
    }
  };

  const beginReorder = (e: PointerEvent, track: Track) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    container.setPointerCapture(e.pointerId);
    setDrag({ kind: "reorder", id: track.id, before: snapshot(editor.timeline) });
  };

  const audioOnKeyframe = (track: Track): boolean => {
    const frame = editor.ui.currentFrame;
    const clip = keyframeLaneTarget(editor.timeline, track.id, "volume", frame);
    return clip !== undefined && hasKeyframe(editor, clip.id, "volume", frame);
  };

  const toggleAudioKeyframe = (track: Track) => {
    const frame = editor.ui.currentFrame;
    const clip = keyframeLaneTarget(editor.timeline, track.id, "volume", frame);
    if (!clip) return;
    editor.ui.selectedGap = null;
    editor.ui.selectedClipIds = new Set([clip.id]);
    toggleKeyframe(editor, clip.id, "volume", frame);
  };

  const iconButton = (rect: { x: number; y: number }, title: string, onClick: () => void, child: JSX.Element, tint: string): JSX.Element => (
    <button
      type="button"
      class="timeline-header-icon"
      title={title}
      style={{ left: `${rect.x}px`, top: `${rect.y}px`, color: tint }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
    >
      {child}
    </button>
  );

  const Row = (p: { track: () => Track; index: number }): JSX.Element => {
    const layout = () => trackHeaderLayout(geometry(), p.index, props.width);
    const rowTop = () => layout().row.y;
    const local = (r: { x: number; y: number }) => ({ x: r.x, y: r.y - rowTop() });
    const track = p.track;
    const typeColor = () => {
      colors.revision();
      return colors.color(clipTypeThemeColorKind(track().type));
    };
    const off = "var(--timeline-header-icon-off)";
    const on = "var(--text-secondary)";
    const lanes = () => animatablePropertyLanes(track());
    const keyframeVisible = () =>
      (track().type === "audio" && track().clips.some((c) => clipSupportsKeyframes(c, "volume"))) || (track().type !== "audio" && lanes().length > 0);
    const keyframeActive = () => (track().type === "audio" ? audioOnKeyframe(track()) : props.laneState.expandedTrackIds.has(track().id) && props.laneRevision() >= 0);
    return (
      <div
        class="timeline-header-row"
        classList={{ lifted: drag()?.kind === "reorder" && (drag() as { id: string }).id === track().id, first: p.index === 0 }}
        style={{ top: `${rowTop()}px`, height: `${layout().row.height}px` }}
        onContextMenu={(e) => {
          e.preventDefault();
          const c = props.controller();
          if (!c) return;
          const items = trackHeaderContextMenu(c, p.index, true, (id) => setRenamingId(id));
          if (items) setMenu({ x: e.clientX, y: e.clientY, items });
        }}
      >
        <div class="timeline-header-strip" style={{ background: rgbCss(typeColor()) }} />
        <div
          class="timeline-header-grip"
          style={{ left: `${local(layout().grip).x}px`, top: `${local(layout().grip).y}px` }}
          onPointerDown={(e) => beginReorder(e, track())}
        >
          <Menu size={12} />
        </div>
        <div
          class="timeline-header-label"
          style={{ left: `${layout().label.x}px`, top: `${local(layout().label).y}px`, width: `${layout().label.width}px`, height: `${layout().label.height}px` }}
          onDblClick={() => setRenamingId(track().id)}
        >
          <span class="timeline-header-designation">{timelineTrackDisplayLabel(editor, p.index)}</span>
          <Show
            when={renamingId() === track().id}
            fallback={
              <Show when={track().name}>
                {(name) => (
                  <span
                    class="timeline-header-name"
                    style={{ background: rgbCss(typeColor(), 0.8), color: readableForeground(typeColor()) }}
                  >
                    {name()}
                  </span>
                )}
              </Show>
            }
          >
            <span class="timeline-header-rename">
              <InlineRenameField
                originalName={track().name ?? ""}
                placeholder={timelineTrackDisplayLabel(editor, p.index)}
                maximumLength={TrackName.maximumLength}
                allowsEmptyCommit
                onCommit={(name) => {
                  setRenamingId(null);
                  try {
                    setTrackName(editor, track().id, name);
                  } catch {
                    editor.refuseWithToast("Couldn't rename track.");
                  }
                }}
                onCancel={() => setRenamingId(null)}
              />
            </span>
          </Show>
        </div>
        <Show when={keyframeVisible()}>
          {iconButton(
            local(layout().keyframe),
            track().type === "audio" ? (audioOnKeyframe(track()) ? "Delete keyframe" : "Add keyframe") : keyframeActive() ? "Hide clip keyframes" : "Show clip keyframes",
            () => {
              if (track().type === "audio") toggleAudioKeyframe(track());
              else laneStateToggle(props.laneState, track().id);
            },
            <Diamond size={11} fill={keyframeActive() ? "currentColor" : "none"} />,
            keyframeActive() ? "var(--accent-timecode)" : off,
          )}
        </Show>
        {iconButton(
          local(layout().sync),
          track().syncLocked ? "Sync Lock On" : "Sync Lock Off",
          () => toggleTrackSyncLock(editor, p.index),
          track().syncLocked ? <Link size={11} /> : <Unlink size={11} />,
          track().syncLocked ? on : off,
        )}
        {track().type === "audio"
          ? iconButton(local(layout().visibility), track().muted ? "Unmute" : "Mute", () => toggleTrackMute(editor, p.index), track().muted ? <VolumeX size={11} /> : <Volume2 size={11} />, track().muted ? off : on)
          : iconButton(local(layout().visibility), track().hidden ? "Show" : "Hide", () => toggleTrackHidden(editor, p.index), track().hidden ? <EyeOff size={11} /> : <Eye size={11} />, track().hidden ? off : on)}
        <For each={props.laneState.expandedTrackIds.has(track().id) && props.laneRevision() >= 0 ? geometry().laneProperties[p.index] ?? [] : []}>
          {(property) => <LaneHeader track={track()} property={property} top={(laneY(geometry(), p.index, property) ?? 0) - rowTop()} />}
        </For>
      </div>
    );
  };

  const LaneHeader = (p: { track: Track; property: AnimatableProperty; top: number }): JSX.Element => {
    const frame = () => editor.ui.currentFrame;
    const target = () => keyframeLaneTarget(editor.timeline, p.track.id, p.property, frame());
    const nav = () => keyframeLaneNavigationTargets(editor.timeline, p.track.id, p.property, frame());
    const go = (t: { clipId: string; frame: number } | undefined) => {
      if (!t) return;
      editor.ui.selectedGap = null;
      editor.ui.selectedClipIds = new Set([t.clipId]);
      seekToFrame(editor, t.frame);
    };
    const onKey = () => {
      const clip = target();
      return clip !== undefined && hasKeyframe(editor, clip.id, p.property, frame());
    };
    return (
      <div class="timeline-lane-header" style={{ top: `${p.top}px`, height: `${timelineKeyframeLaneHeight}px` }}>
        <span class="timeline-lane-name">{animatablePropertyDisplayName(p.property)}</span>
        <button type="button" class="timeline-lane-button" disabled={!nav().previous} onClick={() => go(nav().previous)}>
          <ChevronLeft size={10} />
        </button>
        <button
          type="button"
          class="timeline-lane-button"
          disabled={!target()}
          title={target() ? undefined : "Move playhead inside the clip"}
          classList={{ on: onKey(), has: target() !== undefined && clipHasActiveKeyframes(target() as NonNullable<ReturnType<typeof target>>, p.property) }}
          onClick={() => {
            const clip = target();
            if (clip) toggleKeyframe(editor, clip.id, p.property, frame());
          }}
        >
          <Diamond size={9} fill={onKey() ? "currentColor" : "none"} />
        </button>
        <button type="button" class="timeline-lane-button" disabled={!nav().next} onClick={() => go(nav().next)}>
          <ChevronRight size={10} />
        </button>
      </div>
    );
  };

  return (
    <div
      class="timeline-headers"
      style={{ width: `${props.width}px`, cursor: drag()?.kind === "reorder" ? "grabbing" : drag()?.kind === "resize" ? "ns-resize" : cursor() }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => finishDrag(false)}
      onPointerCancel={() => finishDrag(true)}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div ref={container} class="timeline-headers-content" style={{ transform: `translateY(${-props.scrollY()}px)` }}>
        <Index each={editor.timeline.tracks}>{(track, index) => <Row track={track} index={index} />}</Index>
        <Show when={divider()}>{(y) => <div class="timeline-header-divider" style={{ top: `${y() - 1}px` }} />}</Show>
        <Index each={editor.timeline.tracks}>
          {(_, index) => (
            <Show when={(geometry().laneProperties[index]?.length ?? 0) > 0}>
              <div class="timeline-header-block-bottom" style={{ top: `${trackBlockBottomAt(geometry(), index) - 1}px` }} />
            </Show>
          )}
        </Index>
      </div>
      <div class="timeline-header-ruler-cover" />
      <Show when={menu()}>{(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(null)} />}</Show>
    </div>
  );
}
