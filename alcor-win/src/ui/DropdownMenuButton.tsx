import { createSignal, Show, type JSX } from "solid-js";
import { Menu, type MenuAnchor, type MenuItem } from "./Menu";

/** A button that opens the shared `Menu` below itself (SwiftUI `Menu` with a custom label). */
export function DropdownMenuButton(props: {
  items: () => MenuItem[];
  children: JSX.Element;
  disabled?: boolean;
  title?: string;
  class?: string;
}) {
  const [anchor, setAnchor] = createSignal<MenuAnchor | null>(null);
  return (
    <>
      <button
        type="button"
        class={props.class}
        style={{ display: "inline-flex", "max-width": "100%", "min-width": "0" }}
        disabled={props.disabled}
        title={props.title}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: r.left, y: r.bottom + 2 });
        }}
      >
        {props.children}
      </button>
      <Show when={anchor()}>{(a) => <Menu anchor={a()} items={props.items()} onClose={() => setAnchor(null)} />}</Show>
    </>
  );
}
