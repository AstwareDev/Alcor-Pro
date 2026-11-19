import TriangleAlert from "lucide-solid/icons/triangle-exclamation-point";
import { createMemo, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { relinkAsset, relinkOfflineAssets } from "../media/library";
import { pickRelinkSourceFile, pickRelinkSourceFolder } from "../media/relinkPickers";
import { CapsuleButton } from "../ui/CapsuleButton";
import { offlineOverlayAt } from "./offlineClip";
import "./OfflinePreviewOverlay.css";

/** Port of `offlinePreview` in PreviewContainerView: covers the preview while the clip under the playhead is offline. */
export function OfflinePreviewOverlay(props: { editor: Editor; frame: () => number }) {
  const editor = props.editor;
  const overlay = createMemo(() => offlineOverlayAt(editor, props.frame()));

  const relinkFile = async (assetId: string) => {
    const path = await pickRelinkSourceFile();
    if (path) relinkAsset(editor, assetId, path);
  };
  const relinkFolder = async () => {
    const folder = await pickRelinkSourceFolder();
    if (!folder) return;
    const result = await relinkOfflineAssets(editor, folder);
    editor.showToast(`Relinked ${result.relinked} of ${result.total} offline clips.`);
  };

  return (
    <Show when={overlay()}>
      {(o) => (
        <div class="preview-offline">
          <TriangleAlert size={36} class="preview-offline-icon" />
          <div class="preview-offline-title">{o().isUnprocessable ? "Couldn't Prepare Media" : "Media Offline"}</div>
          <p class="preview-offline-text">
            {o().isUnprocessable
              ? "Alcor Pro loaded this clip's source file but couldn't prepare it for playback. The file may be corrupt or in an unsupported format."
              : "Alcor Pro couldn't load this clip's source file. It may be missing, on an ejected drive, or unreadable."}
          </p>
          <Show when={o().path}>{(path) => <p class="preview-offline-path" title={path()}>{path()}</p>}</Show>
          <Show when={!o().isUnprocessable}>
            <div class="preview-offline-actions">
              <CapsuleButton size="regular" variant="prominent" onClick={() => void relinkFile(o().assetId)}>Relink…</CapsuleButton>
              <CapsuleButton size="regular" onClick={() => void relinkFolder()}>Relink Folder…</CapsuleButton>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
