import Check from "lucide-solid/icons/check";
import "./Toggle.css";

/** Switch (`.toggleStyle(.switch)` mini) or checkbox (`.checkbox`). */
export function Toggle(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  kind?: "switch" | "checkbox";
  disabled?: boolean;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      role={props.kind === "checkbox" ? "checkbox" : "switch"}
      class={props.kind === "checkbox" ? "toggle-checkbox" : "toggle-switch"}
      classList={{ on: props.checked }}
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.title}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      {props.kind === "checkbox" ? props.checked && <Check size={10} stroke-width={3} /> : <span class="toggle-knob" />}
    </button>
  );
}
