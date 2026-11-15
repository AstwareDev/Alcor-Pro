import { createSignal, For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { rgbaFromHex, rgbaHexString, type RGBA, type TimelineMarker } from "../../model";
import type { Editor } from "../../editor/editor";
import { CapsuleButton } from "../../ui/CapsuleButton";
import { formatTimecode, parseTimecode } from "../../util/timeFormatting";
import { changeTimelineMarkers, deleteSelectedTimelineMarker } from "./timelineMarkerCommands";
import { markerPathPoints } from "./timelineMarkerGeometry";

const presetHex = ["#4094FF", "#40CCE6", "#40BF5C", "#F2C72E", "#FF8C26", "#E64040", "#F259A6", "#A666F2", "#8CBFFF", "#73E6B8", "#A6D936", "#C79E6B", "#D1D1D1"];
const presetColors = presetHex.flatMap((h) => {
  const c = rgbaFromHex(h);
  return c ? [c] : [];
});

const flagPath = (() => {
  const pts = markerPathPoints({ x: 2, y: 2, width: 10, height: 10 });
  return `M${pts.map((p) => `${p.x} ${p.y}`).join(" L")} Z`;
})();

/** Port of MarkerEditorPopover: time, duration, name, comments, colour; edits preview live and commit on Done. */
export function MarkerEditorPopover(props: { editor: Editor; marker: TimelineMarker; anchor: { x: number; y: number }; onDismiss: () => void }) {
  const editor = props.editor;
  const fps = editor.timeline.fps;
  const [draft, setDraft] = createSignal<TimelineMarker>(structuredClone(props.marker));
  let root!: HTMLDivElement;
  let comments!: HTMLTextAreaElement;

  const preview = (next: TimelineMarker) => {
    setDraft(next);
    editor.ui.timelineMarkerPreview = next;
  };
  const dismiss = () => {
    editor.ui.timelineMarkerPreview = null;
    props.onDismiss();
  };
  const apply = () => {
    try {
      changeTimelineMarkers(editor, { updates: [draft()], actionName: "Edit Marker" });
    } catch {
      editor.refuseWithToast("Couldn't change marker.");
      return;
    }
    dismiss();
  };

  onMount(() => {
    comments.focus();
    const down = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) dismiss();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
      } else if (e.key === "Enter" && e.ctrlKey) apply();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    });
  });

  const timeField = (key: "startFrame" | "durationFrames") => (
    <input
      class="marker-editor-field marker-editor-time"
      value={formatTimecode(draft()[key], fps)}
      onChange={(e) => {
        const frame = parseTimecode(e.currentTarget.value, fps);
        if (frame === undefined) e.currentTarget.value = formatTimecode(draft()[key], fps);
        else preview({ ...draft(), [key]: frame });
      }}
    />
  );
  const sameColor = (a: RGBA, b: RGBA) => rgbaHexString(a) === rgbaHexString(b);

  return (
    <Portal>
      <div ref={root} class="marker-editor" style={{ left: `${Math.max(4, props.anchor.x - 160)}px`, top: `${props.anchor.y}px` }}>
        <div class="marker-editor-grid">
          <span class="marker-editor-label">Time</span>
          {timeField("startFrame")}
          <span class="marker-editor-label">Duration</span>
          {timeField("durationFrames")}
          <span class="marker-editor-label">Name</span>
          <input
            class="marker-editor-field span3"
            placeholder="Marker name"
            value={draft().name}
            onInput={(e) => setDraft({ ...draft(), name: e.currentTarget.value })}
          />
          <span class="marker-editor-label">Comments</span>
          <textarea
            ref={comments}
            class="marker-editor-field marker-editor-comments span3"
            placeholder="Add a comment"
            value={draft().comment}
            onInput={(e) => setDraft({ ...draft(), comment: e.currentTarget.value })}
          />
          <span class="marker-editor-label">Color</span>
          <div class="marker-editor-colors span3">
            <For each={presetColors}>
              {(c) => (
                <button
                  type="button"
                  class="marker-editor-swatch"
                  classList={{ selected: sameColor(c, draft().color) }}
                  aria-label={rgbaHexString(c)}
                  onClick={() => preview({ ...draft(), color: { ...c } })}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                    <path d={flagPath} fill={`rgb(${c.r * 255} ${c.g * 255} ${c.b * 255})`} />
                  </svg>
                </button>
              )}
            </For>
          </div>
        </div>
        <div class="marker-editor-actions">
          <CapsuleButton
            onClick={() => {
              deleteSelectedTimelineMarker(editor);
              dismiss();
            }}
          >
            Remove Marker
          </CapsuleButton>
          <span class="toolbar-spacer" />
          <CapsuleButton variant="prominent" onClick={apply}>
            Done
          </CapsuleButton>
        </div>
      </div>
    </Portal>
  );
}
