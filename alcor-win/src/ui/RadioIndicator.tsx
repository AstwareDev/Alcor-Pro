import "./RadioIndicator.css";

/** Port of `RadioIndicator`. */
export function RadioIndicator(props: { selected: boolean; size?: string }) {
  return (
    <span class="radio-indicator" classList={{ selected: props.selected }} style={{ width: props.size, height: props.size }}>
      {props.selected && <span class="radio-dot" />}
    </span>
  );
}
