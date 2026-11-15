import CaptionsIcon from "lucide-solid/icons/captions";
import TextQuote from "lucide-solid/icons/text-quote";
import type { Editor } from "../editor/editor";
import type { MediaPanelExtraTab } from "../mediapanel/MediaPanelView";
import { CaptionsTab, type CaptionsServices } from "./CaptionsTab";
import { IndexTab } from "./IndexTab";

/**
 * The media panel's Captions tab. `onOpenSettings` is called by the "Add API key" button (no transcription key set);
 * `onAgentTask` (optional) receives the prompt of the Agent menu entries; `onGenerated` fires with the new caption
 * group id after captions were placed.
 */
export function captionsPanelTab(
  editor: Editor,
  onOpenSettings: () => void,
  options: { services?: CaptionsServices; onAgentTask?: (prompt: string) => void; onGenerated?: (captionGroupId: string | undefined) => void } = {},
): MediaPanelExtraTab {
  return {
    id: "captions",
    icon: <CaptionsIcon size={14} />,
    label: "Captions",
    render: () => (
      <CaptionsTab
        editor={editor}
        onOpenSettings={onOpenSettings}
        services={options.services}
        onAgentTask={options.onAgentTask}
        output={{ kind: "captions", onGenerated: (groupId) => options.onGenerated?.(groupId) }}
      />
    ),
  };
}

/** The media panel's Index tab (transcript browser; the Markers browser is not ported). */
export function transcriptPanelTab(editor: Editor, onOpenSettings: () => void, options: { services?: CaptionsServices } = {}): MediaPanelExtraTab {
  return {
    id: "index",
    icon: <TextQuote size={14} />,
    label: "Transcript",
    render: () => <IndexTab editor={editor} onOpenSettings={onOpenSettings} services={options.services} />,
  };
}
