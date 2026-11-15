import ChevronDown from "lucide-solid/icons/chevron-down";
import ChevronRight from "lucide-solid/icons/chevron-right";
import RotateCcw from "lucide-solid/icons/rotate-ccw";
import { createSignal, Show, type JSX } from "solid-js";
import { HoverTooltip } from "./HoverTooltip";
import "./EditorPanel.css";

/**
 * Port of `EditorResetButton`. `modified === false` (value already at its default) hides the icon but keeps
 * its slot so rows stay aligned; undefined keeps the Swift behaviour of always showing it.
 */
export function EditorResetButton(props: { title: string; onClick: () => void; modified?: boolean }) {
  const hidden = (): boolean => props.modified === false;
  return (
    <HoverTooltip text={`Reset: ${props.title}`}>
      <button
        type="button"
        class="editor-reset"
        classList={{ hidden: hidden() }}
        tabindex={hidden() ? -1 : 0}
        aria-hidden={hidden()}
        aria-label={`Reset: ${props.title}`}
        onClick={() => props.onClick()}
      >
        <RotateCcw size={11} stroke-width={2} />
      </button>
    </HoverTooltip>
  );
}

/**
 * Port of `EditorPanelGroup`: collapsible titled section. Pass `expanded` + `onToggle` for controlled state;
 * otherwise the group keeps its own (initially expanded).
 */
export function EditorPanelGroup(props: {
  title: string;
  expanded?: boolean;
  onToggle?: () => void;
  onReset?: () => void;
  /** False when every control in the group is at its default (hides the reset icon). */
  modified?: boolean;
  headerAccessory?: JSX.Element;
  /** CSS gap between content rows. */
  gap?: string;
  /** CSS padding for the content area. */
  padding?: string;
  children: JSX.Element;
}) {
  const [local, setLocal] = createSignal(true);
  const isExpanded = (): boolean => props.expanded ?? local();
  const toggle = (): void => {
    if (props.onToggle) props.onToggle();
    else setLocal(!local());
  };
  return (
    <section class="epg">
      <div class="epg-header">
        <button
          type="button"
          class="epg-header-toggle"
          aria-expanded={isExpanded()}
          aria-label={`${isExpanded() ? "Collapse" : "Expand"} ${props.title}`}
          onClick={toggle}
        >
          <span class="epg-chevron">
            <Show when={isExpanded()} fallback={<ChevronRight size={10} stroke-width={2.5} />}>
              <ChevronDown size={10} stroke-width={2.5} />
            </Show>
          </span>
          <span class="epg-title">{props.title}</span>
        </button>
        <div class="epg-accessory">
          {props.headerAccessory}
          <Show when={props.onReset}>{(reset) => <EditorResetButton title={props.title} onClick={reset()} modified={props.modified} />}</Show>
        </div>
      </div>
      <Show when={isExpanded()}>
        <div class="epg-content" style={{ gap: props.gap, padding: props.padding }}>
          {props.children}
        </div>
      </Show>
    </section>
  );
}

/** Port of `InspectorRow`: label column, right-aligned trailing controls, optional reset button. */
export function InspectorRow(props: {
  label: string;
  help?: string;
  onReset?: () => void;
  /** False when the value is already the default (hides the reset icon). */
  modified?: boolean;
  /** Fixes the row height to the field height (rows that embed a field). */
  fixedHeight?: boolean;
  /** Reserve the keyframe strip's width so right edges align with keyframable rows. */
  reservesKeyframeControls?: boolean;
  children: JSX.Element;
}) {
  return (
    <div class="inspector-row" classList={{ "fixed-h": props.fixedHeight }} title={props.help}>
      <span class="inspector-row-label">{props.label}</span>
      <div class="inspector-row-trailing">
        {props.children}
        <Show when={props.reservesKeyframeControls}>
          <span style={{ width: "var(--keyframe-strip-w)", flex: "none" }} />
        </Show>
      </div>
      <Show when={props.onReset}>{(reset) => <EditorResetButton title={props.label} onClick={reset()} modified={props.modified} />}</Show>
    </div>
  );
}

/** Port of `EditorMenuValue`: the boxed value with a chevron used as a menu label. */
export function EditorMenuValue(props: { text: string; expanded?: boolean }) {
  return (
    <span class="editor-value-field editor-menu-value" classList={{ expanded: props.expanded }}>
      <span>{props.text}</span>
      <ChevronDown class="chev" size={9} stroke-width={3} />
    </span>
  );
}

/** Port of `iconToggleButton`. */
export function IconToggleButton(props: {
  on: boolean;
  help: string;
  disabled?: boolean;
  onClick: () => void;
  children: JSX.Element;
}) {
  return (
    <HoverTooltip text={props.help}>
      <button
        type="button"
        class="icon-toggle"
        classList={{ on: props.on }}
        disabled={props.disabled}
        aria-pressed={props.on}
        aria-label={props.help}
        onClick={() => props.onClick()}
      >
        {props.children}
      </button>
    </HoverTooltip>
  );
}
