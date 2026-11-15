import { For, type JSX } from "solid-js";
import "./SegmentedControl.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label?: string;
  icon?: JSX.Element;
  title?: string;
}

/** Port of `Picker(.segmented)`. */
export function SegmentedControl<T extends string>(props: {
  options: readonly SegmentedOption<T>[];
  value: T | undefined;
  onChange: (v: T) => void;
  label?: string;
  small?: boolean;
}) {
  return (
    <div class="segmented" classList={{ small: props.small }} role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            role="radio"
            class="segment"
            classList={{ selected: props.value === o.value }}
            aria-checked={props.value === o.value}
            aria-label={o.title ?? o.label}
            title={o.title}
            onClick={() => props.onChange(o.value)}
          >
            {o.icon}
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}
