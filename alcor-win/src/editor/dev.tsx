// Browser-only preview of the assembled editor with in-memory data: `?dev=editor`. Not used by the app.
import { fakeProvider } from "../mediapanel/dev";
import { MediaPanelView } from "../mediapanel/MediaPanelView";
import { PreviewView } from "../preview/PreviewView";
import { fakeVisuals, realisticDocument } from "../timeline/dev";
import { TimelinePane } from "../timeline/view/TimelinePane";
import { InspectorView } from "../inspector/InspectorView";
import { PreviewOverlays } from "../preview/overlays/PreviewOverlays";
import { PromptBar } from "../promptbar/PromptBar";
import { createGenerationService } from "../generation/generationService";
import { setProvidersWithKeys } from "../generation/providers/registry";
import type { JobState } from "../generation/providers/types";
import { Editor } from "./editor";
import { EditorView } from "./EditorView";

// `?dev=editor&fakegen` pretends every provider has a key and runs jobs that progress for a few seconds, then finish
// (or fail when the prompt contains "fail"), so the prompt bar's generating UI can be checked without spending credits.
const fakeGeneration = new URLSearchParams(location.search).has("fakegen");
const fakeService = createGenerationService({
  jobs: () => ({
    submit: async (model, params) => ({ providerId: model.providerId, modelId: model.id, ref: JSON.stringify(params) }),
    watch: (handle, onState) => new Promise<JobState>((resolve) => {
      let progress = 0;
      const timer = setInterval(() => {
        progress += 0.03;
        if (progress < 1) return onState({ status: "running", progress });
        clearInterval(timer);
        resolve(/fail/i.test(handle.ref)
          ? { status: "failed", errorMessage: "The dev page pretended this failed. (fake provider: 402 payment required)" }
          : { status: "succeeded", outputs: [{ url: "https://example.invalid/out.mp3" }] });
      }, 400);
    }),
  }),
  ops: { extractTrim: async (t) => t.sourceURL, convertImageToJPEG: async (p) => p, removeTempFiles: async () => undefined },
  fetchOutput: async (source) => source,
  commitStaged: async (_editor, staged) => staged,
  finalize: async (editor, id) => {
    editor.withoutRegistration(() => {
      const asset = editor.doc.mediaAssets.find((a) => a.id === id);
      if (asset) asset.generationStatus = { kind: "none" };
    });
    return true;
  },
  tempDirHint: () => "",
});

export default function EditorDev() {
  const editor = new Editor(realisticDocument());
  editor.ui.currentFrame = 120;
  if (fakeGeneration) setProvidersWithKeys(["fal", "elevenlabs", "openai", "google", "replicate"]);
  return (
    <EditorView
      title="Aesthetic video"
      onExport={() => {}}
      panels={{
        media: () => <MediaPanelView editor={editor} thumbnailProvider={fakeProvider} />,
        preview: () => (
          <PreviewView
            editor={editor}
            resolveUrl={() => null}
            overlay={(canvas, size) => <PreviewOverlays editor={editor} canvas={canvas} size={size} engine={() => undefined} />}
          />
        ),
        inspector: () => <InspectorView editor={editor} />,
        timeline: () => (
          <div class="app-timeline-stack">
            <TimelinePane editor={editor} visuals={fakeVisuals()} />
            <PromptBar editor={editor} onOpenSettings={() => {}} service={fakeGeneration ? fakeService : undefined} />
          </div>
        ),
      }}
    />
  );
}
