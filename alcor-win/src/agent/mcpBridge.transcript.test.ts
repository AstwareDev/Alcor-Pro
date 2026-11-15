import { afterEach, describe, expect, it } from "vitest";
import type { McpCall, McpTool, McpToolResult } from "../platform/backend";
import { Fixtures, makeAsset, makeEditor, setup } from "../editor/mutations/testFixtures";
import type { Editor } from "../editor/editor";
import { fakeMeasure } from "../captions/testSupport";
import { makeTranscriptionResult, makeTranscriptionWord } from "../transcription/transcription";
import { startAgentMcpBridge, type McpBackend } from "./mcpBridge";
import type { AgentHost } from "./tools/agentHost";
import "./tools/transcriptGroup";
import { setTranscriptionToolDeps } from "./tools/transcriptionTools";

class FakeBackend implements McpBackend {
  tools: McpTool[] = [];
  responses = new Map<string, McpToolResult>();
  call: ((c: McpCall) => void) | null = null;
  async setTools(t: McpTool[]) { this.tools = t; }
  async setInstructions() {}
  async respond(id: string, r: McpToolResult) { this.responses.set(id, r); }
  async onCall(h: (c: McpCall) => void) { this.call = h; return () => { this.call = null; }; }
  async onClient() { return () => undefined; }
}

function fakeHost(editor: Editor): AgentHost {
  return {
    currentEditor: () => editor,
    onCurrentEditorChange: () => () => undefined,
    listProjects: async () => [],
    openProject: async () => { throw new Error("unused"); },
    createProject: async () => { throw new Error("unused"); },
    closeProject: async () => {},
    displayName: () => "Test",
    measureText: fakeMeasure,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const text = (r: McpToolResult | undefined): string => ((r?.content[0] ?? {}) as { text?: string }).text ?? "";

const speech = makeTranscriptionResult({
  text: "Hello. um there.",
  words: [
    makeTranscriptionWord("Hello.", 0, 0.5),
    makeTranscriptionWord("um", 0.6, 0.9),
    makeTranscriptionWord("there.", 1.0, 1.5),
  ],
  segments: [],
});

function voiceEditor(): Editor {
  const clip = Fixtures.clip({ id: "voice", mediaRef: "voice-media", mediaType: "audio", start: 0, duration: 60 });
  const editor = makeEditor([Fixtures.audioTrack({ clips: [clip] })]);
  setup(editor, (e) => {
    e.doc.mediaAssets.push(makeAsset({ id: "voice-media", type: "audio", duration: 2 }));
  });
  return editor;
}

async function connect(editor: Editor): Promise<(name: string, args: Record<string, unknown>) => Promise<McpToolResult | undefined>> {
  const backend = new FakeBackend();
  await startAgentMcpBridge(fakeHost(editor), { backend });
  let n = 0;
  return async (name, args) => {
    const id = String(++n);
    backend.call?.({ id, name, arguments: args });
    await settle();
    return backend.responses.get(id);
  };
}

afterEach(() => setTranscriptionToolDeps(undefined));

describe("MCP bridge: transcript tools", () => {
  it("advertises the transcript tools, remove_silence and detect_beats", async () => {
    const backend = new FakeBackend();
    await startAgentMcpBridge(fakeHost(voiceEditor()), { backend });
    const names = backend.tools.map((t) => t.name);
    for (const name of ["get_transcript", "remove_words", "add_captions", "remove_silence"]) expect(names).toContain(name);
    expect(names).toContain("detect_beats");
  });

  it("get_transcript then remove_words cut the spoken words from the timeline", async () => {
    setTranscriptionToolDeps({
      transcribe: async () => speech,
      backend: () => "openai",
      measure: fakeMeasure,
      newGroupId: () => "G",
    });
    const editor = voiceEditor();
    const call = await connect(editor);

    const transcript = await call("get_transcript", {});
    const payload = JSON.parse(text(transcript));
    expect(payload.transcriptionSource).toBe("openai");
    expect(payload.clips[0].words.map((w: unknown[]) => [w[0], w[1]])).toEqual([[0, "Hello."], [1, "um"], [2, "there."]]);

    const removed = await call("remove_words", { words: [1] });
    expect(removed?.isError).toBeUndefined();
    const result = JSON.parse(text(removed));
    expect(result.removedWords).toBe(1);
    expect(result.removedText).toBe("um");
    expect(result.removedFrames).toBeGreaterThan(0);
    expect(editor.store.undoActionName).toBe("Remove Words (Agent)");
    const total = editor.timeline.tracks[0].clips.reduce((sum, c) => sum + c.durationFrames, 0);
    expect(total).toBe(60 - result.removedFrames);

    const staleMatches = await call("remove_words", { matches: ["nothing-here"] });
    expect(staleMatches?.isError).toBe(true);
    expect(text(staleMatches)).toContain("No transcript words matched");
  });

  it("add_captions transcribes, places a caption group and applies the transform", async () => {
    setTranscriptionToolDeps({
      transcribe: async () => speech,
      backend: () => "openai",
      measure: fakeMeasure,
      newGroupId: () => "GROUP",
    });
    const editor = voiceEditor();
    const call = await connect(editor);

    const res = await call("add_captions", { transform: { x: 0.25, rotation: 5 } });
    expect(res?.isError).toBeUndefined();
    const captions = editor.timeline.tracks[0].clips;
    expect(captions.length).toBeGreaterThan(0);
    expect(captions.every((c) => c.mediaType === "text" && c.captionGroupId === "GROUP")).toBe(true);
    expect(captions.every((c) => c.transform.rotation === 5)).toBe(true);
    expect(editor.store.undoActionName).toBe("Generate Captions (Agent)");
  });

  it("reports the missing transcription key when speech has to be transcribed", async () => {
    setTranscriptionToolDeps({
      transcribe: async () => speech,
      backend: () => undefined,
      measure: fakeMeasure,
      newGroupId: () => "G",
    });
    const call = await connect(voiceEditor());
    const res = await call("get_transcript", {});
    expect(res?.isError).toBe(true);
    expect(text(res)).toContain("API key");
  });
});
