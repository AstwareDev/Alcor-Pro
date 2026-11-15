import { createSignal, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import "./HoverTooltip.css";

/** Port of `hoverTooltip(_:)`: capsule label under the hovered control. */
export function HoverTooltip(props: { text: string; children: JSX.Element }) {
  const [anchor, setAnchor] = createSignal<{ x: number; y: number } | null>(null);
  const show = (e: MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchor({ x: r.left + r.width / 2, y: r.bottom + 4 });
  };
  return (
    <span class="hover-tooltip-host" onMouseEnter={show} onMouseLeave={() => setAnchor(null)} onPointerDown={() => setAnchor(null)}>
      {props.children}
      <Show when={anchor()}>
        {(a) => (
          <Portal>
            <span class="hover-tooltip" role="tooltip" style={{ left: `${a().x}px`, top: `${a().y}px` }}>
              {props.text}
            </span>
          </Portal>
        )}
      </Show>
    </span>
  );
}
