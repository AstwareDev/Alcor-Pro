import Circle from "lucide-solid/icons/circle";
import CircleCheck from "lucide-solid/icons/circle-check";
import Film from "lucide-solid/icons/film";
import FolderX from "lucide-solid/icons/folder-x";
import Plus from "lucide-solid/icons/plus";
import Trash from "lucide-solid/icons/trash";
import { createEffect, createSignal, Show } from "solid-js";
import { projectEntryName, type ProjectEntry } from "../project/projectRegistry";
import { InlineRenameField } from "../ui/InlineRenameField";
import { Menu, type MenuAnchor } from "../ui/Menu";
import { relativeStringForSwiftDate } from "./projectList";

/** Port of ProjectCard. */
export function ProjectCard(props: {
  entry: ProjectEntry;
  accessible: boolean;
  thumbnailSrc: string | undefined;
  isSelecting: boolean;
  isSelected: boolean;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  onRemove: (path: string) => void;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const [menu, setMenu] = createSignal<MenuAnchor | null>(null);
  const [renaming, setRenaming] = createSignal(false);
  const [thumbFailed, setThumbFailed] = createSignal(false);
  const [thumbLoaded, setThumbLoaded] = createSignal(false);
  createEffect(() => {
    void props.thumbnailSrc;
    void props.entry.lastOpenedDate;
    setThumbFailed(false);
    setThumbLoaded(false);
  });

  const name = () => projectEntryName(props.entry);
  const showThumb = () => props.thumbnailSrc !== undefined && !thumbFailed();

  const activate = () => {
    if (renaming()) return;
    if (props.isSelecting) props.onSelect();
    else if (props.accessible) props.onOpen(props.entry.path);
  };

  return (
    <div class="project-cell">
      <div
        class="project-card"
        classList={{ inaccessible: !props.accessible, selected: props.isSelected }}
        onClick={activate}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div class="card-art">
          <Show
            when={showThumb()}
            fallback={
              <span class="card-art-icon">
                <Film size={28} strokeWidth={1.25} />
              </span>
            }
          >
            <img
              class="card-thumb"
              classList={{ loaded: thumbLoaded() }}
              src={props.thumbnailSrc}
              alt=""
              draggable={false}
              onLoad={() => setThumbLoaded(true)}
              onError={() => setThumbFailed(true)}
            />
          </Show>
          <Show when={!props.accessible}>
            <div class="card-missing">
              <FolderX size={22} />
              <span>File missing</span>
            </div>
          </Show>
        </div>

        <div class="card-gradient" />
        <div class="card-label">
          <Show when={renaming()} fallback={<div class="card-name">{name()}</div>}>
            <div class="card-name">
              <InlineRenameField
                originalName={name()}
                onCommit={(n) => {
                  setRenaming(false);
                  props.onRename(n);
                }}
                onCancel={() => setRenaming(false)}
              />
            </div>
          </Show>
          <div class="card-date">{relativeStringForSwiftDate(props.entry.createdDate)}</div>
        </div>

        <Show
          when={!props.isSelecting}
          fallback={
            <span class="card-select-indicator" classList={{ on: props.isSelected }}>
              <Show when={props.isSelected} fallback={<Circle size={18} strokeWidth={2.25} />}>
                <CircleCheck size={18} strokeWidth={2.25} />
              </Show>
            </span>
          }
        >
          <button
            type="button"
            class="card-delete"
            title="Delete Project"
            aria-label="Delete Project"
            onClick={(e) => {
              e.stopPropagation();
              props.onDelete();
            }}
          >
            <Trash size={12} strokeWidth={2.5} fill="currentColor" />
          </button>
        </Show>
      </div>

      <Show when={menu()}>
        {(anchor) => (
          <Menu
            anchor={anchor()}
            onClose={() => setMenu(null)}
            items={[
              ...(props.accessible
                ? [
                    { kind: "item" as const, label: "Open", onSelect: () => props.onOpen(props.entry.path) },
                    { kind: "item" as const, label: "Show in Explorer", onSelect: () => props.onReveal(props.entry.path) },
                    { kind: "item" as const, label: "Rename", onSelect: () => setRenaming(true) },
                    { kind: "divider" as const },
                  ]
                : []),
              { kind: "item", label: "Remove from Recents", onSelect: () => props.onRemove(props.entry.path) },
              { kind: "item", label: "Delete Project", destructive: true, onSelect: props.onDelete },
            ]}
          />
        )}
      </Show>
    </div>
  );
}

/** The empty-registry placeholder card. */
export function NewProjectCard(props: { onClick: () => void }) {
  return (
    <div class="project-cell">
      <div class="project-card" onClick={() => props.onClick()}>
        <div class="card-art">
          <span class="card-art-icon">
            <Plus size={28} strokeWidth={1.25} />
          </span>
        </div>
        <div class="card-gradient" />
        <div class="card-label">
          <div class="card-name">Untitled</div>
        </div>
      </div>
    </div>
  );
}
