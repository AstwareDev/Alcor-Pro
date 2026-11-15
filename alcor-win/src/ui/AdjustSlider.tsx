import { createSignal, onCleanup } from "solid-js";
import "./AdjustSlider.css";

/** Port of `AdjustSlider`: thin track (optional gradient), round thumb, double-click resets. Escape cancels a drag. */
export function AdjustSlider(props: {
  value: number;
  min: number;
  max: number;
  /** CSS background for the track (e.g. `var(--slider-temp)`); plain fill track when omitted. */
  gradient?: string;
  defaultValue?: number;
  onChanged: (v: number) => void;
  onCommit: (v: number) => void;
  onCancel?: () => void;
  label?: string;
}) {
  let root: HTMLDivElement | undefined;
  const [dragging, setDragging] = createSignal(false);
  let cancelled = false;

  const fraction = (): number => {
    const span = props.max - props.min;
    return span > 0 ? Math.min(1, Math.max(0, (props.value - props.min) / span)) : 0;
  };
  const valueAt = (clientX: number): number => {
    const r = (root as HTMLDivElement).getBoundingClientRect();
    const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
    return props.min + f * (props.max - props.min);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !dragging()) return;
    e.stopPropagation();
    cancelled = true;
    setDragging(false);
    props.onCancel?.();
    window.removeEventListener("keydown", onKey, true);
  };
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div
      ref={root}
      class="adjust-slider"
      role="slider"
      tabindex={0}
      aria-label={props.label}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      onPointerDown={(e) => {
        // The second press of a double-click only resets; it must not commit a value of its own.
        if (e.button !== 0 || e.detail >= 2) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        cancelled = false;
        setDragging(true);
        window.addEventListener("keydown", onKey, true);
        props.onChanged(valueAt(e.clientX));
      }}
      onPointerMove={(e) => {
        if (!dragging()) return;
        props.onChanged(valueAt(e.clientX));
      }}
      onPointerUp={(e) => {
        window.removeEventListener("keydown", onKey, true);
        if (cancelled || !dragging()) return;
        setDragging(false);
        props.onCommit(valueAt(e.clientX));
      }}
      onDblClick={() => props.onCommit(props.defaultValue ?? 0)}
    >
      <div
        class="adjust-slider-track"
        style={props.gradient ? { background: props.gradient } : undefined}
      >
        {props.gradient === undefined && <div class="adjust-slider-fill" style={{ width: `${fraction() * 100}%` }} />}
      </div>
      <div class="adjust-slider-thumb" style={{ left: `${fraction() * 100}%` }} />
    </div>
  );
}
