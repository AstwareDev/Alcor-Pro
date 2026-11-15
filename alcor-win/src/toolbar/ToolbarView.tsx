import { createSignal, Show, type JSX } from "solid-js";
import ChevronDown from "lucide-solid/icons/chevron-down";
import Film from "lucide-solid/icons/film";
import MousePointer2 from "lucide-solid/icons/mouse-pointer-2";
import MoveHorizontal from "lucide-solid/icons/move-horizontal";
import Redo2 from "lucide-solid/icons/redo-2";
import Scissors from "lucide-solid/icons/scissors";
import SquareSplitHorizontal from "lucide-solid/icons/square-split-horizontal";
import Undo2 from "lucide-solid/icons/undo-2";
import ZoomIn from "lucide-solid/icons/zoom-in";
import ZoomOut from "lucide-solid/icons/zoom-out";
import { Zoom } from "../model";
import type { Editor } from "../editor/editor";
import { addAdjustmentLayer } from "../editor/mutations/adjustmentLayer";
import { splitAtPlayhead, trimEndToPlayhead, trimStartToPlayhead } from "../editor/mutations/clipMutations";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { minZoomScale } from "../timeline/timelineInput";
import type { TimelineToolMode } from "../timeline/view/inputController";
import { addTimelineMarkerAtSelection } from "../timeline/view/timelineMarkerCommands";
import { isTimelineTabBarExpanded, toggleTimelineTabBarExpanded } from "../timeline/view/timelineTabs";
import { setTimelineToolMode, timelineToolMode } from "../timeline/view/toolMode";
import "./Toolbar.css";

/** Port of Toolbar/ToolbarView.swift (the timeline toolbar). */
export function ToolbarView(props: {
  editor: Editor;
  presentMarkerEditor: (id: string) => void;
  /** Swift `addTextClip`; the button is hidden until text clip creation is ported. */
  onAddText?: () => void;
}) {
  const editor = props.editor;
  const ui = editor.ui;
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const minZoom = () => minZoomScale(editor.timeline, ui.timelineVisibleWidth);
  const setZoom = (z: number) => {
    ui.zoomScale = Math.min(Zoom.max, Math.max(minZoom(), z));
  };

  const button = (title: string, onClick: () => void, child: JSX.Element, extra: { active?: boolean; disabled?: boolean; class?: string } = {}) => (
    <button
      type="button"
      class={`toolbar-button hover-highlight ${extra.class ?? ""}`}
      classList={{ active: extra.active, disabled: extra.disabled }}
      title={title}
      disabled={extra.disabled}
      onClick={onClick}
    >
      {child}
    </button>
  );
  const tool = (mode: TimelineToolMode, title: string, child: JSX.Element) =>
    button(title, () => setTimelineToolMode(editor, mode), child, { active: timelineToolMode(editor) === mode, class: "tool" });
  const divider = () => <div class="toolbar-divider" />;

  return (
    <div class="toolbar">
      {button(
        isTimelineTabBarExpanded(editor) ? "Hide Timeline Tabs" : "Show Timeline Tabs",
        () => toggleTimelineTabBarExpanded(editor),
        <Film size={13} fill={isTimelineTabBarExpanded(editor) ? "currentColor" : "none"} fill-opacity={0.25} />,
        { active: isTimelineTabBarExpanded(editor), class: "tool" },
      )}
      {divider()}
      <div class="toolbar-group">
        {button(`${editor.store.undoActionName ? `Undo ${editor.store.undoActionName}` : "Undo"} (Ctrl+Z)`, () => editor.undo(), <Undo2 size={13} />, { disabled: !editor.store.canUndo })}
        {button(`${editor.store.redoActionName ? `Redo ${editor.store.redoActionName}` : "Redo"} (Ctrl+Shift+Z)`, () => editor.redo(), <Redo2 size={13} />, { disabled: !editor.store.canRedo })}
      </div>
      {divider()}
      <div class="toolbar-group">
        {tool("pointer", "Pointer (V)", <MousePointer2 size={13} />)}
        {tool("razor", "Razor (C)", <Scissors size={13} />)}
        {tool("trim", "Trim (T)", <MoveHorizontal size={13} />)}
      </div>
      {divider()}
      <div class="toolbar-group">
        {button("Split at Playhead (Ctrl+K)", () => splitAtPlayhead(editor), <SquareSplitHorizontal size={13} />)}
        {button("Trim Start to Playhead (Q)", () => trimStartToPlayhead(editor), <span class="toolbar-glyph bracket">[</span>)}
        {button("Trim End to Playhead (W)", () => trimEndToPlayhead(editor), <span class="toolbar-glyph bracket">]</span>)}
      </div>
      {divider()}
      <div class="toolbar-group">
        {button("Add Adjustment Layer", () => addAdjustmentLayer(editor), <span class="toolbar-glyph">Adj</span>)}
        <Show when={props.onAddText}>{(add) => button("Add Text", add(), <span class="toolbar-glyph serif">T</span>)}</Show>
        <div class="toolbar-marker hover-highlight" title="Add Marker (M)">
          <button type="button" class="toolbar-marker-flag" aria-label="Add Marker (M)" onClick={() => addTimelineMarkerAtSelection(editor, props.presentMarkerEditor)}>
            <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
              <path d="M0 0 H10 V7 L5 12 L0 7 Z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            class="toolbar-marker-menu"
            aria-label="Ripple Timeline Markers"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({
                x: r.left,
                y: r.bottom + 2,
                items: [
                  {
                    kind: "item",
                    label: "Ripple Timeline Markers",
                    checked: ui.rippleTimelineMarkers,
                    onSelect: () => (ui.rippleTimelineMarkers = !ui.rippleTimelineMarkers),
                  },
                ],
              });
            }}
          >
            <ChevronDown size={8} stroke-width={3} />
          </button>
        </div>
      </div>
      <div class="toolbar-spacer" />
      <div class="toolbar-zoom">
        {button("Zoom Out", () => setZoom(ui.zoomScale / Zoom.toolbarStepFactor), <ZoomOut size={12} />, { disabled: ui.zoomScale <= minZoom(), class: "zoom" })}
        <input
          type="range"
          class="toolbar-zoom-slider"
          min={Math.log(minZoom())}
          max={Math.log(Zoom.max)}
          step="any"
          value={Math.log(ui.zoomScale)}
          onInput={(e) => setZoom(Math.exp(Number(e.currentTarget.value)))}
          aria-label="Zoom"
        />
        {button("Zoom In", () => setZoom(ui.zoomScale * Zoom.toolbarStepFactor), <ZoomIn size={12} />, { disabled: ui.zoomScale >= Zoom.max, class: "zoom" })}
      </div>
      <Show when={menu()}>{(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(null)} />}</Show>
    </div>
  );
}
