import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { cachedTimelineTranscript } from "./captionGeneration";
import { CaptionsTab, type CaptionsServices } from "./CaptionsTab";
import { TranscriptBrowser, TranscriptSourceMenu } from "./TranscriptBrowser";
import {
  captionFallbacks, type TimelineTranscriptDocument, type TranscriptIndexSource,
} from "./transcriptBrowserModel";
import "./captions.css";

/**
 * Port of `IndexTab` (transcript section only; the Markers browser is not ported): shows the audio transcript or a
 * caption group already on the timeline, and the transcribe form while there is nothing to show.
 */
export function IndexTab(props: { editor: Editor; onOpenSettings: () => void; services?: CaptionsServices }) {
  const editor = props.editor;
  const [transcript, setTranscript] = createSignal<TimelineTranscriptDocument | undefined>(undefined);
  const [source, setSource] = createSignal<TranscriptIndexSource>({ kind: "automatic" });

  const captionSources = createMemo(() => captionFallbacks(editor.timeline));
  const displayed = (): TimelineTranscriptDocument | undefined => {
    const s = source();
    switch (s.kind) {
      case "automatic": return transcript() ?? captionSources()[0];
      case "transcript": return transcript();
      case "captions": return captionSources().find((c) => c.sourceCaptionGroupId === s.groupId);
    }
  };

  // Picks up an already-cached transcript whenever the timeline changes, without calling any API.
  createEffect(on(() => editor.timeline, () => {
    const controller = new AbortController();
    void cachedTimelineTranscript(editor, controller.signal).then((cached) => {
      if (cached && cached.rows.length > 0 && transcript() === undefined && !controller.signal.aborted) setTranscript(cached);
    });
    return () => controller.abort();
  }));

  return (
    <div class="cap-index">
      <Show
        when={displayed()}
        fallback={
          <div class="cap-index-empty">
            <div class="cap-transcript-controls">
              <span class="cap-transcript-title">Transcript</span>
              <span class="cap-footer-spacer" />
              <Show when={captionSources().length > 0}>
                <TranscriptSourceMenu editor={editor} document={undefined} captionSources={captionSources()} onSelect={setSource} />
              </Show>
            </div>
            <div class="cap-transcript-divider" />
            <CaptionsTab
              editor={editor}
              onOpenSettings={props.onOpenSettings}
              services={props.services}
              output={{
                kind: "transcript",
                onGenerated: (doc) => {
                  setTranscript(doc);
                  setSource({ kind: "transcript" });
                },
              }}
            />
          </div>
        }
      >
        {(doc) => <TranscriptBrowser editor={editor} document={doc()} captionSources={captionSources()} onSelectSource={setSource} />}
      </Show>
    </div>
  );
}
