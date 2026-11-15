import type { JSX } from "solid-js";
import "./SidebarRowButton.css";

/** Port of `SidebarRowButton`: icon + label capsule row. */
export function SidebarRowButton(props: {
  label: string;
  icon: JSX.Element;
  title?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class="sidebar-row hover-highlight"
      classList={{ selected: props.selected }}
      title={props.title}
      onClick={() => props.onClick()}
    >
      <span class="sidebar-row-icon">{props.icon}</span>
      <span class="sidebar-row-label">{props.label}</span>
    </button>
  );
}
