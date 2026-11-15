// Browser-only preview of the assembled editor with in-memory data: `?dev=editor`. Not used by the app.
import { fakeProvider } from "../mediapanel/dev";
import { MediaPanelView } from "../mediapanel/MediaPanelView";
import { PreviewView } from "../preview/PreviewView";
import { fakeVisuals, realisticDocument } from "../timeline/dev";
import { TimelinePane } from "../timeline/view/TimelinePane";
import { InspectorView } from "../inspector/InspectorView";
import { PreviewOverlays } from "../preview/overlays/PreviewOverlays";
import { PromptBar } from "../promptbar/PromptBar";
import { Editor } from "./editor";
import { EditorView } from "./EditorView";

export default function EditorDev() {
  const editor = new Editor(realisticDocument());
  editor.ui.currentFrame = 120;
  return (
    <EditorView
      title="Aesthetic video"
      onExport={() => {}}
      panels={{
        media: () => <MediaPanelView editor={editor} thumbnailProvider={fakeProvider} />,
        preview: () => (
          <div class="app-preview-column">
            <PreviewView
              editor={editor}
              resolveUrl={() => null}
              overlay={(canvas, size) => <PreviewOverlays editor={editor} canvas={canvas} size={size} engine={() => undefined} />}
            />
            <PromptBar editor={editor} onOpenSettings={() => {}} />
          </div>
        ),
        inspector: () => <InspectorView editor={editor} />,
        timeline: () => <TimelinePane editor={editor} visuals={fakeVisuals()} />,
      }}
    />
  );
}
