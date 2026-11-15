// Port of ToolExecutor+Search.swift: the search_media tool (visual moments plus spoken keyword hits).
import { jsonString, roundJSONFloatingPointNumbers } from "../agent/tools/jsonFormat";
import { ToolError, argInt, argString, requireString, validateUnknownKeys } from "../agent/tools/toolArgs";
import type { ToolArgs, ToolContext } from "../agent/tools/toolRegistry";
import { ok, type ToolResult } from "../agent/tools/toolResult";
import type { Editor } from "../editor/editor";
import { searchTranscripts } from "../transcription/transcriptSearch";
import type { SearchIndexCoordinator } from "./searchIndex";
import { searchIndexFor } from "./searchService";

const allowedKeys = ["query", "scope", "mediaRef", "limit"];

type Json = Record<string, unknown>;

export async function searchMedia({ editor, executor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, allowedKeys, "search_media");
  const query = requireString(args, "query").trim();
  if (query === "") throw new ToolError("search_media: query is empty");
  const scope = argString(args, "scope") ?? "both";
  if (!["visual", "spoken", "both"].includes(scope)) throw new ToolError(`search_media: scope must be visual, spoken, or both (got '${scope}')`);
  const limit = Math.min(Math.max(argInt(args, "limit") ?? 10, 1), 50);
  const mediaRef = argString(args, "mediaRef");
  const restrict = mediaRef === undefined ? undefined : new Set([executor.asset(mediaRef, editor).id]);

  const payload: Json = { timelineFps: editor.timeline.fps };
  if (scope !== "spoken") {
    const { moments, index } = await visualResults(editor, searchIndexFor(editor), query, limit, restrict);
    payload.moments = moments;
    if (index) payload.index = index;
  }
  if (scope !== "visual") payload.spoken = await spokenResults(editor, query, limit, restrict);
  return ok(jsonString(roundJSONFloatingPointNumbers(payload, 3)));
}

type Status = "disabled" | "indexing" | "ready" | "modelNotInstalled" | "downloadingModel" | "preparing" | "failed";

function visualStatus(index: SearchIndexCoordinator): Status {
  const { model } = index;
  if (!model.enabled()) return "disabled";
  switch (model.state().kind) {
    case "ready": return index.indexingActive ? "indexing" : "ready";
    case "notInstalled": return "modelNotInstalled";
    case "downloading": return "downloadingModel";
    case "failed": return "failed";
    default: return "preparing";
  }
}

/** Index health rides along only while it can explain missing results. */
async function visualResults(
  editor: Editor, index: SearchIndexCoordinator, query: string, limit: number, restrict: ReadonlySet<string> | undefined,
): Promise<{ moments: Json[]; index?: Json }> {
  const { model } = index;
  const indexable = editor.mediaAssets.filter((a) => (a.type === "video" || a.type === "image") && (restrict?.has(a.id) ?? true));
  if (indexable.length > 0 && model.enabled() && model.state().kind === "unknown") await model.prepare();
  if (indexable.length > 0 && model.enabled() && model.state().kind === "notInstalled") void model.download();

  const status = visualStatus(index);
  const indexed = model.embedder() ? await index.indexedCount(indexable) : undefined;
  let health: Json | undefined;
  if (indexable.length > 0 && (status !== "ready" || (indexed ?? indexable.length) < indexable.length)) {
    health = { status, indexableAssets: indexable.length };
    if (indexed !== undefined) health.indexedAssets = indexed;
    const state = model.state();
    if (state.kind === "downloading") health.modelDownloadProgress = model.downloadProgress();
    if (state.kind === "failed") health.modelDownloadError = state.reason;
  }

  const hits = await index.search(query, limit, restrict);
  const moments = hits.map((hit): Json => {
    const asset = editor.mediaAssets.find((a) => a.id === hit.assetID);
    const entry: Json = { mediaRef: hit.assetID, name: asset?.name ?? "", score: hit.score };
    if (asset?.type === "image") entry.type = "image";
    else {
      entry.startSeconds = hit.shotStart;
      entry.endSeconds = hit.shotEnd;
    }
    return entry;
  });
  return health ? { moments, index: health } : { moments };
}

async function spokenResults(editor: Editor, query: string, limit: number, restrict: ReadonlySet<string> | undefined): Promise<Json[]> {
  const candidates = editor.mediaAssets
    .filter((a) => (a.type === "video" || a.type === "audio") && (restrict?.has(a.id) ?? true))
    .map((a) => ({ id: a.id, url: a.url }));
  const hits = await searchTranscripts(query, candidates, limit);
  return hits.map((hit) => ({
    mediaRef: hit.assetID,
    name: editor.mediaAssets.find((a) => a.id === hit.assetID)?.name ?? "",
    startSeconds: hit.start,
    endSeconds: hit.end,
    text: hit.text,
  }));
}
