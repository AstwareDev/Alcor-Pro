import { For, Show, createSignal, onMount, type JSX } from "solid-js";
import "./Split.css";

export interface SplitPane {
  id: string;
  /** Pixel size, a function of the container extent, or "fill" for the single flexible pane. */
  initial: number | "fill" | ((total: number) => number);
  min: number;
  max?: number;
  hidden?: () => boolean;
  content: () => JSX.Element;
}

interface Props {
  vertical?: boolean;
  storageKey: string;
  panes: SplitPane[];
}

export function Split(props: Props) {
  let root!: HTMLDivElement;
  const [sizes, setSizes] = createSignal<Record<string, number>>({});
  const extent = () => (props.vertical ? root.clientHeight : root.clientWidth);
  const isFill = (p: SplitPane) => p.initial === "fill";
  const visible = (p: SplitPane) => !p.hidden?.();

  onMount(() => {
    const saved = localStorage.getItem(`split.${props.storageKey}`);
    const parsed: Record<string, number> = saved ? JSON.parse(saved) : {};
    const total = extent();
    const next: Record<string, number> = {};
    for (const p of props.panes) {
      if (p.initial === "fill") continue;
      const initial = typeof p.initial === "function" ? p.initial(total) : p.initial;
      next[p.id] = Math.max(p.min, parsed[p.id] ?? Math.round(initial));
    }
    setSizes(next);
  });

  function startDrag(index: number, e: PointerEvent) {
    const panes = props.panes.filter(visible);
    const before = panes[index];
    const after = panes[index + 1];
    const start = props.vertical ? e.clientY : e.clientX;
    // Start from on-screen sizes: flexbox may have shrunk panes below their stored size.
    const measured = (q: SplitPane) => {
      const el = root.querySelector<HTMLElement>(`:scope > [data-pane="${q.id}"]`);
      return el ? (props.vertical ? el.offsetHeight : el.offsetWidth) : (sizes()[q.id] ?? q.min);
    };
    const initial: Record<string, number> = { ...sizes() };
    for (const q of panes) if (!isFill(q)) initial[q.id] = measured(q);
    const fill = panes.find(isFill);
    const others = (p: SplitPane) =>
      panes.filter((q) => !isFill(q) && q !== p).reduce((sum, q) => sum + (initial[q.id] ?? 0), 0);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const delta = (props.vertical ? ev.clientY : ev.clientX) - start;
      const next = { ...initial };
      const grow = (p: SplitPane, d: number) => {
        const room = fill ? extent() - fill.min - others(p) : Infinity;
        next[p.id] = Math.max(p.min, Math.min(initial[p.id] + d, p.max ?? Infinity, room));
        return next[p.id] - initial[p.id];
      };
      if (!isFill(before) && !isFill(after)) {
        const applied = grow(before, delta);
        next[after.id] = Math.max(after.min, initial[after.id] - applied);
      } else if (!isFill(before)) grow(before, delta);
      else grow(after, -delta);
      setSizes(next);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      localStorage.setItem(`split.${props.storageKey}`, JSON.stringify(sizes()));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  const paneStyle = (p: SplitPane): JSX.CSSProperties => {
    if (isFill(p)) return { flex: "1 1 0", [props.vertical ? "min-height" : "min-width"]: `${p.min}px` };
    return { flex: `0 1 ${sizes()[p.id] ?? p.min}px`, [props.vertical ? "min-height" : "min-width"]: `${p.min}px` };
  };

  return (
    <div ref={root} class="split" classList={{ vertical: props.vertical }}>
      <For each={props.panes.filter(visible)}>
        {(pane, i) => (
          <>
            <Show when={i() > 0}>
              <div class="split-divider" onPointerDown={(e) => startDrag(i() - 1, e)} />
            </Show>
            <div class="split-pane" data-pane={pane.id} style={paneStyle(pane)}>
              {pane.content()}
            </div>
          </>
        )}
      </For>
    </div>
  );
}
