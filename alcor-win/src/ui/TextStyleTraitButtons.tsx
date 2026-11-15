import Italic from "lucide-solid/icons/italic";
import Minus from "lucide-solid/icons/minus";
import Strikethrough from "lucide-solid/icons/strikethrough";
import Underline from "lucide-solid/icons/underline";
import type { JSX } from "solid-js";
import { HoverTooltip } from "./HoverTooltip";
import "./TextStyleTraitButtons.css";

/** Port of `TextStyleTraitButtons`; each state is true / false / undefined (mixed). */
export function TextStyleTraitButtons(props: {
  isBold: boolean | undefined;
  isItalic: boolean | undefined;
  isUnderlined: boolean | undefined;
  isStruckThrough: boolean | undefined;
  isOverlined: boolean | undefined;
  onBold: (v: boolean) => void;
  onItalic: (v: boolean) => void;
  onUnderline: (v: boolean) => void;
  onStrikethrough: (v: boolean) => void;
  onOverline: (v: boolean) => void;
}) {
  return (
    <div class="trait-buttons">
      <TraitButton label="Bold" state={props.isBold} onClick={() => props.onBold(!(props.isBold ?? false))}>
        <span class="trait-glyph bold">B</span>
      </TraitButton>
      <TraitButton label="Italic" state={props.isItalic} onClick={() => props.onItalic(!(props.isItalic ?? false))}>
        <Italic size={11} stroke-width={2.5} />
      </TraitButton>
      <TraitButton label="Underline" state={props.isUnderlined} onClick={() => props.onUnderline(!(props.isUnderlined ?? false))}>
        <Underline size={11} stroke-width={2.5} />
      </TraitButton>
      <TraitButton label="Strikethrough" state={props.isStruckThrough} onClick={() => props.onStrikethrough(!(props.isStruckThrough ?? false))}>
        <Strikethrough size={11} stroke-width={2.5} />
      </TraitButton>
      <TraitButton label="Overline" state={props.isOverlined} overline onClick={() => props.onOverline(!(props.isOverlined ?? false))}>
        <span class="trait-glyph">A</span>
      </TraitButton>
    </div>
  );
}

function TraitButton(props: {
  label: string;
  state: boolean | undefined;
  overline?: boolean;
  onClick: () => void;
  children: JSX.Element;
}) {
  const mixed = (): boolean => props.state === undefined;
  return (
    <HoverTooltip text={props.label}>
      <button
        type="button"
        class="trait-button"
        classList={{ active: props.state === true, overline: props.overline === true && !mixed() }}
        aria-pressed={props.state === undefined ? "mixed" : props.state}
        aria-label={props.label}
        onClick={props.onClick}
      >
        {mixed() ? <Minus size={11} stroke-width={2.5} /> : props.children}
      </button>
    </HoverTooltip>
  );
}
