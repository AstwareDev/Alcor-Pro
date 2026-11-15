import Heart from "lucide-solid/icons/heart";
import LibraryIcon from "lucide-solid/icons/library";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { mediaDropEventName, type MediaDropDetail } from "../mediapanel/dragSession";
import type { MediaPanelExtraTab } from "../mediapanel/MediaPanelView";
import { ChipStrip } from "../ui/ChipStrip";
import { ExpandableSearch } from "../ui/ExpandableSearch";
import { builtinPresets, categoryOrder } from "./builtin";
import { applyLibraryPreset, titleIdsFromPayload } from "./libraryActions";
import { createLibraryController, type LibraryController, type LibraryItem } from "./libraryController";
import type { LibraryServices } from "./libraryServices";
import { tauriLibraryServices } from "./tauriLibraryServices";
import { DownloadsView } from "./DownloadsView";
import { PresetTile } from "./PresetTile";
import type { Preset, PresetKind } from "./presetFormat";
import { SoundsView } from "./SoundsView";
import "./library.css";

type SectionId = "filters" | "effects" | "text" | "titles" | "animations" | "sounds" | "downloads";

interface Section {
  id: SectionId;
  label: string;
  kind?: PresetKind;
}

const sections: readonly Section[] = [
  { id: "filters", label: "Filters", kind: "look" },
  { id: "effects", label: "Effects", kind: "effect" },
  { id: "text", label: "Text", kind: "textStyle" },
  { id: "titles", label: "Titles", kind: "title" },
  { id: "animations", label: "Animations", kind: "textAnimation" },
  { id: "sounds", label: "Sounds" },
  { id: "downloads", label: "Downloads" },
];

const builtinItems: readonly LibraryItem[] = builtinPresets.map((preset) => ({ preset }));

function matches(preset: Preset, query: string): boolean {
  if (query === "") return true;
  const haystack = `${preset.name} ${preset.category} ${preset.tags.join(" ")}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

/** Frame under a drop at `clientX`, from the timeline scroller; undefined when it cannot be resolved. */
function dropFrame(editor: Editor, clientX: number): number | undefined {
  const scroller = document.querySelector<HTMLElement>(".timeline-scroller");
  if (!scroller || !(editor.ui.zoomScale > 0)) return undefined;
  const x = clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft;
  return Math.max(0, Math.trunc(x / editor.ui.zoomScale));
}

export function LibraryTab(props: { editor: Editor; controller: LibraryController; onOpenSettings: () => void }) {
  const c = props.controller;
  const [section, setSection] = createSignal<SectionId>("filters");
  const [category, setCategory] = createSignal("all");
  const [query, setQuery] = createSignal("");
  const current = () => sections.find((s) => s.id === section()) as Section;

  onMount(() => {
    void c.reloadInstalled();
    // Titles are dragged with an `alcor-title://` line; the timeline ignores it, so the drop is handled here.
    const onDrop = (e: Event): void => {
      const detail = (e as CustomEvent<MediaDropDetail>).detail;
      if (!(e.target as HTMLElement | null)?.closest(".timeline-canvas-area")) return;
      for (const id of titleIdsFromPayload(detail.payload)) {
        const item = [...builtinItems, ...c.packItems()].find((i) => i.preset.id === id);
        if (item) applyLibraryPreset(props.editor, item.preset, { resolveResource: c.resolveResource }, dropFrame(props.editor, detail.clientX));
      }
    };
    document.addEventListener(mediaDropEventName, onDrop);
    onCleanup(() => document.removeEventListener(mediaDropEventName, onDrop));
  });

  const items = createMemo(() => {
    const kind = current().kind;
    return kind === undefined ? [] : [...builtinItems, ...c.packItems()].filter((i) => i.preset.kind === kind);
  });

  const categories = createMemo(() => {
    const kind = current().kind;
    if (kind === undefined) return [];
    const known = categoryOrder[kind];
    const extra = [...new Set(items().map((i) => i.preset.category))].filter((name) => !known.includes(name));
    return [...known, ...extra].filter((name) => items().some((i) => i.preset.category === name));
  });

  const visible = createMemo(() => {
    const q = query().trim().toLowerCase();
    const cat = category();
    return items().filter((i) => {
      if (cat === "favourites" ? !c.favourites().has(i.preset.id) : cat !== "all" && i.preset.category !== cat) return false;
      return matches(i.preset, q);
    });
  });

  const select = (id: string): void => {
    setSection(id as SectionId);
    setCategory("all");
  };

  const apply = (preset: Preset): void => {
    const result = applyLibraryPreset(props.editor, preset, { resolveResource: c.resolveResource });
    if (result.error) props.editor.refuseWithToast(result.message);
    else props.editor.showToast(result.message);
  };

  const showGrid = () => current().kind !== undefined;
  const categoryItems = createMemo(() => [
    { id: "all", label: "All" },
    { id: "favourites", label: "Favourites" },
    ...categories().map((name) => ({ id: name, label: name })),
  ]);

  return (
    <div class="lib-tab">
      <div class="lib-toolbar">
        <div class="lib-top">
          <ChipStrip items={sections} activeId={section()} onSelect={select} label="Library sections" />
          <Show when={showGrid()}>
            <ExpandableSearch value={query()} onInput={setQuery} placeholder="Search presets" label="Search presets" />
          </Show>
        </div>
        <Show when={showGrid()}>
          <ChipStrip
            size="small"
            items={categoryItems()}
            activeId={category()}
            onSelect={setCategory}
            label="Categories"
            icon={(item) => (item.id === "favourites" ? <Heart size={9} /> : undefined)}
          />
        </Show>
      </div>
      <div class="lib-body">
        <Show when={showGrid()}>
          <div class="lib-grid-scroll">
            <Show
              when={visible().length > 0}
              fallback={
                <div class="lib-empty">
                  {category() === "favourites" ? "Tap the heart on a preset to keep it here." : "No presets match."}
                </div>
              }
            >
              <div class="lib-grid">
                <For each={visible()}>
                  {(item) => <PresetTile item={item} editor={props.editor} controller={c} onApply={apply} />}
                </For>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={section() === "sounds"}>
          <SoundsView editor={props.editor} controller={c} onOpenSettings={props.onOpenSettings} />
        </Show>
        <Show when={section() === "downloads"}>
          <DownloadsView editor={props.editor} controller={c} />
        </Show>
      </div>
    </div>
  );
}

/** Media-panel rail entry for the Library; create it once per editor and pass it in `extraTabs`. */
export function libraryPanelTab(
  editor: Editor, onOpenSettings: () => void, services: LibraryServices = tauriLibraryServices,
): MediaPanelExtraTab {
  const controller = createLibraryController(services);
  return {
    id: "library",
    icon: <LibraryIcon size={14} />,
    label: "Library",
    render: () => <LibraryTab editor={editor} controller={controller} onOpenSettings={onOpenSettings} />,
  };
}
