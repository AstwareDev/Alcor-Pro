// Media panel drag payload (MediaTab+Drag): newline-separated sentinel lines, identical to the Swift text payload.
// `palmier-asset://<id>[#<start>-<end>]` (source seconds), `palmier-folder://<id>`, `palmier-timeline://<id>`.
// The sentinels keep in-panel drags distinguishable from OS file drops.

export const folderDragScheme = "palmier-folder://";
export const assetDragScheme = "palmier-asset://";
export const timelineDragScheme = "palmier-timeline://";

export interface SourceSegment {
  start: number;
  end: number;
}

export interface MediaDragAsset {
  id: string;
  segment?: SourceSegment;
}

export interface MediaDragPayload {
  assets: MediaDragAsset[];
  folderIds: string[];
  timelineIds: string[];
}

export function folderDragString(id: string): string {
  return folderDragScheme + id;
}

export function folderIdFromDragString(line: string): string | undefined {
  return line.startsWith(folderDragScheme) ? line.slice(folderDragScheme.length) : undefined;
}

export function timelineDragString(id: string): string {
  return timelineDragScheme + id;
}

export function timelineIdFromDragString(line: string): string | undefined {
  return line.startsWith(timelineDragScheme) ? line.slice(timelineDragScheme.length) : undefined;
}

/** A search "moment" carries its source range: `palmier-asset://<id>#<start>-<end>` with 3 decimals. */
export function assetDragString(id: string, segment?: SourceSegment): string {
  return assetDragScheme + id + (segment ? `#${segment.start.toFixed(3)}-${segment.end.toFixed(3)}` : "");
}

export function assetIdFromDragString(line: string): string | undefined {
  if (!line.startsWith(assetDragScheme)) return undefined;
  const rest = line.slice(assetDragScheme.length);
  const hash = rest.indexOf("#");
  return hash < 0 ? rest : rest.slice(0, hash);
}

export function assetSegmentFromDragString(line: string): SourceSegment | undefined {
  if (!line.startsWith(assetDragScheme)) return undefined;
  const hash = line.indexOf("#");
  if (hash < 0) return undefined;
  const parts = line.slice(hash + 1).split("-");
  if (parts.length !== 2) return undefined;
  const start = parseSwiftDouble(parts[0]);
  const end = parseSwiftDouble(parts[1]);
  if (start === undefined || end === undefined || !(start >= 0) || !(end > start)) return undefined;
  return { start, end };
}

function parseSwiftDouble(text: string): number | undefined {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return undefined;
  return Number(text);
}

/** Folders and timelines first, then assets in the given order (the dragged selection's list order). */
export function encodeMediaDrag(payload: Partial<MediaDragPayload>): string {
  return [
    ...(payload.folderIds ?? []).map(folderDragString),
    ...(payload.timelineIds ?? []).map(timelineDragString),
    ...(payload.assets ?? []).map((a) => assetDragString(a.id, a.segment)),
  ].join("\n");
}

/** Unknown or empty lines are ignored; duplicate ids keep their first occurrence. */
export function decodeMediaDrag(text: string): MediaDragPayload {
  const payload: MediaDragPayload = { assets: [], folderIds: [], timelineIds: [] };
  const seenAssets = new Set<string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const folderId = folderIdFromDragString(line);
    if (folderId !== undefined) {
      if (!payload.folderIds.includes(folderId)) payload.folderIds.push(folderId);
      continue;
    }
    const timelineId = timelineIdFromDragString(line);
    if (timelineId !== undefined) {
      if (!payload.timelineIds.includes(timelineId)) payload.timelineIds.push(timelineId);
      continue;
    }
    const assetId = assetIdFromDragString(line);
    if (assetId !== undefined && !seenAssets.has(assetId)) {
      seenAssets.add(assetId);
      const segment = assetSegmentFromDragString(line);
      payload.assets.push(segment ? { id: assetId, segment } : { id: assetId });
    }
  }
  return payload;
}
