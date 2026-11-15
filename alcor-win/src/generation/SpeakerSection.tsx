import X from "lucide-solid/icons/x";
import { For, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { hexToRgba, removeSpeaker, renameSpeaker, setSpeakerColor, speakerHex } from "../editor/mutations/speakers";
import { EditorPanelGroup } from "../ui/EditorPanel";
import "./generation.css";

/** Speaker labels of SpeechTab's "Speaker Detection" group: colour and rename per project speaker. */
export function SpeakerSection(props: { editor: Editor }) {
  const speakers = () => props.editor.doc.speakerRegistry;
  return (
    <EditorPanelGroup title="Speaker Detection">
      <Show when={speakers().length > 0} fallback={<span class="speaker-empty">No speakers in this project.</span>}>
        <span class="speaker-heading">Labels</span>
        <div class="speaker-grid">
          <For each={speakers()}>
            {(speaker) => (
              <div class="speaker-label">
                <input
                  type="color"
                  class="speaker-color"
                  aria-label={`${speaker.name} color`}
                  value={speakerHex(speaker.color)}
                  onInput={(e) => {
                    const rgba = hexToRgba(e.currentTarget.value);
                    if (rgba) setSpeakerColor(props.editor, speaker.id, rgba);
                  }}
                />
                <input
                  class="speaker-name"
                  placeholder="Name"
                  aria-label="Speaker name"
                  value={speaker.name}
                  onChange={(e) => renameSpeaker(props.editor, speaker.id, e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
                <button
                  type="button"
                  class="speaker-remove"
                  title="Removes this label and tint."
                  aria-label={`Remove ${speaker.name}`}
                  onClick={() => removeSpeaker(props.editor, speaker.id)}
                >
                  <X size={12} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </EditorPanelGroup>
  );
}
