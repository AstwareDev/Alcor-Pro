import { sub } from "./e2lib.mjs";
const v = "src/inspector/VideoTab.tsx";
sub(v, `import { commitCrop } from "../editor/mutations/keyframes";`, `import { commitCrop } from "../editor/mutations/keyframes";
import { applySpeedRampPreset, setFrameBlending } from "../editor/mutations/speedRamp";`);
sub(v, `  deepEqual,
  makeCrop,`, `  deepEqual,
  clipHasSpeedRamp,
  speedRampPresets,
  makeCrop,`);
sub(v, `import { sharedValue } from "../ui/numberField";`, `import { sharedValue } from "../ui/numberField";
import { Toggle } from "../ui/Toggle";`);
sub(v, `            onCommit={(v) => commitClipSpeed(editor, [...props.ids()], v)}
          />
        </InspectorRow>`, `            onCommit={(v) => commitClipSpeed(editor, [...props.ids()], v)}
          />
        </InspectorRow>
        <InspectorRow label="Speed ramp" modified={clips().some(clipHasSpeedRamp)} onReset={() => applySpeedRampPreset(editor, [...props.ids()], undefined)}>
          <DropdownMenuButton
            items={() => [
              { kind: "item", label: "None", checked: !clips().some(clipHasSpeedRamp), onSelect: () => applySpeedRampPreset(editor, [...props.ids()], undefined) },
              { kind: "divider" },
              ...speedRampPresets.map((p) => ({
                kind: "item" as const,
                label: p.name,
                onSelect: () => applySpeedRampPreset(editor, [...props.ids()], p.id),
              })),
            ]}
          >
            <EditorMenuValue text={clips().some(clipHasSpeedRamp) ? "Ramped" : "None"} />
          </DropdownMenuButton>
        </InspectorRow>
        <InspectorRow label="Frame blending" modified={clips().some((c) => c.frameBlending === true)} onReset={() => setFrameBlending(editor, [...props.ids()], false)}>
          <Toggle
            label="Frame blending"
            title="Mix adjacent frames when slower than 1x (applied in export)"
            checked={clips().length > 0 && clips().every((c) => c.frameBlending === true)}
            onChange={(on) => setFrameBlending(editor, [...props.ids()], on)}
          />
        </InspectorRow>`);
