import { createSignal, For, Show } from "solid-js";
import Ellipsis from "lucide-solid/icons/ellipsis";
import Plus from "lucide-solid/icons/plus";
import X from "lucide-solid/icons/x";
import type { Editor } from "../../editor/editor";
import { activateTimeline, createTimeline, deleteTimeline, duplicateTimeline, renameTimeline } from "../../editor/mutations/timelines";
import { ContextMenu, menuSections, type ContextMenuItem } from "../../ui/ContextMenu";
import { InlineRenameField } from "../../ui/InlineRenameField";
import { closeAllTimelineTabs, closeOtherTimelineTabs, closeTimelineTab, openAllTimelineTabs } from "./timelineTabs";

/** Port of TimelineTabBar: open timeline tabs, overflow menu and the new-timeline button. */
export function TimelineTabBar(props: { editor: Editor }) {
  const editor = props.editor;
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const tabs = () => editor.doc.openTimelineIds.flatMap((id) => editor.doc.timelines.filter((t) => t.id === id));
  const allCount = () => editor.doc.timelines.length;

  const item = (label: string, onSelect: () => void, disabled = false, destructive = false): ContextMenuItem => ({
    kind: "item",
    label,
    onSelect,
    disabled,
    destructive,
  });

  const openOverflow = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 2,
      items: [
        item("Show All Tabs", () => openAllTimelineTabs(editor), tabs().length >= allCount()),
        item("Close All Tabs", () => closeAllTimelineTabs(editor), tabs().length <= 1),
      ],
    });
  };

  const openTabMenu = (e: MouseEvent, id: string) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: menuSections(
        [item("Rename", () => setRenamingId(id)), item("Duplicate", () => void duplicateTimeline(editor, id))],
        [item("Close Tab", () => closeTimelineTab(editor, id), tabs().length <= 1), item("Close Other Tabs", () => closeOtherTimelineTabs(editor, id), tabs().length <= 1)],
        [item("Delete Timeline", () => deleteTimeline(editor, id), allCount() <= 1, true)],
      ),
    });
  };

  return (
    <div class="timeline-tab-bar">
      <button type="button" class="timeline-tab-overflow hover-highlight" title="More" onClick={openOverflow}>
        <Ellipsis size={13} />
      </button>
      <div class="timeline-tab-strip">
        <For each={tabs()}>
          {(tab) => {
            const active = () => tab.id === editor.doc.activeTimelineId;
            const canClose = () => tabs().length > 1 && renamingId() !== tab.id;
            return (
              <div
                class="timeline-tab"
                classList={{ active: active() }}
                role="tab"
                aria-selected={active()}
                onClick={() => activateTimeline(editor, tab.id)}
                onDblClick={() => setRenamingId(tab.id)}
                onContextMenu={(e) => openTabMenu(e, tab.id)}
              >
                <Show
                  when={renamingId() === tab.id}
                  fallback={<span class="timeline-tab-name">{tab.name}</span>}
                >
                  <span class="timeline-tab-rename">
                    <InlineRenameField
                      originalName={tab.name}
                      onCommit={(name) => {
                        renameTimeline(editor, tab.id, name);
                        setRenamingId(null);
                      }}
                      onCancel={() => setRenamingId(null)}
                    />
                  </span>
                </Show>
                <Show when={canClose()}>
                  <button
                    type="button"
                    class="timeline-tab-close"
                    title="Close Tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTimelineTab(editor, tab.id);
                    }}
                  >
                    <X size={10} />
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
        <button type="button" class="timeline-tab-add hover-highlight" title="New timeline" onClick={() => void createTimeline(editor)}>
          <Plus size={11} />
        </button>
      </div>
      <Show when={menu()}>{(m) => <ContextMenu x={m().x} y={m().y} items={m().items} onClose={() => setMenu(null)} />}</Show>
    </div>
  );
}
