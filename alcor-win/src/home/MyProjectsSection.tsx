import ArrowUpDown from "lucide-solid/icons/arrow-up-down";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { dirname, joinPath, pathKey } from "../project/projectPaths";
import { Project } from "../model";
import { projectErrors } from "../project/projectError";
import { projectEntryName, type ProjectEntry } from "../project/projectRegistry";
import { validateProjectName } from "../project/projectSession";
import { CapsuleButton } from "../ui/CapsuleButton";
import { ExpandableSearch } from "../ui/ExpandableSearch";
import { Menu, type MenuAnchor } from "../ui/Menu";
import type { DialogHost } from "./dialogs";
import type { HomeServices } from "./homeServices";
import { filterProjects, projectSortLabels, type ProjectSort } from "./projectList";
import { NewProjectCard, ProjectCard } from "./ProjectCard";

const sortOrder: ProjectSort[] = ["lastOpened", "created", "name"];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Port of MyProjectsSection: toolbar (title, search, sort, select) and the project grid. */
export function MyProjectsSection(props: {
  services: HomeServices;
  dialogs: DialogHost;
  onOpenProject: (path: string) => void;
  onNewProject: () => void;
}) {
  const registry = () => props.services.registry;
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<ProjectSort>("lastOpened");
  const [sortMenu, setSortMenu] = createSignal<MenuAnchor | null>(null);
  const [isSelecting, setSelecting] = createSignal(false);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());

  // Files can vanish while the window is idle; re-check when it regains focus.
  const [focusTick, setFocusTick] = createSignal(0);
  onMount(() => {
    const bump = () => setFocusTick((n) => n + 1);
    window.addEventListener("focus", bump);
    onCleanup(() => window.removeEventListener("focus", bump));
  });

  const [inaccessible] = createResource(
    () => ({ entries: registry().entries(), tick: focusTick() }),
    async ({ entries }) => {
      const checks = await Promise.all(entries.map(async (e) => [e.id, await registry().isAccessible(e)] as const));
      return new Set(checks.filter(([, ok]) => !ok).map(([id]) => id));
    },
  );
  const isAccessible = (e: ProjectEntry) => !(inaccessible.latest?.has(e.id) ?? false);

  const visible = createMemo(() => filterProjects(registry().entries(), query(), sort()));

  const endSelection = () => {
    setSelecting(false);
    setSelected(new Set<string>());
  };
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Drop selections for entries that no longer exist.
  createEffect(() => {
    const ids = new Set(registry().entries().map((e) => e.id));
    setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
    if (ids.size === 0) setSelecting(false);
  });

  const requestDeletion = async (entries: ProjectEntry[]) => {
    const open = entries.filter((e) => props.services.isOpen(e.path));
    if (open.length > 0) {
      props.dialogs.alert("Projects Couldn’t Be Deleted", projectErrors.openProjects(open.map(projectEntryName)).message);
      return;
    }
    const single = entries.length === 1;
    const confirmed = await props.dialogs.confirm({
      title: single ? "Delete Project?" : "Delete Selected Projects?",
      message: single
        ? "The project and its media will be permanently deleted. This can’t be undone."
        : "The selected projects and their media will be permanently deleted. This can’t be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const result = await registry().delete(entries);
      setSelected((prev) => new Set([...prev].filter((id) => !result.deletedIds.has(id))));
      if (result.failedNames.length === 0) endSelection();
      else props.dialogs.alert("Projects Couldn’t Be Deleted", `Couldn’t delete ${result.failedNames.join(", ")}.`);
    } catch (error) {
      props.dialogs.alert("Projects Couldn’t Be Deleted", errorText(error));
    }
  };

  const rename = async (entry: ProjectEntry, name: string) => {
    try {
      validateProjectName(name);
      if (props.services.isOpen(entry.path)) {
        props.dialogs.alert("Project Couldn’t Be Renamed", `Close ${projectEntryName(entry)} before renaming.`);
        return;
      }
      const target = joinPath(dirname(entry.path), `${name}.${Project.fileExtension}`);
      if (pathKey(target) !== pathKey(entry.path) && (await registry().isAccessible({ ...entry, path: target }))) {
        throw projectErrors.nameTaken(name);
      }
      await registry().rename(entry, target);
    } catch (error) {
      props.dialogs.alert("Project Couldn’t Be Renamed", errorText(error));
    }
  };

  const reveal = (path: string) =>
    props.services.revealInExplorer(path).catch((error) => props.dialogs.alert("Couldn’t Show in Explorer", errorText(error)));

  const remove = (path: string) =>
    registry().remove(path).catch((error) => props.dialogs.alert("Couldn’t Remove Project", errorText(error)));

  return (
    <section class="my-projects">
      <div class="projects-toolbar">
        <span class="projects-title">My Projects</span>
        <span class="spacer" />
        <ExpandableSearch
          value={query()}
          onInput={setQuery}
          placeholder="Search projects"
          label="Search projects"
        />
        <Show when={registry().entries().length > 0}>
          <button
            type="button"
            class="search-icon-button hover-highlight"
            title="Sort projects"
            aria-label="Sort projects"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setSortMenu({ x: r.left, y: r.bottom + 4 });
            }}
          >
            <ArrowUpDown size={11} />
          </button>
        </Show>
        <Show
          when={isSelecting()}
          fallback={
            <Show when={registry().entries().length > 0}>
              <CapsuleButton onClick={() => setSelecting(true)}>Select</CapsuleButton>
            </Show>
          }
        >
          <CapsuleButton
            fill="var(--status-error)"
            disabled={selected().size === 0}
            onClick={() => requestDeletion(registry().entries().filter((e) => selected().has(e.id)))}
          >
            Delete {selected().size}
          </CapsuleButton>
          <CapsuleButton onClick={endSelection}>Done</CapsuleButton>
        </Show>
      </div>

      <div class="projects-scroll">
        <div class="projects-grid">
          <Show
            when={registry().entries().length > 0}
            fallback={<NewProjectCard onClick={props.onNewProject} />}
          >
            <Show when={visible().length > 0} fallback={<div class="projects-empty">No projects found</div>}>
              <For each={visible()}>
                {(entry) => (
                  <ProjectCard
                    entry={entry}
                    accessible={isAccessible(entry)}
                    thumbnailSrc={props.services.thumbnailSrc(entry.path)}
                    isSelecting={isSelecting()}
                    isSelected={selected().has(entry.id)}
                    onOpen={props.onOpenProject}
                    onReveal={reveal}
                    onRemove={remove}
                    onSelect={() => toggle(entry.id)}
                    onDelete={() => requestDeletion([entry])}
                    onRename={(name) => rename(entry, name)}
                  />
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={sortMenu()}>
        {(anchor) => (
          <Menu
            anchor={anchor()}
            onClose={() => setSortMenu(null)}
            items={sortOrder.map((s) => ({
              kind: "item" as const,
              label: projectSortLabels[s],
              checked: sort() === s,
              onSelect: () => setSort(s),
            }))}
          />
        )}
      </Show>
    </section>
  );
}
