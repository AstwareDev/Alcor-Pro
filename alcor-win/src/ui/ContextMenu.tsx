import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import "./Menu.css";
import "./ContextMenu.css";

export type ContextMenuItem =
  | {
      kind: "item";
      label: string;
      onSelect?: () => void;
      disabled?: boolean;
      checked?: boolean;
      destructive?: boolean;
      /** Shown as the native tooltip (Swift `toolTip`, e.g. a refusal reason). */
      tooltip?: string;
      submenu?: ContextMenuItem[];
    }
  | { kind: "divider" };

/** Joins groups with dividers, skipping empty groups (NSMenu sections). */
export function menuSections(...groups: ContextMenuItem[][]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (out.length > 0) out.push({ kind: "divider" });
    out.push(...group);
  }
  return out;
}

function MenuList(props: { items: ContextMenuItem[]; x: number; y: number; onClose: () => void; root?: (el: HTMLDivElement) => void }) {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: props.x, y: props.y });
  const [openIndex, setOpenIndex] = createSignal<number | null>(null);
  onMount(() => {
    props.root?.(el);
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(0, Math.min(props.x, window.innerWidth - r.width - 4)),
      y: Math.max(0, Math.min(props.y, window.innerHeight - r.height - 4)),
    });
  });
  return (
    <div ref={el} class="menu context-menu" role="menu" style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onContextMenu={(e) => e.preventDefault()}>
      <For each={props.items}>
        {(item, index): JSX.Element => {
          if (item.kind === "divider") return <div class="menu-divider" role="separator" />;
          let row!: HTMLButtonElement;
          return (
            <>
              <button
                ref={row}
                type="button"
                role="menuitem"
                class="menu-item"
                classList={{ destructive: item.destructive, disabled: item.disabled, "has-submenu": !!item.submenu }}
                title={item.tooltip}
                aria-disabled={item.disabled}
                onPointerEnter={() => setOpenIndex(item.submenu ? index() : null)}
                onClick={() => {
                  if (item.disabled || item.submenu) return;
                  props.onClose();
                  item.onSelect?.();
                }}
              >
                <span class="menu-check">
                  <Show when={item.checked}>✓</Show>
                </span>
                <span class="context-menu-label">{item.label}</span>
                <Show when={item.submenu}>
                  <span class="context-menu-chevron">›</span>
                </Show>
              </button>
              <Show when={item.submenu && openIndex() === index()}>
                {(() => {
                  const r = row.getBoundingClientRect();
                  return <MenuList items={item.submenu ?? []} x={r.right} y={r.top - 4} onClose={props.onClose} />;
                })()}
              </Show>
            </>
          );
        }}
      </For>
    </div>
  );
}

/** Context menu at a viewport position, with disabled items, check marks, tooltips and submenus. */
export function ContextMenu(props: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  onMount(() => {
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest(".context-menu")) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", props.onClose);
    window.addEventListener("resize", props.onClose);
    onCleanup(() => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", props.onClose);
      window.removeEventListener("resize", props.onClose);
    });
  });
  return (
    <Portal>
      <MenuList items={props.items} x={props.x} y={props.y} onClose={props.onClose} />
    </Portal>
  );
}
