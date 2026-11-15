import { createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { makeRGBA, type RGBA } from "../model";
import { hexText, hsvToRgb, parseHexInput, rgbToHsv, rgbaCss, type HSV } from "./color";
import "./ColorField.css";

/** Swatch + popover picker (saturation/value square, hue, optional alpha, hex). `onChange` fires continuously. */
export function ColorField(props: {
  color: RGBA;
  onChange: (c: RGBA) => void;
  supportsOpacity?: boolean;
  label?: string;
}) {
  const withAlpha = (): boolean => props.supportsOpacity ?? true;
  const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
  const [hsv, setHsv] = createSignal<HSV>({ h: 0, s: 0, v: 0 });
  const [alpha, setAlpha] = createSignal(1);
  const [hexDraft, setHexDraft] = createSignal<string | null>(null);
  let panel: HTMLDivElement | undefined;

  const emit = (h: HSV, a: number): void => {
    setHsv(h);
    setAlpha(a);
    setHexDraft(null);
    props.onChange(hsvToRgb(h, withAlpha() ? a : props.color.a));
  };
  const close = (): void => {
    setPos(null);
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onOutside = (e: PointerEvent): void => {
    if (!panel?.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  onCleanup(close);

  const open = (e: MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setHsv(rgbToHsv(props.color));
    setAlpha(props.color.a);
    setHexDraft(null);
    setPos({ x: Math.max(4, Math.min(r.right - 208, window.innerWidth - 216)), y: r.bottom + 4 });
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  };

  const drag = (set: (e: PointerEvent, rect: DOMRect) => void) => (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    set(e, el.getBoundingClientRect());
    const move = (m: PointerEvent): void => set(m, el.getBoundingClientRect());
    const up = (): void => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const frac = (v: number, a: number, b: number): number => Math.min(1, Math.max(0, (v - a) / b));

  return (
    <>
      <button
        type="button"
        class="color-swatch"
        aria-label={props.label ?? "Choose color"}
        title={props.label ?? "Choose color"}
        onClick={open}
      >
        <span class="color-swatch-fill" style={{ background: rgbaCss(props.color) }} />
      </button>
      <Show when={pos()}>
        {(p) => (
          <Portal>
            <div ref={panel} class="color-popover" style={{ left: `${p().x}px`, top: `${p().y}px` }}>
              <div
                class="color-sv"
                style={{ background: `linear-gradient(transparent, #000), linear-gradient(90deg, #fff, ${rgbaCss(hsvToRgb({ h: hsv().h, s: 1, v: 1 }))})` }}
                onPointerDown={drag((e, r) =>
                  emit({ h: hsv().h, s: frac(e.clientX, r.left, r.width), v: 1 - frac(e.clientY, r.top, r.height) }, alpha()),
                )}
              >
                <span class="color-handle" style={{ left: `${hsv().s * 100}%`, top: `${(1 - hsv().v) * 100}%` }} />
              </div>
              <div
                class="color-bar color-hue"
                onPointerDown={drag((e, r) => emit({ ...hsv(), h: Math.min(0.9999, frac(e.clientX, r.left, r.width)) }, alpha()))}
              >
                <span class="color-handle" style={{ left: `${hsv().h * 100}%`, top: "50%" }} />
              </div>
              <Show when={withAlpha()}>
                <div class="color-bar color-alpha">
                  <div
                    class="color-alpha-fill"
                    style={{ background: `linear-gradient(90deg, transparent, ${rgbaCss(hsvToRgb(hsv(), 1))})` }}
                    onPointerDown={drag((e, r) => emit(hsv(), frac(e.clientX, r.left, r.width)))}
                  >
                    <span class="color-handle" style={{ left: `${alpha() * 100}%`, top: "50%" }} />
                  </div>
                </div>
              </Show>
              <input
                class="color-hex editor-value-field"
                aria-label="Hex color"
                spellcheck={false}
                value={hexDraft() ?? hexText(hsvToRgb(hsv(), alpha()), withAlpha())}
                onInput={(e) => {
                  setHexDraft(e.currentTarget.value);
                  const parsed = parseHexInput(e.currentTarget.value, makeRGBA({ ...props.color, a: alpha() }), withAlpha());
                  if (parsed) {
                    const next = rgbToHsv(parsed);
                    setHsv({ h: next.s === 0 ? hsv().h : next.h, s: next.s, v: next.v });
                    setAlpha(parsed.a);
                    props.onChange(parsed);
                  }
                }}
                onBlur={() => setHexDraft(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>
          </Portal>
        )}
      </Show>
    </>
  );
}
