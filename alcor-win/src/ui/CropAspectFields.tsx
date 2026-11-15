import { createEffect, createSignal } from "solid-js";
import { makeCropAspectRatio, type CropAspectRatio } from "../model";
import "./CropAspectFields.css";

function numText(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

/** Port of `CropAspectFields`: editable `W : H` ratio. Invalid input reverts. */
export function CropAspectFields(props: { ratio: CropAspectRatio; onCommit: (r: CropAspectRatio) => void }) {
  const [h, setH] = createSignal(numText(props.ratio.horizontal));
  const [v, setV] = createSignal(numText(props.ratio.vertical));
  const [focused, setFocused] = createSignal(false);
  let cancelling = false;

  createEffect(() => {
    const r = props.ratio;
    if (focused()) return;
    setH(numText(r.horizontal));
    setV(numText(r.vertical));
  });

  const revert = (): void => {
    setH(numText(props.ratio.horizontal));
    setV(numText(props.ratio.vertical));
  };
  const commit = (): void => {
    if (cancelling) {
      cancelling = false;
      return;
    }
    const next = makeCropAspectRatio(Number(h()), Number(v()));
    if (!next) {
      revert();
      return;
    }
    if (next.horizontal !== props.ratio.horizontal || next.vertical !== props.ratio.vertical) props.onCommit(next);
  };
  const field = (value: () => string, set: (s: string) => void, label: string, align: "left" | "right") => (
    <input
      class="crop-ratio-input"
      style={{ "text-align": align }}
      aria-label={`Aspect ratio: ${label}`}
      value={value()}
      spellcheck={false}
      onFocus={() => setFocused(true)}
      onInput={(e) => set(e.currentTarget.value)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          cancelling = true;
          revert();
          e.currentTarget.blur();
        }
      }}
    />
  );
  return (
    <div class="editor-value-field crop-ratio" classList={{ active: focused() }} title="Choose a crop aspect">
      {field(h, setH, "Width", "right")}
      <span class="crop-ratio-colon">:</span>
      {field(v, setV, "Height", "left")}
    </div>
  );
}
