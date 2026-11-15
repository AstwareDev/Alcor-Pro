import type { Accessor } from "solid-js";
import type { Clip } from "../model";
import type { Editor } from "../editor/editor";
import { commitClipProperties } from "../editor/mutations/clipMutations";
import { EditorPanelGroup, InspectorRow } from "../ui/EditorPanel";
import { KeyframePropertyControl, useClips } from "./fields";
import { MasksSection } from "./MasksSection";
import { clipDefaults, valuesModified } from "./resetState";

/** Adjustment layers have no transform or media: opacity (and masks) sit above the shared Adjust effect stack. */
export function AdjustmentLayerSection(props: { editor: Editor; ids: Accessor<readonly string[]> }) {
  const { editor } = props;
  const clips = useClips(editor, props.ids);
  const resetOpacity = (c: Clip): void => {
    c.opacity = clipDefaults().opacity;
    delete c.opacityTrack;
  };
  return (
    <>
      <EditorPanelGroup title="Adjustment Layer">
        <InspectorRow
          label="Opacity"
          help="How strongly the effects below apply to the tracks under this layer."
          modified={valuesModified(clips(), resetOpacity)}
          onReset={() => commitClipProperties(editor, props.ids(), resetOpacity, "Reset Opacity")}
        >
          <KeyframePropertyControl editor={editor} ids={props.ids} property="opacity" />
        </InspectorRow>
      </EditorPanelGroup>
      <MasksSection editor={editor} ids={props.ids} />
    </>
  );
}
