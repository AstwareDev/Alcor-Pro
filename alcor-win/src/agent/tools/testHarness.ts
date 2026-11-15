// Port of the Swift `ToolHarness` (Tests/PalmierProTests/Agent/ToolExecutorTests.swift). Only imported by *.test.ts.
import { expect } from "vitest";
import type { Editor } from "../../editor/editor";
import { Fixtures, makeAsset, makeEditor } from "../../editor/mutations/testFixtures";
import type { ClipType, MediaAsset, TextMeasurer, Timeline, Track } from "../../model";
import "./index";
import { ToolExecutor } from "./toolExecutor";
import { resultText, type ToolResult } from "./toolResult";
import type { ToolArgs } from "./toolRegistry";

/** Deterministic text measurement so text-layout tests don't need a canvas. */
export const fakeMeasure: TextMeasurer = (text, _style, renderSize, maxWidth) => {
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((l) => Array.from(l).length));
  return { width: Math.min(maxWidth, longest * renderSize * 0.5), height: lines.length * renderSize * 1.2 };
};

export class ToolHarness {
  readonly editor: Editor;
  readonly executor: ToolExecutor;

  constructor(timeline: Timeline = Fixtures.timeline()) {
    this.editor = makeEditor(timeline.tracks, { fps: timeline.fps, markers: timeline.markers });
    this.editor.withoutRegistration(() => {
      Object.assign(this.editor.timeline, { width: timeline.width, height: timeline.height, name: timeline.name });
    });
    this.executor = ToolExecutor.forEditor(this.editor, { measureText: fakeMeasure });
  }

  /** Run a tool by name and decode the ok text payload as JSON. */
  async runOK(name: string, args: ToolArgs = {}): Promise<Record<string, unknown>> {
    const result = await this.executor.execute(name, args);
    expect(result.isError, `tool ${name} returned error: ${ToolHarness.textOf(result)}`).toBe(false);
    return JSON.parse(ToolHarness.textOf(result)) as Record<string, unknown>;
  }

  runRaw(name: string, args: ToolArgs = {}): Promise<ToolResult> {
    return this.executor.execute(name, args);
  }

  static textOf(result: ToolResult): string {
    const first = result.content[0];
    return first && first.kind === "text" ? first.text : "(non-text)";
  }

  static allText(result: ToolResult): string {
    return resultText(result);
  }

  /** Inject a stub MediaAsset so handlers that look up assets by id can find it. */
  addAsset(p: { id?: string; type?: ClipType; duration?: number; hasAudio?: boolean } = {}): MediaAsset {
    const id = p.id ?? crypto.randomUUID().toUpperCase();
    const asset = makeAsset({ id, type: p.type ?? "video", duration: p.duration ?? 5, hasAudio: p.hasAudio ?? false });
    this.editor.withoutRegistration(() => {
      this.editor.doc.mediaAssets.push(asset);
    });
    return asset;
  }

  tracks(): Track[] {
    return this.editor.timeline.tracks;
  }
}

export { Fixtures };
