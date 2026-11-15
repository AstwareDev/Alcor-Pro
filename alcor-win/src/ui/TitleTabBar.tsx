import { For, type JSX } from "solid-js";
import "./TitleTabBar.css";

export interface TitleTabItem {
  id: string;
  title: string;
  icon: JSX.Element;
}

/** Port of `TitleTabBar`: full-width icon + caption tabs with an underline on the active one. */
export function TitleTabBar(props: { items: readonly TitleTabItem[]; selected: string | undefined; onSelect: (id: string) => void }) {
  return (
    <div class="title-tab-bar panel-header" role="tablist">
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="tab"
            class="title-tab"
            classList={{ active: props.selected === item.id }}
            aria-selected={props.selected === item.id}
            aria-label={item.title}
            onClick={() => props.onSelect(item.id)}
          >
            <span class="title-tab-icon">{item.icon}</span>
            <span class="title-tab-label">{item.title}</span>
          </button>
        )}
      </For>
    </div>
  );
}
