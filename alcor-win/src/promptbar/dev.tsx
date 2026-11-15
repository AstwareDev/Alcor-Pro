// Browser-only preview of the prompt bar with an in-memory editor and a fake generation service: `?dev=promptbar`.
import { Editor } from "../editor/editor";
import { createGenerationService } from "../generation/generationService";
import { realisticDocument } from "../timeline/dev";
import { PromptBar } from "./PromptBar";

const service = createGenerationService({
  jobs: () => ({
    submit: () => Promise.reject(new Error("The dev page does not call providers.")),
    watch: () => new Promise(() => undefined),
  }),
  ops: { extractTrim: async (t) => t.sourceURL, convertImageToJPEG: async (p) => p, removeTempFiles: async () => undefined },
  fetchOutput: async (source) => source,
  commitStaged: async (_editor, staged) => staged,
  finalize: async () => true,
  tempDirHint: () => "",
});

export default function PromptBarDev() {
  const editor = new Editor(realisticDocument());
  return (
    <div style={{ display: "flex", "flex-direction": "column", height: "100vh", "justify-content": "flex-end", background: "var(--bg-base)" }}>
      <div style={{ flex: 1, display: "grid", "place-items": "center", color: "var(--text-muted)", "font-size": "var(--fs-sm)" }}>
        Preview area. Press Ctrl+K to focus the bar. Add a key in Settings to enable generation.
      </div>
      <PromptBar editor={editor} service={service} onOpenSettings={() => alert("Open Settings")} />
    </div>
  );
}
