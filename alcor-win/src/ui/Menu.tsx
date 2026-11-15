import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import "./Menu.css";

export type MenuItem =
  | { kind: "item"; label: string; onSelect: () => void; destructive?: boolean; checked?: boolean }
  | { kind: "divider" };

export interface MenuAnchor {
  x: number;
  y: number;
}

/** Floating menu at a viewport position. Closes on selection, outside press, Esc, blur and scroll. */
export function Menu(props: { anchor: MenuAnchor; items: MenuItem[]; onClose: () => void }) {
  let root!: HTMLDivElement;
  const [pos, setPos] = createSignal<MenuAnchor>(props.anchor);

  onMount(() => {
    const r = root.getBoundingClientRect();
    setPos({
      x: Math.max(0, Math.min(props.anchor.x, window.innerWidth - r.width - 4)),
      y: Math.max(0, Math.min(props.anchor.y, window.innerHeight - r.height - 4)),
    });
    const down = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", props.onClose);
    window.addEventListener("resize", props.onClose);
    document.addEventListener("scroll", props.onClose, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", props.onClose);
      window.removeEventListener("resize", props.onClose);
      document.removeEventListener("scroll", props.onClose, true);
    });
  });

  return (
    <Portal>
      <div
        ref={root}
        class="menu"
        role="menu"
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <For each={props.items}>
          {(item): JSX.Element =>
            item.kind === "divider" ? (
              <div class="menu-divider" role="separator" />
            ) : (
              <button
                type="button"
                role="menuitem"
                class="menu-item"
                classList={{ destructive: item.destructive }}
                onClick={() => {
                  props.onClose();
                  item.onSelect();
                }}
              >
                <span class="menu-check">
                  <Show when={item.checked}>✓</Show>
                </span>
                {item.label}
              </button>
            )
          }
        </For>
      </div>
    </Portal>
  );
}
