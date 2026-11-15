import AlignCenter from "lucide-solid/icons/text-align-center";
import AlignEnd from "lucide-solid/icons/text-align-end";
import AlignStart from "lucide-solid/icons/text-align-start";
import { createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import {
  clipSetTextFillMode,
  defaultFootageMatteColor,
  fontCaseLabel,
  fontCases,
  makeTextAnimation,
  makeTextStyle,
  presetDisplayName,
  presetUsesHighlight,
  rgbaSetRGB,
  textAnimationDefaultHighlight,
  textAnimationPerLinePresets,
  textAnimationPerWordPresets,
  textFillModeDisplayName,
  textFillModes,
  textStyleAxisScaleRange,
  transformTiltRotationRange,
  makeTransform,
  deepEqual,
  type Clip,
  type RGBA,
  type TextAlignment,
  type TextAnimationPreset,
  type TextFillMode,
  type TextStyle,
} from "../model";
import type { Editor } from "../editor/editor";
import {
  applyClipProperties, applyTextContent, applyTextStyles, cancelDebouncedCommit, commitClipProperties, commitTextContent,
  commitTextStyles, debouncedCommitClipProperties, debouncedCommitTextStyles, revertClipProperties,
} from "../editor/mutations/clipMutations";
import { resetTextSize } from "../editor/mutations/keyframes";
import { ColorField } from "../ui/ColorField";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import { EditorMenuValue, EditorPanelGroup, InspectorRow } from "../ui/EditorPanel";
import { FontPickerField } from "../ui/FontPickerField";
import { sharedValue } from "../ui/numberField";
import { ScrubbableNumberField } from "../ui/ScrubbableNumberField";
import { SegmentedControl } from "../ui/SegmentedControl";
import { TextStyleTraitButtons } from "../ui/TextStyleTraitButtons";
import { Toggle } from "../ui/Toggle";
import { KeyframePropertyControl, KeyframePropertyFields, useClips } from "./fields";
import { clipDefaults, valuesModified } from "./resetState";

type Ids = Accessor<readonly string[]>;
type StyleMutation = (style: TextStyle) => void;

interface NumberRowSpec {
  label: string;
  min: number;
  max: number;
  multiplier?: number;
  format: string;
  suffix: string;
  fit?: boolean;
  get: (s: TextStyle) => number;
  set: (s: TextStyle, v: number) => void;
}

export function TextTab(props: { editor: Editor; ids: Ids }) {
  const { editor } = props;
  const clips = useClips(editor, props.ids);
  const isBatch = (): boolean => props.ids().length > 1;
  const fillMode = (): TextFillMode | undefined => sharedValue(clips(), (c) => c.textFillMode ?? "color");
  const defaults = (): TextStyle => {
    const d = makeTextStyle();
    if (fillMode() === "footage") d.color = defaultFootageMatteColor();
    return d;
  };
  const styles = (): TextStyle[] => clips().map((c) => c.textStyle ?? defaults());
  const value = <V,>(get: (s: TextStyle) => V): V | undefined => sharedValue(styles(), get);
  const primary = (): TextStyle => styles()[0] ?? defaults();

  const apply = (fit: boolean, m: StyleMutation): void => applyTextStyles(editor, props.ids(), m, fit);
  const commit = (fit: boolean, m: StyleMutation): void => commitTextStyles(editor, props.ids(), m, fit);
  const commitColor = (key: string, m: StyleMutation): void => debouncedCommitTextStyles(editor, props.ids(), key, m);
  const cancelFont = (): void => revertClipProperties(editor, props.ids());
  const cancelLive = (): void => revertClipProperties(editor, props.ids());

  const resetTraits = (st: TextStyle): void => {
    const d = defaults();
    st.isBold = d.isBold; st.isItalic = d.isItalic; st.isUnderlined = d.isUnderlined;
    st.isStruckThrough = d.isStruckThrough; st.isOverlined = d.isOverlined;
  };
  const resetPosition = (c: Clip): void => {
    const d = makeTransform();
    c.transform.centerX = d.centerX;
    c.transform.centerY = d.centerY;
    delete c.positionTrack;
  };
  const resetTilt = (c: Clip): void => {
    const d = makeTransform();
    c.transform.rotationX = d.rotationX;
    c.transform.rotationY = d.rotationY;
  };
  const resetRotation = (c: Clip): void => {
    c.transform.rotation = makeTransform().rotation;
    delete c.rotationTrack;
  };
  const resetOpacity = (c: Clip): void => {
    c.opacity = clipDefaults().opacity;
    delete c.opacityTrack;
  };

  const numberRow = (s: NumberRowSpec) => (
    <InspectorRow label={s.label} modified={styles().some((st) => s.get(st) !== s.get(defaults()))} onReset={() => commit(s.fit ?? false, (st) => s.set(st, s.get(defaults())))}>
      <ScrubbableNumberField
        value={value(s.get)}
        range={{ min: s.min, max: s.max }}
        displayMultiplier={s.multiplier}
        format={s.format}
        valueSuffix={s.suffix}
        fieldWidth="var(--numeric-field-w)"
        onChanged={(v) => apply(s.fit ?? false, (st) => s.set(st, v))}
        onCancel={cancelLive}
        onCommit={(v) => commit(s.fit ?? false, (st) => s.set(st, v))}
      />
    </InspectorRow>
  );

  const pairRow = (label: string, min: number, max: number, fit: boolean, get: [(s: TextStyle) => number, (s: TextStyle) => number], set: [(s: TextStyle, v: number) => void, (s: TextStyle, v: number) => void]) => (
    <InspectorRow
      label={label}
      modified={styles().some((st) => get[0](st) !== get[0](defaults()) || get[1](st) !== get[1](defaults()))}
      onReset={() => commit(fit, (st) => { set[0](st, get[0](defaults())); set[1](st, get[1](defaults())); })}
    >
      <div class="field-pair">
        {[0, 1].map((i) => (
          <ScrubbableNumberField
            value={value(i === 0 ? get[0] : get[1])}
            range={{ min, max }}
            format="%.1f"
            fieldWidth="var(--compact-field-w)"
            trailingLabel={i === 0 ? "X" : "Y"}
            onChanged={(v) => apply(fit, (st) => (i === 0 ? set[0] : set[1])(st, v))}
            onCancel={cancelLive}
            onCommit={(v) => commit(fit, (st) => (i === 0 ? set[0] : set[1])(st, v))}
          />
        ))}
      </div>
    </InspectorRow>
  );

  const colorRow = (label: string, key: string, get: (s: TextStyle) => RGBA, preservesOpacity = false) => (
    <InspectorRow
      label={label}
      modified={styles().some((st) => {
        const now = get(st);
        const d = get(defaults());
        return preservesOpacity ? now.r !== d.r || now.g !== d.g || now.b !== d.b : !deepEqual(now, d);
      })}
      onReset={() => {
        cancelDebouncedCommit(editor, key);
        commit(false, (st) => {
          if (preservesOpacity) rgbaSetRGB(get(st), get(defaults()));
          else Object.assign(get(st), get(defaults()));
        });
      }}
    >
      <ColorField
        color={get(primary())}
        supportsOpacity={!preservesOpacity}
        onChange={(color) =>
          commitColor(key, (st) => {
            if (preservesOpacity) rgbaSetRGB(get(st), color);
            else Object.assign(get(st), color);
          })
        }
      />
    </InspectorRow>
  );

  const decoration = (title: string, enabled: () => boolean | undefined, setEnabled: StyleMutationFor, reset: StyleMutation, keys: string[], body: JSX.Element) => {
    const [open, setOpen] = createSignal(true);
    return (
      <EditorPanelGroup
        title={title}
        expanded={open()}
        onToggle={() => setOpen(!open())}
        modified={valuesModified(styles(), reset)}
        onReset={() => {
          keys.forEach((k) => cancelDebouncedCommit(editor, k));
          commit(true, reset);
        }}
        headerAccessory={<Toggle label={title} checked={enabled() ?? false} onChange={(on) => commit(true, (st) => setEnabled(st, on))} />}
      >
        <div class="adjust-section-body" classList={{ disabled: enabled() !== true }}>{body}</div>
      </EditorPanelGroup>
    );
  };

  const setFill = (mode: TextFillMode): void => commitClipProperties(editor, props.ids(), (c) => clipSetTextFillMode(c, mode));
  const showsColor = (): boolean => fillMode() !== undefined && fillMode() !== "inverted";
  const showsSolid = (): boolean => fillMode() === "color";
  const first = (): Clip | undefined => clips()[0];
  const [styleOpen, setStyleOpen] = createSignal(true);

  const alignIcons: Record<TextAlignment, JSX.Element> = {
    left: <AlignStart size={12} />,
    center: <AlignCenter size={12} />,
    right: <AlignEnd size={12} />,
  };

  return (
    <>
      <EditorPanelGroup title="Text">
        <textarea
          class="editor-value-field text-content"
          disabled={isBatch()}
          value={first()?.textContent ?? ""}
          spellcheck={false}
          onInput={(e) => !isBatch() && applyTextContent(editor, first()?.id ?? "", e.currentTarget.value)}
          onBlur={(e) => !isBatch() && commitTextContent(editor, first()?.id ?? "", e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              revertClipProperties(editor, props.ids());
              e.currentTarget.value = first()?.textContent ?? "";
              e.currentTarget.blur();
            }
          }}
        />
      </EditorPanelGroup>
      <EditorPanelGroup title="Style" expanded={styleOpen()} onToggle={() => setStyleOpen(!styleOpen())}>
        <InspectorRow label="Font" modified={styles().some((st) => st.fontName !== defaults().fontName)} onReset={() => commit(true, (st) => { st.fontName = defaults().fontName; })}>
          <FontPickerField
            current={value((s) => s.fontName)}
            onPreview={(name) => apply(true, (st) => { st.fontName = name; })}
            onChange={(name) => commit(true, (st) => { st.fontName = name; })}
            onCancel={cancelFont}
          />
        </InspectorRow>
        <InspectorRow label="Style" modified={valuesModified(styles(), resetTraits)} onReset={() => commit(true, resetTraits)}>
          <TextStyleTraitButtons
            isBold={value((s) => s.isBold)}
            isItalic={value((s) => s.isItalic)}
            isUnderlined={value((s) => s.isUnderlined)}
            isStruckThrough={value((s) => s.isStruckThrough)}
            isOverlined={value((s) => s.isOverlined)}
            onBold={(v) => commit(true, (st) => { st.isBold = v; })}
            onItalic={(v) => commit(true, (st) => { st.isItalic = v; })}
            onUnderline={(v) => commit(false, (st) => { st.isUnderlined = v; })}
            onStrikethrough={(v) => commit(false, (st) => { st.isStruckThrough = v; })}
            onOverline={(v) => commit(false, (st) => { st.isOverlined = v; })}
          />
        </InspectorRow>
        <InspectorRow label="Size" modified={styles().some((st) => st.fontSize !== defaults().fontSize) || clips().some((c) => c.scaleTrack !== undefined)} onReset={() => resetTextSize(editor, [...props.ids()], defaults().fontSize)}>
          <KeyframePropertyControl editor={editor} ids={props.ids} property="scale" />
        </InspectorRow>
        {numberRow({ label: "Width", min: textStyleAxisScaleRange.min, max: textStyleAxisScaleRange.max, multiplier: 100, format: "%.0f", suffix: "%", fit: true, get: (s) => s.widthScale, set: (s, v) => { s.widthScale = v; } })}
        {numberRow({ label: "Height", min: textStyleAxisScaleRange.min, max: textStyleAxisScaleRange.max, multiplier: 100, format: "%.0f", suffix: "%", fit: true, get: (s) => s.heightScale, set: (s, v) => { s.heightScale = v; } })}
        {numberRow({ label: "Tracking", min: -20, max: 100, format: "%.1f", suffix: " pt", fit: true, get: (s) => s.tracking, set: (s, v) => { s.tracking = v; } })}
        {numberRow({ label: "Line Spacing", min: -100, max: 300, format: "%.1f", suffix: " pt", fit: true, get: (s) => s.lineSpacing, set: (s, v) => { s.lineSpacing = v; } })}
        <InspectorRow label="Font Case" modified={styles().some((st) => st.fontCase !== defaults().fontCase)} onReset={() => commit(true, (st) => { st.fontCase = defaults().fontCase; })}>
          <DropdownMenuButton
            items={() => fontCases.map((fc) => ({ kind: "item" as const, label: fontCaseLabel(fc), checked: value((s) => s.fontCase) === fc, onSelect: () => commit(true, (st) => { st.fontCase = fc; }) }))}
          >
            <EditorMenuValue text={((): string => { const fc = value((s) => s.fontCase); return fc ? fontCaseLabel(fc) : "—"; })()} />
          </DropdownMenuButton>
        </InspectorRow>
        <InspectorRow label="Alignment" modified={styles().some((st) => st.alignment !== defaults().alignment)} onReset={() => commit(false, (st) => { st.alignment = defaults().alignment; })}>
          <SegmentedControl
            value={primary().alignment}
            onChange={(a) => commit(false, (st) => { st.alignment = a; })}
            options={(["left", "center", "right"] as const).map((a) => ({ value: a, icon: alignIcons[a], title: `Align ${a}` }))}
          />
        </InspectorRow>
        <InspectorRow label="Position" modified={valuesModified(clips(), resetPosition)} onReset={() => commitClipProperties(editor, props.ids(), resetPosition, "Reset Position")}>
          <KeyframePropertyFields editor={editor} ids={props.ids} property="position" />
        </InspectorRow>
        <InspectorRow label="Tilt" modified={valuesModified(clips(), resetTilt)} onReset={() => commitClipProperties(editor, props.ids(), resetTilt, "Reset Text Tilt")}>
          <div class="field-pair">
            {(["rotationX", "rotationY"] as const).map((key) => (
              <ScrubbableNumberField
                value={sharedValue(clips(), (c) => c.transform[key])}
                range={{ min: transformTiltRotationRange.min, max: transformTiltRotationRange.max }}
                valueSuffix="°"
                fieldWidth="var(--compact-field-w)"
                trailingLabel={key === "rotationX" ? "X" : "Y"}
                onChanged={(v) => applyClipProperties(editor, props.ids(), (c) => { c.transform[key] = v; })}
                onCancel={cancelLive}
                onCommit={(v) => commitClipProperties(editor, props.ids(), (c) => { c.transform[key] = v; }, "Change Text Tilt")}
              />
            ))}
          </div>
        </InspectorRow>
        <InspectorRow label="Rotation" modified={valuesModified(clips(), resetRotation)} onReset={() => commitClipProperties(editor, props.ids(), resetRotation, "Reset Rotation")}>
          <KeyframePropertyFields editor={editor} ids={props.ids} property="rotation" />
        </InspectorRow>
        <InspectorRow label="Fill" modified={fillMode() !== "color"} onReset={() => setFill("color")}>
          <DropdownMenuButton
            items={() => textFillModes.map((m) => ({ kind: "item" as const, label: textFillModeDisplayName(m), checked: fillMode() === m, onSelect: () => setFill(m) }))}
          >
            <EditorMenuValue text={fillMode() ? textFillModeDisplayName(fillMode() as TextFillMode) : "—"} />
          </DropdownMenuButton>
        </InspectorRow>
        <Show when={showsColor()}>{colorRow("Color", "textColor", (s) => s.color)}</Show>
        <InspectorRow label="Opacity" modified={valuesModified(clips(), resetOpacity)} onReset={() => commitClipProperties(editor, props.ids(), resetOpacity, "Reset Opacity")}>
          <KeyframePropertyFields editor={editor} ids={props.ids} property="opacity" />
        </InspectorRow>
        {numberRow({ label: "Blur", min: 0, max: 100, format: "%.0f", suffix: " px", get: (s) => s.blur, set: (s, v) => { s.blur = v; } })}
      </EditorPanelGroup>
      <Show when={showsSolid()}>
        {decoration("Outline", () => value((s) => s.border.enabled), (s, on) => { s.border.enabled = on; }, (s) => { s.border = defaults().border; }, ["outlineColor"], (
          <>
            {colorRow("Color", "outlineColor", (s) => s.border.color)}
            {numberRow({ label: "Width", min: 0, max: 40, format: "%.1f", suffix: " pt", fit: true, get: (s) => s.border.width, set: (s, v) => { s.border.width = v; } })}
          </>
        ))}
        {decoration("Shadow", () => value((s) => s.shadow.enabled), (s, on) => { s.shadow.enabled = on; }, (s) => { s.shadow = defaults().shadow; }, ["shadowColor"], (
          <>
            {colorRow("Color", "shadowColor", (s) => s.shadow.color, true)}
            {numberRow({ label: "Opacity", min: 0, max: 1, multiplier: 100, format: "%.0f", suffix: "%", get: (s) => s.shadow.color.a, set: (s, v) => { s.shadow.color.a = v; } })}
            {pairRow("Offset", -200, 200, true, [(s) => s.shadow.offsetX, (s) => s.shadow.offsetY], [(s, v) => { s.shadow.offsetX = v; }, (s, v) => { s.shadow.offsetY = v; }])}
            {numberRow({ label: "Blur", min: 0, max: 100, format: "%.1f", suffix: " pt", fit: true, get: (s) => s.shadow.blur, set: (s, v) => { s.shadow.blur = v; } })}
          </>
        ))}
        {decoration("Background", () => value((s) => s.background.enabled), (s, on) => { s.background.enabled = on; }, (s) => { s.background = defaults().background; }, ["backgroundColor", "backgroundOutlineColor"], (
          <>
            {colorRow("Color", "backgroundColor", (s) => s.background.color, true)}
            {numberRow({ label: "Opacity", min: 0, max: 1, multiplier: 100, format: "%.0f", suffix: "%", get: (s) => s.background.color.a, set: (s, v) => { s.background.color.a = v; } })}
            {pairRow("Padding", 0, 300, true, [(s) => s.background.paddingX, (s) => s.background.paddingY], [(s, v) => { s.background.paddingX = v; }, (s, v) => { s.background.paddingY = v; }])}
            {pairRow("Center", -500, 500, false, [(s) => s.background.offsetX, (s) => s.background.offsetY], [(s, v) => { s.background.offsetX = v; }, (s, v) => { s.background.offsetY = v; }])}
            {numberRow({ label: "Corner Radius", min: 0, max: 300, format: "%.1f", suffix: " pt", get: (s) => s.background.cornerRadius, set: (s, v) => { s.background.cornerRadius = v; } })}
            {colorRow("Outline Color", "backgroundOutlineColor", (s) => s.background.outlineColor)}
            {numberRow({ label: "Outline Width", min: 0, max: 40, format: "%.1f", suffix: " pt", get: (s) => s.background.outlineWidth, set: (s, v) => { s.background.outlineWidth = v; } })}
          </>
        ))}
      </Show>
    </>
  );
}

type StyleMutationFor = (style: TextStyle, on: boolean) => void;

/** Port of `captionGroupTextClipIds(expanding:)`. */
export function captionGroupTextClipIds(editor: Editor, clipIds: readonly string[]): string[] {
  const requested = new Set(clipIds);
  const groups = new Set<string>();
  for (const track of editor.timeline.tracks) {
    for (const clip of track.clips) if (requested.has(clip.id) && clip.captionGroupId !== undefined) groups.add(clip.captionGroupId);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const track of editor.timeline.tracks) {
    for (const clip of track.clips) {
      const inGroup = clip.captionGroupId !== undefined && groups.has(clip.captionGroupId);
      const included = inGroup ? clip.mediaType === "text" : requested.has(clip.id);
      if (included && !seen.has(clip.id)) {
        seen.add(clip.id);
        result.push(clip.id);
      }
    }
  }
  return result;
}

/** Port of `TextAnimateTab` with a static preset gallery (no animated previews). */
export function TextAnimateTab(props: { editor: Editor; ids: Ids }) {
  const { editor } = props;
  const clips = useClips(editor, props.ids);
  const targetIds = (): string[] => captionGroupTextClipIds(editor, props.ids());
  const anim = () => clips()[0]?.textAnimation ?? makeTextAnimation();

  const setPreset = (preset: TextAnimationPreset): void => {
    cancelDebouncedCommit(editor, "textHighlight");
    const a = { ...anim(), preset };
    commitClipProperties(editor, targetIds(), (c) => {
      if (preset === "none") delete c.textAnimation;
      else c.textAnimation = structuredClone(a);
    });
  };
  const resetHighlight = (): void => {
    cancelDebouncedCommit(editor, "textHighlight");
    commitClipProperties(editor, targetIds(), (c) => {
      if (c.textAnimation) c.textAnimation.highlight = textAnimationDefaultHighlight();
    });
  };
  const section = (title: string, presets: readonly TextAnimationPreset[]) => (
    <div class="preset-section">
      <span class="preset-title">{title}</span>
      <div class="preset-grid">
        <For each={presets}>
          {(p) => (
            <button type="button" class="preset-cell" classList={{ selected: anim().preset === p }} onClick={() => setPreset(p)}>
              <span class="preset-thumb">Aa Bb Cc</span>
              <span class="preset-name">{presetDisplayName(p)}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
  return (
    <EditorPanelGroup title="Animation" gap="var(--sp-lg)">
      {section("Per line", ["none", ...textAnimationPerLinePresets])}
      {section("Per word", textAnimationPerWordPresets)}
      <Show when={presetUsesHighlight(anim().preset)}>
        <InspectorRow label="Highlight" modified={!deepEqual(anim().highlight ?? textAnimationDefaultHighlight(), textAnimationDefaultHighlight())} onReset={resetHighlight}>
          <ColorField
            color={anim().highlight ?? textAnimationDefaultHighlight()}
            onChange={(color) =>
              debouncedCommitClipProperties(editor, targetIds(), "textHighlight", (c) => {
                if (c.textAnimation && presetUsesHighlight(c.textAnimation.preset)) c.textAnimation.highlight = { ...color };
              })
            }
          />
        </InspectorRow>
      </Show>
    </EditorPanelGroup>
  );
}
