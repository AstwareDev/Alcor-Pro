import ChevronDown from "lucide-solid/icons/chevron-down";
import ChevronRight from "lucide-solid/icons/chevron-right";
import Pipette from "lucide-solid/icons/pipette";
import Box from "lucide-solid/icons/box";
import { createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import { effectParamResolved, type Clip, type Effect } from "../model";
import { effectDescriptor, type EffectParamSpec } from "../preview/effects/effectRegistry";
import type { Editor } from "../editor/editor";
import { applyClipProperties, commitClipProperties, revertClipProperties } from "../editor/mutations/clipMutations";
import { toggleChromaKeySampling } from "../editor/mutations/chromaKey";
import { EditorPanelGroup, EditorResetButton } from "../ui/EditorPanel";
import { AdjustSlider } from "../ui/AdjustSlider";
import { sharedValue } from "../ui/numberField";
import { ScrubbableNumberField } from "../ui/ScrubbableNumberField";
import { Toggle } from "../ui/Toggle";
import { hueCurveChannels, hueCurvesDefaultPoints, hueCurvesEval, hueCurvesPoints, hueCurvesRead, hueCurvesSet, hueCurvesUpsert, gradeCurveEval, gradeCurveIdentityPoints, type HueCurveChannel } from "../model";
import { adjustSectionState } from "./inspectorLogic";
import { ColorWheelControl, CurveEditor } from "./adjustControls";
import { KeyframePropertyFields, useClips } from "./fields";
import { readGradeCurve, removeEffects, setInvert, setLutPath, setSectionEnabled, upsertControl, upsertCurve } from "./effectEdit";
import { inspectorServices } from "./services";

type Ids = Accessor<readonly string[]>;
type EffectsMutation = (effects: Effect[]) => void;

interface Control {
  effectId: string;
  paramKey: string;
  label: string;
  gradient?: string;
}

const c = (effectId: string, paramKey: string, label: string, gradient?: string): Control =>
  gradient === undefined ? { effectId, paramKey, label } : { effectId, paramKey, label, gradient };

const toneControls = [
  c("color.exposure", "ev", "Exposure"), c("color.contrast", "amount", "Contrast"),
  c("color.highlightsShadows", "highlights", "Highlights"), c("color.highlightsShadows", "shadows", "Shadows"),
  c("color.blacksWhites", "blacks", "Blacks"), c("color.blacksWhites", "whites", "Whites"),
];
const whiteBalanceControls = [
  c("color.temperature", "temperature", "Temperature", "var(--slider-temp)"),
  c("color.temperature", "tint", "Tint", "var(--slider-tint)"),
];
const presenceControls = [c("color.vibrance", "amount", "Vibrance"), c("color.saturation", "amount", "Saturation")];
const blurControls = [c("blur.gaussian", "radius", "Blur")];
const vignetteControls = [
  c("stylize.vignette", "amount", "Amount"), c("stylize.vignette", "midpoint", "Midpoint"),
  c("stylize.vignette", "roundness", "Roundness"), c("stylize.vignette", "feather", "Feather"),
];
const motionBlurControls = [c("blur.motion", "radius", "Amount"), c("blur.motion", "angle", "Angle")];
const glowControls = [
  c("stylize.glow", "intensity", "Intensity"), c("stylize.glow", "radius", "Radius"),
  c("stylize.glow", "threshold", "Threshold"), c("stylize.glow", "warmth", "Warmth"),
];
const chromaKeyControls = [c("key.chroma", "tolerance", "Range"), c("key.chroma", "spill", "Spill")];
const grainControls = [c("stylize.grain", "amount", "Amount"), c("stylize.grain", "size", "Size")];
const detailControls = [
  c("blur.sharpen", "amount", "Sharpen"), c("blur.noiseReduction", "amount", "Noise Reduction"),
  c("detail.clarity", "clarity", "Clarity"), c("detail.clarity", "dehaze", "Dehaze"),
];

const ids = (...lists: Control[][]): Set<string> => new Set(lists.flat().map((x) => x.effectId));
const basicIds = ids(toneControls, whiteBalanceControls, presenceControls);
const effectsIds = new Set([...ids(detailControls, blurControls, motionBlurControls, vignetteControls, grainControls, glowControls, chromaKeyControls), "stylize.invert"]);

const paramFormat = (s: EffectParamSpec): string => (s.max - s.min <= 20 ? "%.2f" : "%.0f");
const paramSensitivity = (s: EffectParamSpec): number => Math.max(0.01, (s.max - s.min) / 200);

function controlValue(clip: Clip, control: Control, spec: EffectParamSpec): number {
  const param = clip.effects?.find((e) => e.type === control.effectId)?.params[control.paramKey];
  return param ? effectParamResolved(param, 0, spec.defaultValue) : spec.defaultValue;
}

export function AdjustTab(props: { editor: Editor; ids: Ids }) {
  const { editor } = props;
  const clips = useClips(editor, props.ids);
  const [collapsedSections, setCollapsedSections] = createSignal(new Set(["Curves", "Color Wheels", "Hue Curves", "LUTs", "Effects"]));
  const [collapsedSubgroups, setCollapsedSubgroups] = createSignal(
    new Set(["Detail", "Blur", "Motion Blur", "Vignette", "Film Grain", "Glow", "Chroma Key"]),
  );
  const flip = (get: () => Set<string>, set: (s: Set<string>) => void, key: string): void => {
    const next = new Set(get());
    if (!next.delete(key)) next.add(key);
    set(next);
  };

  const mapEffects = (c: Clip, mutate: EffectsMutation): void => {
    const effects = c.effects ?? [];
    mutate(effects);
    if (effects.length === 0) delete c.effects;
    else c.effects = effects;
  };
  /** Live edit (no undo entry). */
  const applyEffects = (mutate: EffectsMutation): void => applyClipProperties(editor, props.ids(), (c) => mapEffects(c, mutate));
  /** One undoable entry across all selected clips. */
  const commitEffects = (name: string, mutate: EffectsMutation): void =>
    commitClipProperties(editor, props.ids(), (c) => mapEffects(c, mutate), name);
  const cancel = (): void => revertClipProperties(editor, props.ids());
  const resetControl = (control: Control, spec: EffectParamSpec): void => {
    if (control.effectId === "blur.gaussian") commitEffects(`Reset ${control.label}`, (e) => removeEffects(e, new Set([control.effectId])));
    else commitEffects(`Reset ${control.label}`, (e) => upsertControl(e, control.effectId, control.paramKey, spec.defaultValue));
  };
  const setParam = (control: Control, value: number, commit: boolean): void => {
    const mutate: EffectsMutation = (effects) => upsertControl(effects, control.effectId, control.paramKey, value);
    if (commit) commitEffects(`Change ${control.label}`, mutate);
    else applyEffects(mutate);
  };

  const Section = (p: { title: string; effectIds: ReadonlySet<string>; children: JSX.Element }) => {
    const state = () => adjustSectionState(p.effectIds, clips(), editor.ui.chromaKeySamplingClipId);
    return (
      <EditorPanelGroup
        title={p.title}
        expanded={!collapsedSections().has(p.title)}
        onToggle={() => flip(collapsedSections, setCollapsedSections, p.title)}
        gap="var(--sp-md)"
        padding="var(--sp-md) var(--sp-lg)"
        headerAccessory={
          <>
            <Show when={state().hasEffects}>
              <EditorResetButton title={p.title} onClick={() => commitEffects(`Reset ${p.title}`, (e) => removeEffects(e, p.effectIds))} />
            </Show>
            <Toggle
              kind="checkbox"
              label={`Enable: ${p.title}`}
              title={state().hasEffects ? `Enable: ${p.title}` : "No adjustments yet"}
              checked={state().isEnabled}
              disabled={!state().hasEffects}
              onChange={(on) => commitEffects(on ? "Enable Section" : "Disable Section", (e) => setSectionEnabled(e, p.effectIds, on))}
            />
          </>
        }
      >
        <div class="adjust-section-body" classList={{ disabled: !state().isEnabled }}>{p.children}</div>
      </EditorPanelGroup>
    );
  };

  const Subgroup = (p: { title: string; controls: Control[] }) => {
    const expanded = () => !collapsedSubgroups().has(p.title);
    return (
      <div class="adjust-subgroup">
        <div class="adjust-subgroup-header" onClick={() => flip(collapsedSubgroups, setCollapsedSubgroups, p.title)}>
          <span class="adjust-subgroup-chevron">
            <Show when={expanded()} fallback={<ChevronRight size={9} />}><ChevronDown size={9} /></Show>
          </span>
          <span class="adjust-subgroup-title">{p.title}</span>
          <Show when={p.title === "Chroma Key" && props.ids().length === 1}>
            <button
              type="button"
              class="adjust-eyedropper"
              classList={{ on: editor.ui.chromaKeySamplingClipId === props.ids()[0] }}
              title={editor.ui.chromaKeySamplingClipId === props.ids()[0] ? "Cancel key color sampling" : "Sample key color"}
              aria-label="Sample Key Color"
              onClick={(e) => {
                e.stopPropagation();
                toggleChromaKeySampling(editor, props.ids()[0] ?? "");
              }}
            >
              <Pipette size={12} />
            </button>
          </Show>
        </div>
        <Show when={expanded()}>
          <div class="adjust-subgroup-rows">
            <For each={p.controls}>{(control) => <AdjustmentRow control={control} />}</For>
          </div>
        </Show>
      </div>
    );
  };

  const AdjustmentRow = (p: { control: Control }) => {
    const spec = effectDescriptor(p.control.effectId)?.params.find((s) => s.key === p.control.paramKey);
    if (!spec) return null;
    const value = () => sharedValue(clips(), (clip) => controlValue(clip, p.control, spec));
    const isBlur = p.control.effectId === "blur.gaussian" && p.control.paramKey === "radius";
    const modified = (): boolean =>
      isBlur
        ? clips().some((cl) => cl.effects?.some((e) => e.type === p.control.effectId) === true)
        : clips().some((cl) => controlValue(cl, p.control, spec) !== spec.defaultValue);
    return (
      <div class="adjust-row">
        <span class="adjust-row-label child">{p.control.label}</span>
        <Show
          when={!isBlur}
          fallback={<div class="adjust-blur-fields"><KeyframePropertyFields editor={editor} ids={props.ids} property="blur" /></div>}
        >
          <AdjustSlider
            value={value() ?? spec.defaultValue}
            min={spec.min}
            max={spec.max}
            gradient={p.control.gradient}
            defaultValue={spec.defaultValue}
            label={p.control.label}
            onChanged={(v) => setParam(p.control, v, false)}
            onCommit={(v) => setParam(p.control, v, true)}
            onCancel={cancel}
          />
          <ScrubbableNumberField
            value={value()}
            range={{ min: spec.min, max: spec.max }}
            format={paramFormat(spec)}
            valueSuffix={spec.unit === "" ? "" : ` ${spec.unit}`}
            dragSensitivity={paramSensitivity(spec)}
            fieldWidth="var(--numeric-field-w)"
            onChanged={(v) => setParam(p.control, v, false)}
            onCancel={cancel}
            onCommit={(v) => setParam(p.control, v, true)}
          />
        </Show>
        <EditorResetButton title={p.control.label} modified={modified()} onClick={() => resetControl(p.control, spec)} />
      </div>
    );
  };

  // Curves
  const gradeCurve = () => readGradeCurve(clips()[0]?.effects ?? []);
  const curveKey = { Y: "master", R: "red", G: "green", B: "blue" } as const;
  const setCurve = (channel: string, pts: { x: number; y: number }[], commit: boolean, name = "Edit Curves"): void => {
    const key = curveKey[channel as keyof typeof curveKey];
    const mutate: EffectsMutation = (effects) => {
      const curve = readGradeCurve(effects);
      curve[key] = pts;
      upsertCurve(effects, curve);
    };
    if (commit) commitEffects(name, mutate);
    else applyEffects(mutate);
  };

  // Hue curves
  const hueTitles: Record<HueCurveChannel, string> = { Hue: "Hue", Sat: "Sat", Luma: "Luma" };
  const setHueCurve = (channel: string, pts: { x: number; y: number }[], commit: boolean, name = "Edit Hue Curves"): void => {
    const mutate: EffectsMutation = (effects) => {
      const curves = hueCurvesRead(effects);
      hueCurvesSet(curves, channel as HueCurveChannel, pts);
      hueCurvesUpsert(curves, effects);
    };
    if (commit) commitEffects(name, mutate);
    else applyEffects(mutate);
  };

  // Wheels
  const wheel = (title: string, prefix: string) => {
    const mKey = `${prefix}_m`;
    const mSpec = effectDescriptor("color.wheels")?.params.find((s) => s.key === mKey);
    const mDefault = mSpec?.defaultValue ?? 0;
    const param = (clip: Clip, key: string, def: number): number => {
      const p = clip.effects?.find((e) => e.type === "color.wheels")?.params[key];
      return p ? effectParamResolved(p, 0, def) : def;
    };
    const masterControl: Control = { effectId: "color.wheels", paramKey: mKey, label: title };
    const setColor = (x: number, y: number, commit: boolean): void => {
      const mutate: EffectsMutation = (effects) => {
        upsertControl(effects, "color.wheels", `${prefix}_x`, x);
        upsertControl(effects, "color.wheels", `${prefix}_y`, y);
      };
      if (commit) commitEffects(`Adjust ${prefix[0]?.toUpperCase()}${prefix.slice(1)}`, mutate);
      else applyEffects(mutate);
    };
    const specDefault = (key: string): number => effectDescriptor("color.wheels")?.params.find((sp) => sp.key === key)?.defaultValue ?? 0;
    const wheelModified = (): boolean =>
      clips().some((cl) => param(cl, `${prefix}_x`, specDefault(`${prefix}_x`)) !== specDefault(`${prefix}_x`)
        || param(cl, `${prefix}_y`, specDefault(`${prefix}_y`)) !== specDefault(`${prefix}_y`)
        || param(cl, mKey, mDefault) !== mDefault);
    const resetWheel = (): void =>
      commitEffects(`Reset ${title}`, (effects) => {
        for (const key of [`${prefix}_x`, `${prefix}_y`, mKey]) upsertControl(effects, "color.wheels", key, specDefault(key));
      });
    return (
      <ColorWheelControl
        title={title}
        modified={wheelModified()}
        onReset={resetWheel}
        x={sharedValue(clips(), (cl) => param(cl, `${prefix}_x`, 0)) ?? 0}
        y={sharedValue(clips(), (cl) => param(cl, `${prefix}_y`, 0)) ?? 0}
        master={sharedValue(clips(), (cl) => param(cl, mKey, mDefault)) ?? mDefault}
        masterMin={mSpec?.min ?? 0}
        masterMax={mSpec?.max ?? 2}
        masterDefault={mDefault}
        onColorChanged={(x, y) => setColor(x, y, false)}
        onColorCommit={(x, y) => setColor(x, y, true)}
        onMasterChanged={(v) => setParam(masterControl, v, false)}
        onMasterCommit={(v) => setParam(masterControl, v, true)}
        onCancel={cancel}
      />
    );
  };

  // LUT
  const lutEffect = () => clips()[0]?.effects?.find((e) => e.type === "color.lut");
  const lutPath = (): string | undefined => lutEffect()?.params["path"]?.string;
  const lutSpec = effectDescriptor("color.lut")?.params.find((s) => s.key === "intensity");
  const lutIntensity = (): number => {
    const p = lutEffect()?.params["intensity"];
    return p ? effectParamResolved(p, 0, 1) : 1;
  };
  const setLutIntensity = (v: number, commit: boolean): void => {
    const mutate: EffectsMutation = (effects) => {
      const e = effects.find((x) => x.type === "color.lut");
      if (e) upsertControlRaw(e, v);
    };
    if (commit) commitEffects("Change LUT Intensity", mutate);
    else applyEffects(mutate);
  };
  const chooseLut = async (): Promise<void> => {
    const picked = await inspectorServices.chooseLutFile?.();
    if (picked === undefined) return;
    const stored = (await inspectorServices.storeLut?.(picked)) ?? picked;
    commitEffects("Apply LUT", (effects) => setLutPath(effects, stored));
  };

  const invertApplied = (): boolean => clips().length > 0 && clips().every((cl) => cl.effects?.some((e) => e.type === "stylize.invert" && e.enabled) === true);

  return (
    <div class="adjust-tab">
      <Section title="Basic Correction" effectIds={basicIds}>
        <Subgroup title="Tone" controls={toneControls} />
        <Subgroup title="White Balance" controls={whiteBalanceControls} />
        <Subgroup title="Presence" controls={presenceControls} />
      </Section>
      <Section title="Curves" effectIds={new Set(["color.curves"])}>
        <CurveEditor
          channels={[
            { id: "Y", label: "Y", tint: "var(--text-secondary)" },
            { id: "R", label: "R", tint: "var(--curve-red)" },
            { id: "G", label: "G", tint: "var(--curve-green)" },
            { id: "B", label: "B", tint: "var(--curve-blue)" },
          ]}
          stored={(ch) => gradeCurve()[curveKey[ch as keyof typeof curveKey]]}
          defaults={gradeCurveIdentityPoints}
          evalCurve={gradeCurveEval}
          vGrid={4}
          diagonal
          step={0.02}
          hint="Drag to add or shape a point · double-click to remove"
          onChange={(ch, pts) => setCurve(ch, pts, false)}
          onCommit={(ch, pts) => setCurve(ch, pts, true)}
          onResetChannel={(ch) => setCurve(ch, [], true, "Reset Curve")}
          onCancel={cancel}
        />
      </Section>
      <Section title="Color Wheels" effectIds={new Set(["color.wheels"])}>
        <div class="wheels-row">
          {wheel("Lift", "lift")}
          {wheel("Gamma", "gamma")}
          {wheel("Gain", "gain")}
        </div>
      </Section>
      <Section title="Hue Curves" effectIds={new Set(["color.hueCurves"])}>
        <CurveEditor
          channels={hueCurveChannels.map((h) => ({ id: h, label: hueTitles[h], tint: "var(--text-primary)" }))}
          stored={(ch) => hueCurvesPoints(hueCurvesRead(clips()[0]?.effects ?? []), ch as HueCurveChannel)}
          defaults={hueCurvesDefaultPoints}
          evalCurve={hueCurvesEval}
          vGrid={6}
          spectrum
          step={0.01}
          hint="Drag to add or shape a point · double-click to remove"
          onChange={(ch, pts) => setHueCurve(ch, pts, false)}
          onCommit={(ch, pts) => setHueCurve(ch, pts, true)}
          onResetChannel={(ch) => setHueCurve(ch, [], true, "Reset Hue Curve")}
          onCancel={cancel}
        />
      </Section>
      <Section title="LUTs" effectIds={new Set(["color.lut"])}>
        <div class="adjust-row">
          <span class="adjust-row-label child">File</span>
          <button
            type="button"
            class="lut-file"
            title={lutPath() ?? "Choose a .cube LUT file"}
            disabled={inspectorServices.chooseLutFile === undefined}
            onClick={() => void chooseLut()}
          >
            <Box size={11} />
            <span class="lut-file-name">{lutPath() ? (lutPath() as string).split(/[\\/]/).pop() : "Choose…"}</span>
          </button>
        </div>
        <Show when={lutPath() !== undefined}>
          <div class="adjust-row">
            <span class="adjust-row-label child">Intensity</span>
            <AdjustSlider
              value={lutIntensity()}
              min={lutSpec?.min ?? 0}
              max={lutSpec?.max ?? 1}
              defaultValue={lutSpec?.defaultValue ?? 1}
              onChanged={(v) => setLutIntensity(v, false)}
              onCommit={(v) => setLutIntensity(v, true)}
              onCancel={cancel}
            />
            <ScrubbableNumberField
              value={lutIntensity()}
              range={{ min: 0, max: 1 }}
              displayMultiplier={100}
              valueSuffix="%"
              dragSensitivity={0.5}
              fieldWidth="var(--numeric-field-w)"
              onChanged={(v) => setLutIntensity(v, false)}
              onCancel={cancel}
              onCommit={(v) => setLutIntensity(v, true)}
            />
            <EditorResetButton
              title="Intensity"
              modified={lutIntensity() !== (lutSpec?.defaultValue ?? 1)}
              onClick={() => commitEffects("Reset LUT Intensity", (effects) => {
                const e = effects.find((x) => x.type === "color.lut");
                if (e) upsertControlRaw(e, lutSpec?.defaultValue ?? 1);
              })}
            />
          </div>
        </Show>
      </Section>
      <Section title="Effects" effectIds={effectsIds}>
        <Subgroup title="Detail" controls={detailControls} />
        <Subgroup title="Blur" controls={blurControls} />
        <Subgroup title="Motion Blur" controls={motionBlurControls} />
        <Subgroup title="Vignette" controls={vignetteControls} />
        <Subgroup title="Film Grain" controls={grainControls} />
        <Subgroup title="Glow" controls={glowControls} />
        <Subgroup title="Chroma Key" controls={chromaKeyControls} />
        <div class="adjust-subgroup-header toggle-row">
          <span class="adjust-subgroup-chevron" />
          <span class="adjust-subgroup-title">Invert Colors</span>
          <Toggle
            kind="checkbox"
            label="Invert Colors"
            checked={invertApplied()}
            onChange={(on) => {
              const current = props.ids().flatMap((id) => editor.clipFor(id) ?? []);
              const enabled = adjustSectionState(effectsIds, current, editor.ui.chromaKeySamplingClipId).isEnabled;
              if (on && !(current.length === props.ids().length && enabled)) return;
              commitEffects(on ? "Apply Invert Colors" : "Remove Invert Colors", (e) => setInvert(e, on));
            }}
          />
        </div>
      </Section>
    </div>
  );
}

function upsertControlRaw(effect: Effect, value: number): void {
  effect.params["intensity"] = { value };
}
