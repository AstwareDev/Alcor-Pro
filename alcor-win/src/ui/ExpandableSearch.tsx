import CircleX from "lucide-solid/icons/circle-x";
import Search from "lucide-solid/icons/search";
import { createSignal, Show } from "solid-js";
import "./ExpandableSearch.css";

/** Search icon that expands into a capsule field (PanelSearchField style). Esc or blur-while-empty collapses. */
export function ExpandableSearch(props: {
  value: string;
  onInput: (value: string) => void;
  placeholder: string;
  label: string;
  clearLabel?: string;
}) {
  const [expanded, setExpanded] = createSignal(false);
  let input: HTMLInputElement | undefined;

  const collapse = () => {
    props.onInput("");
    setExpanded(false);
  };

  return (
    <Show
      when={expanded()}
      fallback={
        <button
          type="button"
          class="search-icon-button hover-highlight"
          title={props.label}
          aria-label={props.label}
          onClick={() => {
            setExpanded(true);
            queueMicrotask(() => input?.focus());
          }}
        >
          <Search size={11} />
        </button>
      }
    >
      <div class="search-field">
        <Search size={11} class="search-field-icon" />
        <input
          ref={(el) => {
            input = el;
            queueMicrotask(() => el.focus());
          }}
          value={props.value}
          placeholder={props.placeholder}
          spellcheck={false}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") collapse();
          }}
          onBlur={() => {
            if (props.value === "") setExpanded(false);
          }}
        />
        <Show when={props.value !== ""}>
          <button
            type="button"
            class="search-field-clear"
            title={props.clearLabel ?? "Clear search"}
            aria-label={props.clearLabel ?? "Clear search"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={collapse}
          >
            <CircleX size={11} />
          </button>
        </Show>
      </div>
    </Show>
  );
}
