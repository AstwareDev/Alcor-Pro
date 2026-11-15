import AudioLines from "lucide-solid/icons/audio-lines";
import Clock from "lucide-solid/icons/clock";
import Image from "lucide-solid/icons/image";
import Sparkles from "lucide-solid/icons/sparkles";
import Undo2 from "lucide-solid/icons/undo-2";
import Video from "lucide-solid/icons/video";
import { createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import type { Editor } from "./editor";
import { projectActivityEntries, relativeTime, type ProjectActivityEntry } from "./activityEntries";

function entryIcon(e: ProjectActivityEntry): JSX.Element {
  if (e.kind === "refund") return <Undo2 size={12} />;
  switch (e.type) {
    case "video": return <Video size={12} />;
    case "image": return <Image size={12} />;
    case "audio": return <AudioLines size={12} />;
    default: return <Sparkles size={12} />;
  }
}

/** Port of ProjectActivityButton / ProjectActivityView: popover listing the project's recent generations. */
export function ProjectActivityButton(props: { editor: Editor }) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  const entries = createMemo(() => (open() ? projectActivityEntries(props.editor.mediaAssets) : []));

  const onPointerDown = (e: PointerEvent): void => {
    if (root && !root.contains(e.target as Node)) setOpen(false);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") setOpen(false);
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKey);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKey);
  });

  return (
    <div class="activity-anchor" ref={root}>
      <button
        class="titlebar-icon hover-highlight"
        classList={{ on: open() }}
        title="Project Activity"
        aria-label="Project Activity"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <Clock size={15} />
      </button>
      <Show when={open()}>
        <div class="activity-popover" role="dialog" aria-label="Project Activity">
          <div class="activity-head">Project Activity</div>
          <Show when={entries().length > 0} fallback={<div class="activity-empty">No generations yet</div>}>
            <div class="activity-list">
              <For each={entries()}>
                {(e) => (
                  <div class="activity-row" classList={{ failed: e.kind === "failed", refund: e.kind === "refund" }}>
                    <span class="activity-icon">{entryIcon(e)}</span>
                    <span class="activity-cost">{e.kind === "failed" ? "Failed" : e.kind === "inProgress" ? "Generating" : e.cost}</span>
                    <span class="activity-model" title={e.model}>{e.model}</span>
                    <span class="activity-when">{relativeTime(e.at, Date.now())}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
