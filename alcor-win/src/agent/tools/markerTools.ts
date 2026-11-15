import { timelineMarker, changeTimelineMarkers, TimelineMarkerChangeError, type TimelineMarkerChangeReceipt } from "../../timeline/view/timelineMarkerCommands";
import {
  makeTimelineMarker, timelineMarkerDefaultColor, timelineMarkerMaximumCommentLength, timelineMarkerMaximumNameLength,
  timelineMarkerStatuses, type TimelineMarker, type TimelineMarkerStatus,
} from "../../model";
import { ToolError, decodeToolArgs, parseColorHex } from "./toolArgs";
import { jsonString } from "./jsonFormat";
import { timelineMarkerDict } from "./timelinePayload";
import type { ToolContext, ToolArgs } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Markers.swift.

interface ManageMarkersInput {
  action: string;
  markerId?: string;
  name?: string;
  startFrame?: number;
  durationFrames?: number;
  color?: string;
  comment?: string;
  status?: string;
}

export function manageMarkers({ editor }: ToolContext, args: ToolArgs): ToolResult {
  const input = decodeToolArgs<ManageMarkersInput>(args, "manage_markers", {
    action: { spec: "string", required: true },
    markerId: { spec: "string" },
    name: { spec: "string" },
    startFrame: { spec: "int" },
    durationFrames: { spec: "int" },
    color: { spec: "string" },
    comment: { spec: "string" },
    status: { spec: "string" },
  });
  const hasPatch =
    input.name !== undefined || input.startFrame !== undefined || input.durationFrames !== undefined || input.color !== undefined ||
    input.comment !== undefined || input.status !== undefined;
  let status: TimelineMarkerStatus | undefined;
  if (input.status !== undefined) {
    if (!(timelineMarkerStatuses as readonly string[]).includes(input.status)) throw new ToolError("status must be open, review, or resolved.");
    status = input.status as TimelineMarkerStatus;
  }

  let receipt: TimelineMarkerChangeReceipt;
  try {
    switch (input.action) {
      case "create": {
        if (input.name === undefined || input.startFrame === undefined) throw new ToolError("create requires name and startFrame.");
        const marker = makeTimelineMarker({
          name: input.name,
          startFrame: input.startFrame,
          durationFrames: input.durationFrames ?? 0,
          color: parseColorHex(input.color, "color") ?? timelineMarkerDefaultColor(),
          comment: input.comment ?? "",
          status: status ?? "open",
        });
        receipt = changeTimelineMarkers(editor, { creates: [marker], actionName: "Add Marker (Agent)" });
        break;
      }
      case "update": {
        if (input.markerId === undefined || !hasPatch) throw new ToolError("update requires markerId and at least one field to change.");
        const existing = timelineMarker(editor, input.markerId);
        if (!existing) throw new ToolError(`Unknown markerId '${input.markerId}'.`);
        const marker: TimelineMarker = structuredClone(existing);
        if (input.name !== undefined) marker.name = input.name;
        if (input.startFrame !== undefined) marker.startFrame = input.startFrame;
        if (input.durationFrames !== undefined) marker.durationFrames = input.durationFrames;
        const color = parseColorHex(input.color, "color");
        if (color) marker.color = color;
        if (input.comment !== undefined) marker.comment = input.comment;
        if (status) marker.status = status;
        receipt = changeTimelineMarkers(editor, { updates: [marker], actionName: "Change Marker (Agent)" });
        break;
      }
      case "delete": {
        if (input.markerId === undefined) throw new ToolError("delete requires markerId.");
        receipt = changeTimelineMarkers(editor, { deleteIds: [input.markerId], actionName: "Delete Marker (Agent)" });
        break;
      }
      default:
        throw new ToolError("action must be create, update, or delete.");
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    if (e instanceof TimelineMarkerChangeError) {
      if (e.reason === "invalidName") {
        throw new ToolError(`Marker names must be non-empty single lines of at most ${timelineMarkerMaximumNameLength} characters.`);
      }
      if (e.reason === "invalidComment") {
        throw new ToolError(`Marker comments must be at most ${timelineMarkerMaximumCommentLength} characters.`);
      }
    }
    throw new ToolError("Marker frames must be non-negative integer ranges and every ID must exist.");
  }

  const payload: Record<string, unknown> = {};
  if (receipt.created[0]) payload.created = timelineMarkerDict(receipt.created[0]);
  if (receipt.updated[0]) payload.updated = timelineMarkerDict(receipt.updated[0]);
  if (receipt.deletedIds[0] !== undefined) payload.deletedMarkerId = receipt.deletedIds[0];
  if (Object.keys(payload).length === 0) payload.noOp = true;
  return ok(jsonString(payload));
}
