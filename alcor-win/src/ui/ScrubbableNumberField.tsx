import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  arrowStep,
  clampToRange,
  committedValue,
  formatFixed,
  scrubbedValue,
  scrubThreshold,
  type NumberRange,
} from "./numberField";
import "./ScrubbableNumberField.css";

export interface ScrubbableNumberFieldProps {
  /** undefined renders the mixed state ("—"). */
  value: number | undefined;
  range: NumberRange;
  displayMultiplier?: number;
  format?: string;
  valueSuffix?: string;
  /** Display units changed per pixel of horizontal drag. */
  dragSensitivity?: number;
  /** CSS width of the value box. */
  fieldWidth?: string;
  valueFontSize?: string;
  dragValueAdjustment?: (v: number) => number;
  trailingLabel?: string;
  trailingLabelFontSize?: string;
  displayTextOverride?: (v: number) => string | undefined;
  parseTextOverride?: (text: string) => number | undefined;
  onDraggingValue?: (v: number) => void;
  /** Live value during drag (apply without undo). */
  onChanged?: (v: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  /** Escape during a drag: the caller reverts its live edits. */
  onCancel?: () => void;
  onCommit: (v: number) => void;
  disabled?: boolean;
  label?: string;
}

/** Port of `ScrubbableNumberField`: drag to scrub, click to type, arrow keys to step. */
export function ScrubbableNumberField(props: ScrubbableNumberFieldProps) {
  const [isEditing, setEditing] = createSignal(false);
  const [editText, setEditText] = createSignal("");
  const [isDragging, setDragging] = createSignal(false);
  const [liveValue, setLiveValue] = createSignal(props.value ?? props.range.min);
  let interactionActive = false;
  let dragStartValue = 0;
  let pressX = 0;
  let pressed = false;
  let cancelled = false;
  let editCancelled = false;
  let input: HTMLInputElement | undefined;

  const mult = (): number => props.displayMultiplier ?? 1;
  const format = (): string => props.format ?? "%.0f";
  const suffix = (): string => props.valueSuffix ?? "";
  const sensitivity = (): number => props.dragSensitivity ?? 1;
  const isMixed = (): boolean => props.value === undefined && !isDragging();
  const sourceValue = (): number => (isDragging() ? liveValue() : (props.value ?? liveValue()));
  const displayText = (): string => {
    if (isMixed()) return "—";
    const override = props.displayTextOverride?.(sourceValue());
    if (override !== undefined) return override;
    return formatFixed(format(), sourceValue() * mult()) + suffix();
  };
  const editingText = (): string => {
    if (isMixed()) return "";
    return props.displayTextOverride?.(sourceValue()) ?? formatFixed(format(), sourceValue() * mult());
  };

  createEffect(() => {
    const v = props.value;
    if (!isDragging() && v !== undefined) setLiveValue(v);
  });

  const beginInteraction = (): void => {
    if (interactionActive) return;
    interactionActive = true;
    props.onInteractionStart?.();
  };
  const endInteraction = (): void => {
    if (!interactionActive) return;
    interactionActive = false;
    props.onInteractionEnd?.();
  };

  const modifiers = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => ({
    shift: e.shiftKey,
    fine: e.ctrlKey || e.metaKey,
  });

  const onEscapeWhileDragging = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !isDragging()) return;
    e.preventDefault();
    e.stopPropagation();
    cancelled = true;
    setLiveValue(dragStartValue);
    setDragging(false);
    props.onCancel?.();
    endInteraction();
    window.removeEventListener("keydown", onEscapeWhileDragging, true);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (props.disabled || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pressX = e.clientX;
    pressed = true;
    cancelled = false;
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!pressed || cancelled || isMixed()) return;
    const dx = e.clientX - pressX;
    if (!isDragging() && Math.abs(dx) > scrubThreshold) {
      beginInteraction();
      dragStartValue = props.value ?? liveValue();
      setDragging(true);
      window.addEventListener("keydown", onEscapeWhileDragging, true);
    }
    if (!isDragging()) return;
    const next = scrubbedValue(dragStartValue, dx, sensitivity(), mult(), props.range, modifiers(e), props.dragValueAdjustment);
    props.onDraggingValue?.(next);
    if (next !== liveValue()) {
      setLiveValue(next);
      props.onChanged?.(next);
    }
  };

  const onPointerUp = (): void => {
    if (!pressed) return;
    pressed = false;
    window.removeEventListener("keydown", onEscapeWhileDragging, true);
    if (cancelled) return;
    if (isDragging()) {
      props.onCommit(liveValue());
      setDragging(false);
      endInteraction();
    } else {
      beginInteraction();
      setEditText(editingText());
      editCancelled = false;
      setEditing(true);
      queueMicrotask(() => {
        input?.focus();
        input?.select();
      });
    }
  };

  const finishEdit = (): void => {
    if (!isEditing()) return;
    setEditing(false);
    if (!editCancelled) {
      const parsed = props.parseTextOverride?.(editText()) ?? committedValue(editText(), suffix(), mult(), props.range);
      if (parsed !== undefined) {
        const next = clampToRange(parsed, props.range);
        setLiveValue(next);
        props.onCommit(next);
      }
    }
    endInteraction();
  };

  const stepBy = (direction: 1 | -1, e: KeyboardEvent): void => {
    const step = arrowStep(sensitivity(), mult(), modifiers(e));
    const base = isMixed() ? props.range.min : sourceValue();
    const next = clampToRange(props.dragValueAdjustment ? props.dragValueAdjustment(base + direction * step) : base + direction * step, props.range);
    beginInteraction();
    setLiveValue(next);
    props.onCommit(next);
    endInteraction();
  };

  const onRootKeyDown = (e: KeyboardEvent): void => {
    if (isEditing() || props.disabled) return;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      stepBy(1, e);
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      stepBy(-1, e);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      beginInteraction();
      setEditText(editingText());
      editCancelled = false;
      setEditing(true);
      queueMicrotask(() => {
        input?.focus();
        input?.select();
      });
    }
  };

  const onInputKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      input?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editCancelled = true;
      input?.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const parsed = committedValue(editText(), suffix(), mult(), props.range) ?? sourceValue();
      const step = arrowStep(sensitivity(), mult(), modifiers(e)) * (e.key === "ArrowUp" ? 1 : -1);
      const next = clampToRange(parsed + step, props.range);
      setEditText(props.displayTextOverride?.(next) ?? formatFixed(format(), next * mult()));
    }
  };

  onCleanup(() => {
    window.removeEventListener("keydown", onEscapeWhileDragging, true);
    if (isDragging()) {
      props.onCommit(liveValue());
      setDragging(false);
    }
    endInteraction();
  });

  return (
    <div
      class="scrub-field"
      tabindex={props.disabled ? -1 : 0}
      role="spinbutton"
      aria-label={props.label ?? props.trailingLabel}
      aria-valuenow={isMixed() ? undefined : sourceValue() * mult()}
      onKeyDown={onRootKeyDown}
    >
      <Show when={props.trailingLabel}>
        <span class="scrub-trailing-label" style={{ "font-size": props.trailingLabelFontSize }}>
          {props.trailingLabel}
        </span>
      </Show>
      <div
        class="editor-value-field scrub-box"
        classList={{ active: isEditing() || isDragging(), disabled: props.disabled, scrubbing: isDragging() }}
        style={{ width: props.fieldWidth ? `calc(${props.fieldWidth} + 2 * var(--sp-sm))` : undefined }}
      >
        <Show
          when={isEditing()}
          fallback={
            <span class="scrub-value" classList={{ mixed: isMixed() }} style={{ "font-size": props.valueFontSize }}>
              {displayText()}
            </span>
          }
        >
          <input
            ref={input}
            class="scrub-input"
            style={{ "font-size": props.valueFontSize }}
            value={editText()}
            onInput={(e) => setEditText(e.currentTarget.value)}
            onKeyDown={onInputKeyDown}
            onBlur={finishEdit}
            spellcheck={false}
          />
        </Show>
        <Show when={!isEditing()}>
          <div
            class="scrub-surface"
            classList={{ "can-scrub": !isMixed() }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              pressed = false;
              if (isDragging()) {
                props.onCommit(liveValue());
                setDragging(false);
                endInteraction();
              }
            }}
          />
        </Show>
      </div>
    </div>
  );
}
