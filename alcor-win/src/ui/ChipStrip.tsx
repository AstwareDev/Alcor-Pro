import { createEffect, For, type JSX } from "solid-js";
import "./ChipStrip.css";

/** Horizontally scrolling single-select chips (category filters). Wheel scrolls sideways. */
export function ChipStrip<T extends { id: string; label: string }>(props: {
  items: readonly T[];
  activeId: string;
  onSelect: (id: string) => void;
  label: string;
  size?: "regular" | "small";
  icon?: (item: T) => JSX.Element;
}) {
  let root: HTMLDivElement | undefined;
  createEffect(() => {
    const id = props.activeId;
    root?.querySelector<HTMLElement>(`[data-chip-id="${CSS.escape(id)}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  });
  return (
    <div
      ref={root}
      class="chip-strip"
      classList={{ small: props.size === "small" }}
      role="tablist"
      aria-label={props.label}
      onWheel={(e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
      }}
    >
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="tab"
            data-chip-id={item.id}
            class="chip hover-highlight"
            classList={{ active: props.activeId === item.id }}
            aria-selected={props.activeId === item.id}
            onClick={() => props.onSelect(item.id)}
          >
            {props.icon?.(item)}
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
}
