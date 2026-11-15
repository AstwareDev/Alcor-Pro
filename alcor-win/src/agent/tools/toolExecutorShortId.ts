import type { Editor } from "../../editor/editor";
import { ToolError, isRecord } from "./toolArgs";
import type { ToolArgs } from "./toolRegistry";
import type { ToolResult } from "./toolResult";

// Port of ToolExecutor+ShortId.swift: UUID ids are shortened to unique prefixes when output; full ids are accepted
// as input.

const idPrefixFloor = 8;

const scalarIdKeys = new Set([
  "clipId", "sourceClipId", "referenceClipId", "targetClipId",
  "mediaRef", "startFrameMediaRef", "endFrameMediaRef",
  "sourceVideoMediaRef", "videoSourceMediaRef", "sourceMediaRef", "subtitleMediaRef",
  "captionGroupId", "timelineId", "trackId", "item", "from", "reference",
  "groupId", "memberId", "markerId",
]);
const arrayIdKeys = new Set([
  "clipIds", "targetClipIds", "items", "ids", "deletes",
  "referenceMediaRefs", "referenceImageMediaRefs",
  "referenceVideoMediaRefs", "referenceAudioMediaRefs",
]);

/** Returns all ids visible to the agent. */
export function currentIdUniverse(editor: Editor): Set<string> {
  const ids = new Set<string>();
  const doc = editor.store.committed;
  for (const timeline of doc.timelines) ids.add(timeline.id);
  const active = doc.timelines.find((t) => t.id === doc.activeTimelineId) ?? doc.timelines[0];
  if (active) {
    for (const track of active.tracks) {
      ids.add(track.id);
      for (const clip of track.clips) {
        ids.add(clip.id);
        if (clip.captionGroupId !== undefined) ids.add(clip.captionGroupId);
        if (clip.linkGroupId !== undefined) ids.add(clip.linkGroupId);
      }
    }
    for (const marker of active.markers) ids.add(marker.id);
  }
  for (const asset of doc.mediaAssets) ids.add(asset.id);
  for (const group of doc.multicamGroups) {
    ids.add(group.id);
    for (const member of group.members) ids.add(member.id);
  }
  return ids;
}

/** Maps each id to its shortest prefix (>= idPrefixFloor) that no other id shares. */
export function shortIdMap(ids: ReadonlySet<string>): Map<string, string> {
  const sorted = [...ids].sort();
  const out = new Map<string, string>();
  sorted.forEach((id, i) => {
    let sharedLen = 0;
    if (i > 0) sharedLen = Math.max(sharedLen, commonPrefixLength(id, sorted[i - 1]));
    if (i < sorted.length - 1) sharedLen = Math.max(sharedLen, commonPrefixLength(id, sorted[i + 1]));
    const len = Math.min(id.length, Math.max(idPrefixFloor, sharedLen + 1));
    out.set(id, id.slice(0, len));
  });
  return out;
}

function commonPrefixLength(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count++;
  return count;
}

const uuidRegex = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;

/** Rewrites known UUIDs in result text to their shortest unique prefixes. */
export function shorteningIds(result: ToolResult, universe: ReadonlySet<string>): ToolResult {
  if (!result.content.some((b) => b.kind === "text") || universe.size === 0) return result;
  const map = shortIdMap(universe);
  if (map.size === 0) return result;
  return {
    isError: result.isError,
    content: result.content.map((block) =>
      block.kind === "text" ? { kind: "text", text: block.text.replace(uuidRegex, (m) => map.get(m) ?? m) } : block,
    ),
  };
}

/**
 * Expands id-prefix arguments back to full ids before a tool runs. Throws on an ambiguous prefix; leaves unknown
 * values untouched so the tool emits its own not-found error.
 */
export function expandingIdPrefixes(args: ToolArgs, universe: ReadonlySet<string>): ToolArgs {
  const expanded = expand(args, universe);
  return isRecord(expanded) ? expanded : args;
}

function expand(value: unknown, universe: ReadonlySet<string>): unknown {
  if (isRecord(value)) {
    const out: Record<string, unknown> = { ...value };
    for (const [key, v] of Object.entries(value)) {
      if (scalarIdKeys.has(key) && typeof v === "string") out[key] = expandOne(v, universe);
      else if (arrayIdKeys.has(key) && Array.isArray(v)) out[key] = v.map((item) => (typeof item === "string" ? expandOne(item, universe) : item));
      else out[key] = expand(v, universe);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, universe));
  return value;
}

function expandOne(ref: string, universe: ReadonlySet<string>): string {
  if (universe.has(ref)) return ref;
  if (ref.length < idPrefixFloor) return ref;
  const matches = [...universe].filter((id) => id.startsWith(ref));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new ToolError(`Ambiguous id '${ref}' matches ${matches.length} items; re-read with get_timeline or get_media for current ids.`);
  }
  return ref;
}
