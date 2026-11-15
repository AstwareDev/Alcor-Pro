import ChevronDown from "lucide-solid/icons/chevron-down";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { loadFontCatalog, type FontCatalog } from "./fonts";
import "./FontPickerField.css";

/**
 * Port of `FontPickerField`: font menu with live preview while a row is highlighted.
 * `onPreview` fires on highlight, `onChange` on pick, `onCancel` when the menu closes without a pick.
 */
export function FontPickerField(props: {
  /** undefined = mixed selection. */
  current: string | undefined;
  onPreview: (name: string) => void;
  onChange: (name: string) => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = createSignal<{ x: number; y: number } | null>(null);
  const [catalog, setCatalog] = createSignal<FontCatalog>({ featured: [], all: [] });
  const [highlight, setHighlight] = createSignal<string | undefined>(undefined);
  let picked = false;
  let lastPreviewed: string | undefined;
  let menu: HTMLDivElement | undefined;

  const names = (): string[] => [...catalog().featured, ...catalog().all];

  const close = (): void => {
    if (!open()) return;
    setOpen(null);
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    if (!picked) props.onCancel();
  };
  const onOutside = (e: PointerEvent): void => {
    if (!menu?.contains(e.target as Node)) close();
  };
  const preview = (name: string): void => {
    setHighlight(name);
    if (name === lastPreviewed) return;
    lastPreviewed = name;
    props.onPreview(name);
  };
  const pick = (name: string): void => {
    picked = true;
    props.onChange(name);
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const list = names();
      const i = highlight() === undefined ? -1 : list.indexOf(highlight() as string);
      const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next !== undefined) {
        preview(next);
        menu?.querySelector<HTMLElement>(`[data-font="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter") {
      const h = highlight();
      if (h !== undefined) {
        e.preventDefault();
        pick(h);
      }
    }
  };

  const present = (e: MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    picked = false;
    lastPreviewed = undefined;
    setHighlight(undefined);
    setOpen({ x: Math.max(4, r.right - 220), y: r.bottom + 2 });
    void loadFontCatalog().then(setCatalog);
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    queueMicrotask(() => menu?.querySelector<HTMLElement>(".font-item.current")?.scrollIntoView({ block: "center" }));
  };
  onCleanup(() => {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  });

  return (
    <>
      <button type="button" class="editor-value-field font-picker" onClick={present} aria-haspopup="listbox">
        <span class="font-picker-name">{props.current ?? "Mixed"}</span>
        <ChevronDown size={9} stroke-width={2.5} class="chev" />
      </button>
      <Show when={open()}>
        {(pos) => (
          <Portal>
            <div ref={menu} class="font-menu" role="listbox" style={{ left: `${pos().x}px`, top: `${pos().y}px` }}>
              <Show when={catalog().featured.length > 0}>
                <div class="font-heading">Featured</div>
                <For each={catalog().featured}>{(n) => <FontItem name={n} current={props.current} highlight={highlight()} onHover={preview} onPick={pick} />}</For>
                <div class="font-divider" />
                <div class="font-heading">All fonts</div>
              </Show>
              <For each={catalog().all}>{(n) => <FontItem name={n} current={props.current} highlight={highlight()} onHover={preview} onPick={pick} />}</For>
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}

function FontItem(props: {
  name: string;
  current: string | undefined;
  highlight: string | undefined;
  onHover: (n: string) => void;
  onPick: (n: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      class="font-item"
      classList={{ current: props.name === props.current, highlighted: props.name === props.highlight }}
      data-font={props.name}
      style={{ "font-family": `"${props.name.replace(/["\\]/g, "")}", var(--font-ui)` }}
      aria-selected={props.name === props.current}
      onMouseEnter={() => props.onHover(props.name)}
      onClick={() => props.onPick(props.name)}
    >
      <span class="font-check">{props.name === props.current ? "✓" : ""}</span>
      {props.name}
    </button>
  );
}
