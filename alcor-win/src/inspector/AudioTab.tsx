import { createSignal, Show, type Accessor } from "solid-js";
import { type Clip, clipDenoiseAmount, clipHasDenoiseEnabled, clipFadeFrames, type FadeEdge } from "../model";
import type { Editor } from "../editor/editor";
import { commitClipProperties } from "../editor/mutations/clipMutations";
import { applyFade, commitFades } from "../editor/mutations/keyframes";
import { revertClipProperties } from "../editor/mutations/clipMutations";
import { EditorPanelGroup, InspectorRow } from "../ui/EditorPanel";
import { sharedValue } from "../ui/numberField";
import { ScrubbableNumberField } from "../ui/ScrubbableNumberField";
import { Toggle } from "../ui/Toggle";
import { swiftRound } from "../util/math";
import { KeyframePropertyControl, useClips } from "./fields";
import { clipDefaults, valuesModified } from "./resetState";
import { denoiseFailed, denoiseInFlight } from "../denoise/denoiseState";
import { setDenoise } from "./effectEdit";
import { SpeedSection } from "./VideoTab";

type Ids = Accessor<readonly string[]>;

function resetVolume(c: Clip): void {
  c.volume = clipDefaults().volume;
  delete c.volumeTrack;
}

export function AudioTab(props: { editor: Editor; audioIds: Ids; hasVisual: boolean }) {
  const { editor } = props;
  const [levelsOpen, setLevelsOpen] = createSignal(true);
  const clips = useClips(editor, props.audioIds);

  const fadeRow = (label: string, edge: FadeEdge) => {
    const fps = (): number => Math.max(1, editor.timeline.fps);
    const maxSeconds = (): number => {
      const only = clips().length === 1 ? clips()[0] : undefined;
      return only ? only.durationFrames / fps() : 60;
    };
    const defaultFade = (): number => clipDefaults()[edge === "left" ? "fadeInFrames" : "fadeOutFrames"];
    return (
      <InspectorRow
        label={label}
        fixedHeight
        reservesKeyframeControls
        modified={clips().some((c) => clipFadeFrames(c, edge) !== defaultFade())}
        onReset={() => commitFades(editor, [...props.audioIds()], edge, defaultFade())}
      >
        <ScrubbableNumberField
          value={sharedValue(clips(), (c) => clipFadeFrames(c, edge) / fps())}
          range={{ min: 0, max: maxSeconds() }}
          format="%.2f"
          valueSuffix=" s"
          dragSensitivity={0.02}
          fieldWidth="var(--numeric-field-w)"
          onChanged={(s) => props.audioIds().forEach((id) => applyFade(editor, id, edge, swiftRound(s * fps())))}
          onCancel={() => revertClipProperties(editor, props.audioIds())}
          onCommit={(s) => commitFades(editor, [...props.audioIds()], edge, swiftRound(s * fps()))}
        />
      </InspectorRow>
    );
  };

  const idSet = (): Set<string> => new Set(props.audioIds());
  const allOn = (): boolean => clips().length > 0 && clips().every(clipHasDenoiseEnabled);
  const baking = (): boolean => clips().some((c) => denoiseInFlight().has(c.mediaRef));
  const failed = (): boolean => allOn() && !baking() && clips().some((c) => denoiseFailed().has(c.mediaRef));

  return (
    <>
      <EditorPanelGroup title="Levels" expanded={levelsOpen()} onToggle={() => setLevelsOpen(!levelsOpen())}>
        <InspectorRow
          label="Volume"
          modified={valuesModified(clips(), resetVolume)}
          onReset={() => commitClipProperties(editor, props.audioIds(), resetVolume, "Reset Volume")}
        >
          <KeyframePropertyControl editor={editor} ids={props.audioIds} property="volume" />
        </InspectorRow>
        {fadeRow("Fade In", "left")}
        {fadeRow("Fade Out", "right")}
      </EditorPanelGroup>
      <EditorPanelGroup title="Enhance">
        <Show when={clips().length > 0}>
          <InspectorRow
            label="Denoise"
            help="Removes background noise from this audio using an on-device model."
            modified={clips().some(clipHasDenoiseEnabled)}
            onReset={() => setDenoise(editor, idSet(), false, undefined, "Reset Denoise")}
          >
            <Show when={allOn()}>
              <ScrubbableNumberField
                value={sharedValue(clips(), (c) => clipDenoiseAmount(c) * 100)}
                range={{ min: 0, max: 100 }}
                valueSuffix="%"
                dragSensitivity={0.5}
                fieldWidth="var(--numeric-field-w)"
                onCommit={(percent) => setDenoise(editor, idSet(), true, percent / 100, "Change Denoise Strength")}
              />
            </Show>
            <Toggle
              label="Denoise"
              checked={allOn()}
              onChange={(on) => setDenoise(editor, idSet(), on, undefined, on ? "Enable Denoise" : "Disable Denoise")}
            />
          </InspectorRow>
          <Show when={baking()}>
            <div class="denoise-note">Removing background noise…</div>
          </Show>
          <Show when={failed()}>
            <div class="denoise-note denoise-note-error">Denoise failed. Playback uses the original audio — adjust Strength to retry.</div>
          </Show>
        </Show>
      </EditorPanelGroup>
      <Show when={!props.hasVisual}>
        <SpeedSection editor={editor} ids={props.audioIds} />
      </Show>
    </>
  );
}
