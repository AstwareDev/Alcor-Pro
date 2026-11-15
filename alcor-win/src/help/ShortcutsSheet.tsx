import X from "lucide-solid/icons/x";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { isTextInputTarget } from "../timeline/view/shortcuts";
import { shortcutGroups } from "./shortcutsList";
import "./help.css";

const [open, setOpen] = createSignal(false);
export const shortcutsSheetOpen = open;
export const openShortcutsSheet = (): void => void setOpen(true);
const toggleShortcutsSheet = (): void => void setOpen((v) => !v);

/** Port of ShortcutsPane as a sheet; opened with `?` or from the title bar. Mount once. */
export function ShortcutsSheetHost() {
  onMount(() => {
    const key = (e: KeyboardEvent): void => {
      if (open() && e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      } else if (e.key === "?" && !e.ctrlKey && !e.altKey && !e.metaKey && !isTextInputTarget(e.target as HTMLElement | null)) {
        e.preventDefault();
        toggleShortcutsSheet();
      }
    };
    window.addEventListener("keydown", key, true);
    onCleanup(() => window.removeEventListener("keydown", key, true));
  });
  const groups = shortcutGroups();
  const half = Math.ceil(groups.length / 2);
  return (
    <Show when={open()}>
      <Portal>
        <div class="mcp-scrim shortcuts-scrim" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div class="mcp-dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
            <div class="mcp-header">
              <h2>Keyboard Shortcuts</h2>
              <button type="button" class="mcp-close" title="Close" aria-label="Close" onClick={() => setOpen(false)}>
                <X size={13} />
              </button>
            </div>
            <div class="shortcuts-body">
              <For each={[groups.slice(0, half), groups.slice(half)]}>
                {(column) => (
                  <div class="shortcuts-column">
                    <For each={column}>
                      {(group) => (
                        <section class="shortcuts-group">
                          <h3>{group.title}</h3>
                          <For each={group.rows}>
                            {(row) => (
                              <div class="shortcuts-row">
                                <kbd>{row.keys}</kbd>
                                <span>{row.label}</span>
                              </div>
                            )}
                          </For>
                        </section>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
