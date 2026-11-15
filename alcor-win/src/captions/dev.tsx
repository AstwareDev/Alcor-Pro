// Browser-only page for the captions feature: `?dev=captions`. In-memory editor, fake transcript, fake subtitle file.
import { createSignal, For, Show } from "solid-js";
import { Editor, makeEditorDocument } from "../editor/editor";
import { makeFakeIo } from "../media/fakeIo";
import { setMediaIo } from "../media/io";
import { providersWithKeys, setProvidersWithKeys } from "../generation/providers/registry";
import { makeMediaAsset, makeTimeline } from "../model";
import { fixtureAudioTrack, fixtureClip } from "../model/fixtures";
import { MediaPanelView } from "../mediapanel/MediaPanelView";
import { canvasTextMeasurer } from "../preview/textRenderer";
import { newId } from "../util/id";
import {
  makeTranscriptionResult, makeTranscriptionSegment, makeTranscriptionWord, type TranscriptionResult,
} from "../transcription/transcription";
import { formatTimecode } from "../util/timeFormatting";
import type { CaptionsServices } from "./CaptionsTab";
import { CaptionPreviewOverlay } from "./CaptionPreviewOverlay";
import { captionsPanelTab, transcriptPanelTab } from "./panelTabs";
import "./captions.css";

const sentences = [
  "Welcome back to the channel everyone.",
  "Today we are looking at how captions are built from a transcript.",
  "Every word carries its own timing, which is what makes karaoke style highlights possible.",
  "Short pauses get closed so the text never flickers.",
  "Let us see how it looks.",
];

function fakeTranscript(): TranscriptionResult {
  const words = [];
  const segments = [];
  let t = 0.4;
  for (const sentence of sentences) {
    const start = t;
    for (const w of sentence.split(" ")) {
      const dur = 0.18 + w.length * 0.03;
      words.push(makeTranscriptionWord(w, t, t + dur));
      t += dur + 0.04;
    }
    segments.push(makeTranscriptionSegment(sentence, start, t - 0.04));
    t += 0.7;
  }
  return makeTranscriptionResult({ text: sentences.join(" "), language: "en", words, segments });
}

const subtitleFile = "C:/fake/captions.srt";
const srt = "1\n00:00:01,000 --> 00:00:03,000\nImported cue one\n\n2\n00:00:04,000 --> 00:00:06,500\nImported cue two\nwith a second line\n";

export default function CaptionsDev() {
  const io = makeFakeIo();
  io.addFile(subtitleFile, srt);
  io.addFile("C:/fake/interview.wav", "audio", 1000);
  setMediaIo(io);

  const doc = makeEditorDocument();
  const asset = makeMediaAsset({ id: "interview", url: "C:/fake/interview.wav", type: "audio", name: "interview.wav", duration: 20 });
  doc.mediaAssets = [asset];
  const timeline = makeTimeline({ name: "Interview", tracks: [fixtureAudioTrack({ clips: [fixtureClip({ mediaRef: "interview", mediaType: "audio", start: 0, duration: 600 })] })] });
  doc.timelines = [timeline];
  doc.activeTimelineId = timeline.id;
  doc.openTimelineIds = [timeline.id];
  const editor = new Editor(doc);

  const [keyed, setKeyed] = createSignal(true);
  const [calls, setCalls] = createSignal(0);
  const [settingsOpened, setSettingsOpened] = createSignal(0);
  setProvidersWithKeys(["elevenlabs"]);

  const services: CaptionsServices = {
    pickSubtitleFile: async () => subtitleFile,
    deps: {
      transcribe: async () => {
        setCalls((n) => n + 1);
        await new Promise((resolve) => setTimeout(resolve, 700));
        return fakeTranscript();
      },
      backend: () => (providersWithKeys().has("elevenlabs") ? "elevenlabs" : undefined),
      measure: canvasTextMeasurer,
      newGroupId: newId,
    },
  };

  const toggleKey = (): void => {
    setKeyed(!keyed());
    setProvidersWithKeys(keyed() ? ["elevenlabs"] : []);
  };
  const onOpenSettings = (): void => {
    setSettingsOpened((n) => n + 1);
  };

  const tabs = [captionsPanelTab(editor, onOpenSettings, { services }), transcriptPanelTab(editor, onOpenSettings, { services })];

  const captionClips = () =>
    editor.timeline.tracks.flatMap((t, i) => t.clips.filter((c) => c.mediaType === "text").map((c) => ({ track: i, clip: c })));
  const previewSize = { width: 480, height: 270 };

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg-base)", color: "var(--text-primary)", "font-family": "var(--font-ui)" }}>
      <div style={{ width: "340px", display: "flex", "border-right": "1px solid var(--border-primary)" }}>
        <MediaPanelView editor={editor} extraTabs={tabs} />
      </div>
      <div style={{ flex: 1, padding: "16px", display: "flex", "flex-direction": "column", gap: "12px", overflow: "auto" }}>
        <div style={{ display: "flex", gap: "8px", "align-items": "center", "font-size": "12px" }}>
          <button onClick={toggleKey}>{keyed() ? "Remove API key" : "Add API key"}</button>
          <button onClick={() => editor.undo()}>Undo</button>
          <button onClick={() => editor.redo()}>Redo</button>
          <span>provider calls: {calls()}</span>
          <span>settings opened: {settingsOpened()}</span>
        </div>
        <div
          style={{
            position: "relative",
            width: `${previewSize.width}px`,
            height: `${previewSize.height}px`,
            background: "linear-gradient(135deg, #1d5878, #2e7765)",
            overflow: "hidden",
          }}
        >
          <CaptionPreviewOverlay canvas={{ width: timeline.width, height: timeline.height }} size={previewSize} />
        </div>
        <div style={{ "font-size": "12px" }}>
          <div style={{ "font-weight": 600, "margin-bottom": "4px" }}>Timeline text clips ({captionClips().length})</div>
          <Show when={captionClips().length === 0}>
            <div style={{ color: "var(--text-tertiary)" }}>No captions yet. Use the Captions tab (left rail) and press Generate.</div>
          </Show>
          <For each={captionClips().slice(0, 40)}>
            {({ track, clip }) => (
              <div style={{ display: "flex", gap: "8px" }}>
                <span style={{ color: "var(--text-tertiary)" }}>V{track + 1}</span>
                <span class="timecode">{formatTimecode(clip.startFrame, editor.timeline.fps)}</span>
                <span>{clip.durationFrames}f</span>
                <span>{clip.textContent}</span>
                <Show when={clip.wordTimings}><span style={{ color: "var(--text-muted)" }}>[{clip.wordTimings?.length} words]</span></Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
