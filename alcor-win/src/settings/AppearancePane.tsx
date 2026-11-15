import { For } from "solid-js";
import { makeRGBA } from "../model";
import { sharedTimelineClipColorPalette, timelineClipColorKinds, type TimelineClipColor } from "../timeline/view/timelineClipColors";
import { CapsuleButton } from "../ui/CapsuleButton";
import { ColorField } from "../ui/ColorField";
import { hexText } from "../ui/color";
import { appearanceOptions, sharedAppearance, type Appearance } from "./appearance";
import { SettingsGroup, SettingsSection } from "./SettingsParts";

const themeLabel: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };
const kindLabel: Record<TimelineClipColor, string> = {
  video: "Video", audio: "Audio", image: "Image", text: "Text", animation: "Animation", sequence: "Sequence",
};

function ThemePreview(props: { option: Appearance }) {
  return (
    <span class="theme-preview" data-option={props.option}>
      <span class="theme-preview-bar" />
      <span class="theme-preview-body" />
    </span>
  );
}

/** Port of `TimelineColorsPane`. */
function TimelineColors() {
  const palette = sharedTimelineClipColorPalette();
  const rgba = (kind: TimelineClipColor) => {
    palette.revision();
    return makeRGBA({ ...palette.color(kind), a: 1 });
  };
  return (
    <SettingsSection title="Timeline colors">
      <For each={timelineClipColorKinds}>
        {(kind) => (
          <div class="settings-row color-row">
            <div class="settings-row-title">{kindLabel[kind]}</div>
            <span class="settings-spacer" />
            <span class="settings-row-subtitle mono">{hexText(rgba(kind), false)}</span>
            <ColorField
              color={rgba(kind)}
              supportsOpacity={false}
              label={`Choose ${kindLabel[kind].toLowerCase()} clip color`}
              onChange={(c) => palette.set({ r: c.r, g: c.g, b: c.b }, kind)}
            />
          </div>
        )}
      </For>
      <div class="settings-actions">
        <CapsuleButton disabled={(palette.revision(), !palette.hasOverrides())} onClick={() => palette.resetAll()}>Reset All</CapsuleButton>
      </div>
    </SettingsSection>
  );
}

export function AppearancePane() {
  const appearance = sharedAppearance();
  return (
    <>
      <SettingsGroup title="Theme">
        <div class="theme-cards" role="radiogroup" aria-label="Theme">
          <For each={appearanceOptions}>
            {(option) => (
              <button
                type="button"
                role="radio"
                class="theme-card"
                classList={{ selected: appearance.selection() === option }}
                aria-checked={appearance.selection() === option}
                aria-label={`${themeLabel[option]} appearance`}
                onClick={() => appearance.set(option)}
              >
                <ThemePreview option={option} />
                <span class="theme-card-label">{themeLabel[option]}</span>
              </button>
            )}
          </For>
        </div>
      </SettingsGroup>
      <TimelineColors />
    </>
  );
}
