import { afterEach, describe, expect, it } from "vitest";
import type { McpCall, McpTool, McpToolResult } from "../platform/backend";
import { Fixtures, makeAsset, makeEditor, setup } from "../editor/mutations/testFixtures";
import type { Editor } from "../editor/editor";
import { multicamClips } from "../editor/mutations/multicamRules";
import { seededCorrelate } from "../audio/audioSyncCorrelator";
import type { SyncServices } from "../audio/sourceTiming";
import { envelopeHopSeconds } from "../media/peaks";
import { startAgentMcpBridge, type McpBackend } from "./mcpBridge";
import type { AgentHost } from "./tools/agentHost";
import { multicamToolServices } from "./tools/multicamTools";
import "./tools";

// Port of Tests/PalmierProTests/Agent/MulticamToolTests.swift, driven through the MCP bridge like the other
// mcpBridge.*.test.ts files. Stub assets have no readable audio, so create pins offsets (the no-correlation path).

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

const settle = () => new Promise((r) => setTimeout(r, 20));
const text = (r: McpToolResult | undefined): string => ((r?.content.find((c) => (c as { type?: string }).type === "text") ?? {}) as { text?: string }).text ?? "";
type Json = Record<string, unknown>;

function fakeHost(editor: Editor): AgentHost {
  return {
    currentEditor: () => editor,
    listProjects: async () => [],
    openProject: async () => { throw new Error("unused"); },
    createProject: async () => { throw new Error("unused"); },
    closeProject: async () => {},
    displayName: () => "Test",
  };
}

let counter = 0;
async function run(backend: FakeBackend, name: string, args: Record<string, unknown>): Promise<McpToolResult | undefined> {
  const id = `${name}-${counter++}`;
  backend.call?.({ id, name, arguments: args });
  await settle();
  return backend.responses.get(id);
}

async function ok(backend: FakeBackend, name: string, args: Record<string, unknown> = {}): Promise<Json> {
  const res = await run(backend, name, args);
  expect(res?.isError, `${name}: ${text(res)}`).toBeFalsy();
  return JSON.parse(text(res)) as Json;
}

async function fixture(): Promise<{ editor: Editor; backend: FakeBackend }> {
  const editor = makeEditor([]);
  setup(editor, () => {
    editor.doc.mediaAssets.push(
      makeAsset({ id: "camA", type: "video", duration: 120, hasAudio: true }),
      makeAsset({ id: "camB", type: "video", duration: 110, hasAudio: true }),
      makeAsset({ id: "mic1", type: "audio", duration: 130 }),
    );
  });
  const backend = new FakeBackend();
  await startAgentMcpBridge(fakeHost(editor), { backend });
  return { editor, backend };
}

const createArgs = () => ({
  create: {
    name: "Podcast",
    members: [
      { mediaRef: "camA", kind: "angle", angleLabel: "cam-a", offsetSeconds: 0 },
      { mediaRef: "camB", kind: "angle", angleLabel: "cam-b", offsetSeconds: 5 },
      { mediaRef: "mic1", kind: "mic", angleLabel: "mic-1", offsetSeconds: 2 },
    ],
    master: "mic-1",
    startFrame: 0,
  },
});

/** Tool payloads shorten ids; direct editor calls need the full id. */
async function createGroup(editor: Editor, backend: FakeBackend): Promise<string> {
  const r = await ok(backend, "manage_multicam", createArgs());
  const short = (r.created as Json).groupId as string;
  const full = editor.doc.multicamGroups.find((g) => g.id.startsWith(short))?.id;
  if (!full) throw new Error("group not created");
  return full;
}

const original = { ...multicamToolServices };
afterEach(() => {
  Object.assign(multicamToolServices, original);
});

describe("multicam tools", () => {
  it("advertisesTheFourMulticamTools", async () => {
    const { backend } = await fixture();
    const names = backend.tools.map((t) => t.name);
    for (const name of ["sync_clips", "manage_multicam", "change_cam", "get_multicam"]) expect(names).toContain(name);
    const layout = backend.tools.find((t) => t.name === "change_cam")?.inputSchema as { properties: { entries: { items: { properties: { layout: { enum: string[] } } } } } };
    expect(layout.properties.entries.items.properties.layout.enum).not.toContain("full");
  });

  it("createReportsGroupAndClips", async () => {
    const { backend } = await fixture();
    const outer = await ok(backend, "manage_multicam", createArgs());
    const r = outer.created as Json;
    expect(r.groupId).toBeDefined();
    const members = r.members as Json[];
    expect(members.length).toBe(3);
    expect(members.every((m) => m.pinned === true)).toBe(true);
    expect((r.clipIds as string[]).length).toBe(2);

    // The group's clips are plain clips in get_timeline; groups list in the payload.
    const tl = await ok(backend, "get_timeline");
    const groups = tl.multicamGroups as Json[];
    expect(groups[0].angles).toEqual(["cam-a", "cam-b"]);
    // Unlinked clips: program video and mic audio each visible on their track.
    const clips = (tl.tracks as Json[]).flatMap((t) => (t.clips as Json[] | undefined) ?? []);
    expect(clips.length).toBe(2);
  });

  it("createIsOneUndoEntry", async () => {
    const { editor, backend } = await fixture();
    await createGroup(editor, backend);
    expect(editor.store.undoActionName).toBe("Create Multicam (Agent)");
    expect((await run(backend, "undo", {}))?.isError).toBeFalsy();
    expect(editor.doc.multicamGroups).toEqual([]);
    expect(editor.timeline.tracks).toEqual([]);
  });

  it("changeCamCutsInPlace", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);

    const r = await ok(backend, "change_cam", { groupId, entries: [{ range: [600, 1200], angle: "cam-b" }] });
    const program = r.program as [string, number, number][];
    expect(program.some((row) => row[0] === "cam-b" && row[1] === 600 && row[2] === 1200)).toBe(true);
    expect(editor.store.undoActionName).toBe("Switch Angle (Agent)");

    const read = await ok(backend, "get_multicam", { groupId });
    const rows = read.program as [string, number, number][];
    expect(rows.map((row) => row[0])).toEqual(["cam-a", "cam-b", "cam-a"]);
    expect(read.trackIndexes).toEqual([0, 1]);
    expect(read.name).toBe("Podcast");
  });

  it("changeCamAppliesLayoutsAndReportsClamps", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);
    const layout = await ok(backend, "change_cam", {
      groupId,
      entries: [{ range: [600, 1200], layout: "side_by_side", angles: ["cam-a", "cam-b"] }],
    });
    expect((layout.overlayClipIds as string[]).length).toBeGreaterThan(0);
    const clamped = await ok(backend, "change_cam", { groupId, entries: [{ range: [0, 600], angle: "cam-b" }] });
    expect(clamped.clamped).toEqual([{ requested: [0, 600], applied: [150, 600], culprit: "cam-b" }]);
    const skipped = await ok(backend, "change_cam", { groupId, entries: [{ range: [90000, 90600], angle: "cam-b" }] });
    expect(skipped.skipped).toEqual([{ range: [90000, 90600], reason: "no multicam clip in this range" }]);
  });

  it("changeCamValidatesEntries", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);
    const before = editor.timeline;

    const both = await run(backend, "change_cam", { groupId, entries: [{ range: [0, 60], angle: "cam-a", layout: "grid_2x2" }] });
    expect(both?.isError).toBe(true);
    expect(text(both)).toContain("not both");

    const unknownAngle = await run(backend, "change_cam", { groupId, entries: [{ range: [0, 60], angle: "cam-z" }] });
    expect(unknownAngle?.isError).toBe(true);
    expect(text(unknownAngle)).toContain("cam-a");

    const badRange = await run(backend, "change_cam", { groupId, entries: [{ range: [60, 60], angle: "cam-a" }] });
    expect(text(badRange)).toContain("start < end");
    const full = await run(backend, "change_cam", { groupId, entries: [{ range: [0, 60], layout: "full", angles: ["cam-a"] }] });
    expect(text(full)).toContain("For full frame, pass angle instead.");
    const tooMany = await run(backend, "change_cam", {
      groupId, entries: [{ range: [0, 60], layout: "side_by_side", angles: ["cam-a", "cam-b", "cam-a"] }],
    });
    expect(text(tooMany)).toContain("takes at most 2 angle(s)");
    expect(editor.timeline).toBe(before);
  });

  it("createRejectsBadKinds", async () => {
    const { backend, editor } = await fixture();
    const r = await run(backend, "manage_multicam", {
      create: { members: [{ mediaRef: "mic1", kind: "angle" }, { mediaRef: "camA", kind: "mic" }] },
    });
    expect(r?.isError).toBe(true);
    expect(text(r)).toContain("video");
    expect(editor.doc.multicamGroups).toEqual([]);
    const few = await run(backend, "manage_multicam", { create: { members: [{ mediaRef: "mic1", kind: "mic" }] } });
    expect(text(few)).toContain("at least two");
    const none = await run(backend, "manage_multicam", {});
    expect(text(none)).toContain("Pass create or ungroup.");
  });

  it("resolveByClipIdWorks", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);
    const clipId = multicamClips(editor, groupId)[0].clip.id;
    const read = await ok(backend, "get_multicam", { clipId });
    expect(groupId.startsWith(read.groupId as string)).toBe(true);
    const bad = await run(backend, "get_multicam", {});
    expect(text(bad)).toContain("Pass groupId or clipId.");
  });

  it("ungroupLeavesOrdinaryClips", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);
    const clipCount = multicamClips(editor, groupId).length;
    await ok(backend, "manage_multicam", { ungroup: { groupId } });
    expect(multicamClips(editor, groupId)).toEqual([]);
    expect(editor.doc.multicamGroups.find((g) => g.id === groupId)).toBeUndefined();
    // Same clips, just unstamped.
    expect(editor.timeline.tracks.flatMap((t) => t.clips).length).toBe(clipCount);
    expect(editor.store.undoActionName).toBe("Ungroup Multicam (Agent)");
  });

  it("moveRefusedOnGroupClips", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);
    const clipId = multicamClips(editor, groupId)[0].clip.id;
    const r = await run(backend, "move_clips", { moves: [{ clipId, toFrame: 999 }] });
    expect(r?.isError).toBe(true);
    expect(text(r)).toContain("sync");
  });

  it("moveWholeGroupAllowed", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);
    const clips = multicamClips(editor, groupId).map((c) => c.clip);
    const moves = clips.map((c) => ({ clipId: c.id, toFrame: c.startFrame + 300 }));
    const r = await run(backend, "move_clips", { moves });
    expect(r?.isError).toBeFalsy();
    const starts = multicamClips(editor, groupId).map((c) => c.clip.startFrame).sort((a, b) => a - b);
    expect(starts).toEqual(clips.map((c) => c.startFrame + 300).sort((a, b) => a - b));
  });

  it("timingFieldsRefusedOnGroupClips", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);
    const clipId = multicamClips(editor, groupId)[0].clip.id;
    expect((await run(backend, "set_clip_properties", { clipIds: [clipId], trimStartFrame: 30 }))?.isError).toBe(true);
    expect((await run(backend, "set_clip_properties", { clipIds: [clipId], speed: 2.0 }))?.isError).toBe(true);
    expect((await run(backend, "set_clip_properties", { clipIds: [clipId], opacity: 0.5 }))?.isError).toBeFalsy();
  });

  it("syncClipsRefusedOnGroupClips", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);
    const camA = editor.mediaAsset("camA");
    const { addClips } = await import("../editor/mutations/clipMutations");
    if (camA) addClips(editor, [camA], 0, 5000);
    const stray = editor.timeline.tracks.flatMap((t) => t.clips).find((c) => c.multicamGroupId === undefined && c.mediaType === "video");
    const target = multicamClips(editor, groupId)[0].clip.id;
    const r = await run(backend, "sync_clips", { referenceClipId: stray?.id, targetClipIds: [target] });
    expect(r?.isError).toBe(true);
    expect(text(r)).toContain("already aligned");
  });

  it("groupTrackRemovalAndUnlockRefused", async () => {
    const { backend, editor } = await fixture();
    const groupId = await createGroup(editor, backend);
    const trackIdx = multicamClips(editor, groupId)[0].trackIndex;
    expect((await run(backend, "manage_tracks", { remove: [trackIdx] }))?.isError).toBe(true);
    expect((await run(backend, "manage_tracks", { set: [{ index: trackIdx, syncLocked: false }] }))?.isError).toBe(true);
    // Mute/hide stay free.
    expect((await run(backend, "manage_tracks", { set: [{ index: trackIdx, muted: true }] }))?.isError).toBeFalsy();
  });
});

// Synthetic audio through the real correlator (the Swift tests only cover the pinned path).
function noise(count: number, seed: number): Float32Array {
  let state = BigInt(seed);
  const mask = (1n << 64n) - 1n;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & mask;
    out[i] = Number((state >> 33n) % 1000n) / 1000;
  }
  return out;
}

describe("multicam tools (audio sync)", () => {
  function useEnvelopes(envelopes: Record<string, Float32Array>): void {
    const services: SyncServices = {
      envelope: async (ref) => (envelopes[ref] ? { hopSeconds: envelopeHopSeconds, samples: envelopes[ref] } : null),
      timing: async () => ({}),
      correlate: (params, signal) => seededCorrelate(params, signal),
    };
    multicamToolServices.create = () => services;
  }

  it("createCorrelatesUnpinnedMembersAndReportsNeedsAttention", async () => {
    const { backend, editor } = await fixture();
    const master = noise(12_000, 5);
    // camB heard the master 2 s late: its audio = master from hop 800.
    useEnvelopes({ mic1: master, camB: master.slice(800, 800 + 9_000), camA: noise(9_000, 321) });
    const r = await ok(backend, "manage_multicam", {
      create: {
        members: [
          { mediaRef: "mic1", kind: "mic", angleLabel: "mic-1" },
          { mediaRef: "camB", kind: "angle", angleLabel: "cam-b" },
          { mediaRef: "camA", kind: "angle", angleLabel: "cam-a", offsetSeconds: 0 },
        ],
        startFrame: 0,
      },
    });
    const created = r.created as Json;
    const members = created.members as Json[];
    const camB = members.find((m) => m.angleLabel === "cam-b");
    const mic = members.find((m) => m.angleLabel === "mic-1");
    expect(mic?.master).toBe(true);
    expect(Number(camB?.offsetSeconds) - Number(mic?.offsetSeconds)).toBeCloseTo(2, 2);
    expect(Number(camB?.confidence)).toBeGreaterThan(0.9);
    expect(created.needsAttention).toBeUndefined();
    expect(editor.doc.multicamGroups.length).toBe(1);
  });

  it("createReportsMembersThatCouldNotBeAligned", async () => {
    const { backend } = await fixture();
    useEnvelopes({ mic1: noise(12_000, 5), camB: noise(9_000, 99) });
    const r = await ok(backend, "manage_multicam", {
      create: {
        members: [
          { mediaRef: "mic1", kind: "mic", angleLabel: "mic-1" },
          { mediaRef: "camA", kind: "angle", angleLabel: "cam-a", offsetSeconds: 0 },
          { mediaRef: "camB", kind: "angle", angleLabel: "cam-b" },
        ],
        startFrame: 0,
      },
    });
    const created = r.created as Json;
    const attention = created.needsAttention as Json[];
    expect(attention.length).toBe(1);
    expect(String(attention[0].reason)).toContain("No confident alignment");
    expect((created.members as Json[]).find((m) => m.angleLabel === "cam-b")?.unsynced).toBe(true);
  });

  it("syncClipsAlignsATargetAndReportsIt", async () => {
    const ref = Fixtures.clip({ id: "refclip", mediaRef: "refM", mediaType: "audio", start: 100, duration: 600 });
    const tgt = Fixtures.clip({ id: "tgtclip", mediaRef: "tgtM", mediaType: "audio", start: 5000, duration: 450 });
    const editor = makeEditor([Fixtures.audioTrack({ clips: [ref] }), Fixtures.audioTrack({ clips: [tgt] })]);
    setup(editor, () => {
      editor.doc.mediaAssets.push(makeAsset({ id: "refM", type: "audio", duration: 20 }), makeAsset({ id: "tgtM", type: "audio", duration: 15 }));
    });
    const backend = new FakeBackend();
    await startAgentMcpBridge(fakeHost(editor), { backend });
    const base = noise(8_000, 77);
    useEnvelopes({ refM: base, tgtM: base.slice(800, 6_800) });

    const r = await ok(backend, "sync_clips", { referenceClipId: "refclip", targetClipId: "tgtclip" });
    const synced = r.synced as Json[];
    expect(synced[0]).toMatchObject({ clipId: "tgtclip", offsetFrames: 160 - 5000, method: "audio" });
    expect(Number(synced[0].confidence)).toBeGreaterThan(0.99);
    expect(editor.clipFor("tgtclip")?.startFrame).toBe(160);
    expect(editor.store.undoActionName).toBe("Synchronize Clips (Agent)");

    const bad = await run(backend, "sync_clips", { referenceClipId: "refclip", targetClipIds: ["tgtclip"], mode: "bogus" });
    expect(text(bad)).toContain("mode must be auto, audio, or timecode");
    const window = await run(backend, "sync_clips", { referenceClipId: "refclip", targetClipId: "tgtclip", searchWindowSeconds: -1 });
    expect(text(window)).toContain("must be finite and > 0");
    const none = await run(backend, "sync_clips", { referenceClipId: "refclip" });
    expect(text(none)).toContain("provide targetClipId or targetClipIds");
  });
});
