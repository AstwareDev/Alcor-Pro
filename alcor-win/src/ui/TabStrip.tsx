import { createEffect, For, type JSX } from "solid-js";
import "./TabStrip.css";

/** Port of `TabStrip`: horizontally scrolling tab list that keeps the active tab centred. */
export function TabStrip<T extends { id: string }>(props: {
  items: readonly T[];
  activeId: string;
  tab: (item: T) => JSX.Element;
  trailing?: JSX.Element;
}) {
  let root: HTMLDivElement | undefined;
  createEffect(() => {
    const id = props.activeId;
    const el = root?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  });
  return (
    <div
      ref={root}
      class="tab-strip"
      onWheel={(e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
      }}
    >
      <For each={props.items}>{(item) => <div data-tab-id={item.id}>{props.tab(item)}</div>}</For>
      {props.trailing}
    </div>
  );
}
