import { insertTrack } from "../../editor/mutations/tracks";
import { placeClip } from "../../editor/mutations/core";
import { layoutPlacement } from "../../editor/mutations/layout";
import {
  layoutFits, videoLayoutSlots, videoLayouts, type LayoutFit, type LayoutSlot, type MediaAsset, type VideoLayout,
} from "../../model";
import { clipSource } from "./clipTools";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import { applySettingsIfNeededForAgent } from "./projectSettingsTools";
import { ToolError, decodeToolArgs } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolResult } from "./toolResult";

// Port of ToolExecutor+Layout.swift.

interface SlotEntry {
  slot: string;
  mediaRef?: string;
  clipIds?: string[];
  anchor?: string;
  anchorX?: number;
  anchorY?: number;
}

export const layoutAnchors: Record<string, { x: number; y: number }> = {
  center: { x: 0.5, y: 0.5 },
  top: { x: 0.5, y: 0 },
  bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 },
  right: { x: 1, y: 0.5 },
  top_left: { x: 0, y: 0 },
  top_right: { x: 1, y: 0 },
  bottom_left: { x: 0, y: 1 },
  bottom_right: { x: 1, y: 1 },
};

function resolveAnchor(e: SlotEntry, path: string): { x: number; y: number } {
  let anchor = { ...layoutAnchors.center };
  if (e.anchor !== undefined) {
    const a = Object.hasOwn(layoutAnchors, e.anchor) ? layoutAnchors[e.anchor] : undefined;
    if (!a) {
      throw new ToolError(
        `${path}: invalid anchor '${e.anchor}'. Valid: ${Object.keys(layoutAnchors).sort().join(", ")}, or anchorX/anchorY for in-between values.`,
      );
    }
    anchor = { ...a };
  }
  for (const [axis, v] of [["anchorX", e.anchorX], ["anchorY", e.anchorY]] as const) {
    if (v !== undefined && !(v >= 0 && v <= 1)) throw new ToolError(`${path}: ${axis} must be between 0 and 1 (got ${v})`);
  }
  if (e.anchorX !== undefined) anchor.x = e.anchorX;
  if (e.anchorY !== undefined) anchor.y = e.anchorY;
  return anchor;
}

export function applyLayout(context: ToolContext, args: ToolArgs): ToolResult {
  const { editor } = context;
  return editor.perform("Apply Layout (Agent)", () => applyLayoutMutation(context, args));
}

function applyLayoutMutation({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<{ layout: string; slots: SlotEntry[]; startFrame?: number; endFrame?: number; fit?: string }>(args, "apply_layout", {
    layout: { spec: "string", required: true },
    slots: {
      required: true,
      spec: {
        array: {
          typeName: "SlotEntry",
          object: {
            slot: { spec: "string", required: true },
            mediaRef: { spec: "string" },
            clipIds: { spec: { array: "string" } },
            anchor: { spec: "string" },
            anchorX: { spec: "double" },
            anchorY: { spec: "double" },
          },
        },
      },
    },
    startFrame: { spec: "int" },
    endFrame: { spec: "int" },
    fit: { spec: "string" },
  });
  if (!(videoLayouts as readonly string[]).includes(input.layout)) {
    throw new ToolError(`unknown layout '${input.layout}'. Valid: ${videoLayouts.join(", ")}`);
  }
  const layout = input.layout as VideoLayout;
  const fitRaw = input.fit ?? "fill";
  if (!(layoutFits as readonly string[]).includes(fitRaw)) throw new ToolError(`invalid fit '${input.fit ?? ""}'. Valid: fill, fit`);
  const fit = fitRaw as LayoutFit;
  if (input.slots.length === 0) throw new ToolError("apply_layout needs a non-empty 'slots' array");

  const layoutSlots = videoLayoutSlots(layout);
  const slotById = new Map(layoutSlots.map((s) => [s.id, s]));

  const seen = new Set<string>();
  const seenClips = new Set<string>();
  let usesMedia = false;
  let usesClip = false;
  const entries: { slot: LayoutSlot; entry: SlotEntry; anchor: { x: number; y: number } }[] = [];
  input.slots.forEach((e, i) => {
    const slot = slotById.get(e.slot);
    if (!slot) {
      throw new ToolError(`slots[${i}]: '${e.slot}' is not a slot of layout '${layout}'. Slots: ${layoutSlots.map((s) => s.id).join(", ")}`);
    }
    if (seen.has(e.slot)) throw new ToolError(`slots[${i}]: duplicate slot '${e.slot}'`);
    seen.add(e.slot);
    if ((e.mediaRef !== undefined) === (e.clipIds !== undefined)) throw new ToolError(`slots[${i}]: provide exactly one of 'mediaRef' or 'clipIds'`);
    if (e.clipIds) {
      if (e.clipIds.length === 0) throw new ToolError(`slots[${i}]: 'clipIds' must not be empty`);
      for (const cid of e.clipIds) {
        if (seenClips.has(cid)) throw new ToolError(`slots[${i}]: clip '${cid}' is assigned to more than one slot; each clip can fill only one.`);
        seenClips.add(cid);
      }
    }
    usesMedia = usesMedia || e.mediaRef !== undefined;
    usesClip = usesClip || e.clipIds !== undefined;
    entries.push({ slot, entry: e, anchor: resolveAnchor(e, `slots[${i}]`) });
  });
  const missing = [...slotById.keys()].filter((id) => !seen.has(id)).sort();
  if (missing.length > 0) throw new ToolError(`layout '${layout}' needs every slot filled. Missing: ${missing.join(", ")}`);
  if (usesMedia && usesClip) {
    throw new ToolError("apply_layout: don't mix 'mediaRef' and 'clipIds' — either place new clips (all mediaRef) or re-layout existing clips (all clipIds).");
  }

  const startFrame = input.startFrame ?? 0;
  const duration = input.endFrame !== undefined ? input.endFrame - (input.startFrame ?? 0) : 0;
  const assetBySlot = new Map<string, MediaAsset>();
  let settingsNote: string | undefined;
  if (usesMedia) {
    if (!(startFrame >= 0)) throw new ToolError(`startFrame must be >= 0 (got ${startFrame})`);
    if (!(duration >= 1)) throw new ToolError("apply_layout placing new clips requires endFrame > startFrame.");
    for (const e of entries) {
      const ref = e.entry.mediaRef as string;
      const a = clipSource(editor, ref, `slot '${e.slot.id}'`);
      if (!(a.type === "video" || a.type === "image" || a.type === "sequence")) {
        throw new ToolError(`slot '${e.slot.id}': ${ref} is ${a.type}; layout slots take video, image, or nested timeline.`);
      }
      assetBySlot.set(e.slot.id, a);
    }
    settingsNote = applySettingsIfNeededForAgent(
      editor,
      layoutSlots.flatMap((s) => {
        const a = assetBySlot.get(s.id);
        return a && a.type !== "sequence" ? [a] : [];
      }),
    );
  } else {
    const rangesByTrack = new Map<string, { slot: string; start: number; end: number }[]>();
    const intervalsBySlot = new Map<string, { start: number; end: number }[]>();
    for (const e of entries) {
      for (const cid of e.entry.clipIds as string[]) {
        const loc = editor.findClip(cid);
        if (!loc) throw new ToolError(`slot '${e.slot.id}': clip not found: ${cid}`);
        const clip = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
        if (!(clip.mediaType === "video" || clip.mediaType === "image" || clip.mediaType === "sequence")) {
          throw new ToolError(`slot '${e.slot.id}': clip ${cid} is ${clip.mediaType}; layout applies to video, image, and nested timeline clips.`);
        }
        const trackId = editor.timeline.tracks[loc.trackIndex].id;
        const start = clip.startFrame;
        const end = clip.startFrame + clip.durationFrames;
        for (const other of rangesByTrack.get(trackId) ?? []) {
          if (other.slot !== e.slot.id && start < other.end && other.start < end) {
            throw new ToolError(
              `clips in slots '${other.slot}' and '${e.slot.id}' are on the same track and their times overlap; only the first would render. Move them to separate tracks (or place new clips with mediaRef) so every region shows.`,
            );
          }
        }
        rangesByTrack.set(trackId, [...(rangesByTrack.get(trackId) ?? []), { slot: e.slot.id, start, end }]);
        intervalsBySlot.set(e.slot.id, [...(intervalsBySlot.get(e.slot.id) ?? []), { start, end }]);
      }
    }
    if (entries.length > 1) {
      const all = [...intervalsBySlot.values()];
      const candidates = all.flatMap((ivs) => ivs.map((iv) => iv.start));
      const coincides = candidates.some((f) => all.every((ivs) => ivs.some((iv) => iv.start <= f && f < iv.end)));
      if (!coincides) {
        throw new ToolError(
          "the selected clips never play at the same time, so no single frame shows every region. Overlap their timeline ranges (or place new clips with mediaRef) before laying them out.",
        );
      }
    }
  }

  const snapshot = timelineSnapshot(editor);
  const clipsBySlot: Record<string, string[]> = {};
  if (usesMedia) {
    const trackBySlot = new Map<string, string>();
    for (const slot of [...layoutSlots].sort((a, b) => a.z - b.z)) {
      const idx = insertTrack(editor, 0, "video");
      trackBySlot.set(slot.id, editor.timeline.tracks[idx].id);
    }
    for (const e of entries) {
      const tid = trackBySlot.get(e.slot.id);
      const asset = assetBySlot.get(e.slot.id);
      const tIdx = tid === undefined ? -1 : editor.timeline.tracks.findIndex((t) => t.id === tid);
      if (!asset || tIdx < 0) continue;
      const ids = placeClip(editor, asset, tIdx, startFrame, duration);
      if (ids[0] !== undefined) clipsBySlot[e.slot.id] = [ids[0]];
    }
  } else {
    for (const e of entries) clipsBySlot[e.slot.id] = e.entry.clipIds as string[];
  }

  for (const e of entries) {
    for (const cid of clipsBySlot[e.slot.id] ?? []) {
      const clip = editor.clipFor(cid);
      const loc = editor.findClip(cid);
      if (!clip || !loc) continue;
      const p = layoutPlacement(editor, clip, e.slot.rect, fit, e.anchor.x, e.anchor.y);
      const target = editor.timeline.tracks[loc.trackIndex].clips[loc.clipIndex];
      target.transform = p.transform;
      target.crop = p.crop;
      delete target.positionTrack;
      delete target.scaleTrack;
      delete target.rotationTrack;
      delete target.cropTrack;
    }
  }

  if (Object.keys(clipsBySlot).length === 0) throw new ToolError("apply_layout changed no clips.");

  const notes = settingsNote !== undefined ? [settingsNote] : [];
  if (!usesMedia) {
    notes.push("Stacking follows current track order (index 0 on top); fix with manage_tracks reorder if an inset isn't on top.");
  }
  return mutationResult(editor, snapshot, {
    touched: Object.values(clipsBySlot).flat(),
    extra: { layout, slots: clipsBySlot },
    notes,
  });
}

