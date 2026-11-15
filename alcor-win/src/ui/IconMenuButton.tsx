import { createSignal, Show, type JSX } from "solid-js";
import { Menu, type MenuItem } from "./Menu";
import "./IconMenuButton.css";

/** Borderless icon button that opens a menu below it (`toolbarMenuIcon`). `active` tints the icon with the accent. */
export function IconMenuButton(props: {
  icon: JSX.Element;
  title: string;
  items: () => MenuItem[];
  active?: boolean;
}) {
  const [anchor, setAnchor] = createSignal<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        class="icon-menu-button hover-highlight"
        classList={{ active: props.active }}
        title={props.title}
        aria-label={props.title}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: r.left, y: r.bottom + 2 });
        }}
      >
        {props.icon}
      </button>
      <Show when={anchor()}>
        {(a) => <Menu anchor={a()} items={props.items()} onClose={() => setAnchor(null)} />}
      </Show>
    </>
  );
}
