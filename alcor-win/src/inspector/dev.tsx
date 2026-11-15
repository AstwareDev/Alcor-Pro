// Browser-only preview of the InspectorView against an in-memory editor: `?dev=inspector`. Not used by the app.
import { createSignal, For } from "solid-js";
import {
  makeAnimPair, makeClip, makeEffect, makeEffectParam, makeKeyframe, makeKeyframeTrack, makeMediaAsset, makeTextStyle, makeTransform,
  makeTrack, makeTimeline,
} from "../model";
import { Editor, makeEditorDocument } from "../editor/editor";
import { inspectorServices } from "./services";
import { InspectorView } from "./InspectorView";

function buildEditor(): Editor {
  const doc = makeEditorDocument();
  const video = makeClip({
    id: "video",
    mediaRef: "m-video",
    mediaType: "video",
    sourceClipType: "video",
    startFrame: 0,
    durationFrames: 300,
    transform: makeTransform({ width: 1, height: 1 }),
  });
  video.opacityTrack = makeKeyframeTrack([makeKeyframe(0, 1), makeKeyframe(120, 0.4, "linear")]);
  video.effects = [
    makeEffect({ type: "color.exposure", params: { ev: makeEffectParam({ value: 0.6 }) } }),
    makeEffect({ type: "color.temperature", params: { temperature: makeEffectParam({ value: 5200 }), tint: makeEffectParam({ value: 0 }) } }),
    makeEffect({ type: "blur.gaussian", params: { radius: makeEffectParam({ value: 8, track: makeKeyframeTrack([makeKeyframe(0, 0), makeKeyframe(90, 20)]) }) } }),
  ];
  const audio = makeClip({ id: "audio", mediaRef: "m-audio", mediaType: "audio", sourceClipType: "audio", startFrame: 0, durationFrames: 300, volume: 0.8 });
  audio.volumeTrack = makeKeyframeTrack([makeKeyframe(0, -6), makeKeyframe(150, 0)]);
  audio.fadeInFrames = 15;
  const text = makeClip({
    id: "text",
    mediaRef: "text",
    mediaType: "text",
    sourceClipType: "text",
    startFrame: 30,
    durationFrames: 120,
    textContent: "Hello, Palmier",
    textStyle: makeTextStyle(),
    transform: makeTransform({ width: 0.5, height: 0.2 }),
  });
  text.scaleTrack = makeKeyframeTrack([makeKeyframe(0, makeAnimPair(0.5, 0.2))]);
  const timeline = makeTimeline({
    tracks: [makeTrack({ type: "video", clips: [text] }), makeTrack({ type: "video", clips: [video] }), makeTrack({ type: "audio", clips: [audio] })],
    settingsConfigured: true,
  });
  doc.timelines = [timeline];
  doc.activeTimelineId = timeline.id;
  doc.openTimelineIds = [timeline.id];
  doc.mediaAssets = [
    makeMediaAsset({ id: "m-video", url: "C:/media/clip.mp4", type: "video", name: "clip.mp4", duration: 10 }),
    makeMediaAsset({ id: "m-audio", url: "C:/media/music.wav", type: "audio", name: "music.wav", duration: 10 }),
  ];
  const editor = new Editor(doc);
  editor.ui.currentFrame = 60;
  return editor;
}

const choices: { label: string; ids: string[] }[] = [
  { label: "None", ids: [] },
  { label: "Video", ids: ["video"] },
  { label: "Audio", ids: ["audio"] },
  { label: "Text", ids: ["text"] },
  { label: "Video + Audio", ids: ["video", "audio"] },
];

export default function InspectorDev() {
  const editor = buildEditor();
  (window as unknown as { __editor: Editor }).__editor = editor;
  inspectorServices.chooseLutFile = () => Promise.resolve("C:/luts/warm.cube");
  const [frame, setFrame] = createSignal(editor.ui.currentFrame);
  const select = (ids: string[]): void => {
    editor.ui.selectedClipIds = new Set(ids);
  };
  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg-base)" }}>
      <div style={{ padding: "12px", display: "flex", "flex-direction": "column", gap: "8px", width: "220px", "font-size": "12px" }}>
        <For each={choices}>
          {(c) => (
            <button type="button" style={{ padding: "4px 8px", border: "1px solid var(--border-primary)", "border-radius": "6px" }} onClick={() => select(c.ids)}>
              {c.label}
            </button>
          )}
        </For>
        <label>
          Playhead {frame()}
          <input
            type="range"
            min="0"
            max="300"
            value={frame()}
            onInput={(e) => {
              setFrame(Number(e.currentTarget.value));
              editor.ui.currentFrame = Number(e.currentTarget.value);
            }}
          />
        </label>
        <button type="button" style={{ padding: "4px 8px", border: "1px solid var(--border-primary)", "border-radius": "6px" }} onClick={() => editor.undo()}>
          Undo
        </button>
        <button type="button" style={{ padding: "4px 8px", border: "1px solid var(--border-primary)", "border-radius": "6px" }} onClick={() => editor.redo()}>
          Redo
        </button>
      </div>
      <div style={{ width: "340px", height: "800px", "border-left": "1px solid var(--border-panel)", "border-right": "1px solid var(--border-panel)" }}>
        <InspectorView editor={editor} />
      </div>
    </div>
  );
}
