import { transitionAlignments, transitionKinds } from "../../../model/transition";
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";

const kind = { type: "string", enum: [...transitionKinds], description: "Default crossDissolve." };
const alignment = {
  type: "string",
  enum: [...transitionAlignments],
  description: "center straddles the cut (default); start begins at the cut; end finishes at the cut. Clips without trimmed handles hold their edge frame.",
};
const durationSeconds = { type: "number", description: "Length in seconds. Default 0.5. Clamped to what both clips can host (each gives at most half its length)." };
const durationFrames = { type: "integer", description: "Length in frames; used instead of durationSeconds." };
const clipId = { type: "string", description: "The outgoing clip. The transition sits at its end, on the cut with the clip that starts exactly there on the same track." };
const transitionId = { type: "string", description: "Transition id from add_transition, instead of clipId." };

export const transitionDefinitions: ToolDefinition[] = [
  {
    name: "add_transition",
    description: "Add a transition at the cut between two adjacent clips on one video track (no gap or overlap). The linked audio of both clips crossfades over the same span. Default is a 0.5 s cross dissolve. Kinds: crossDissolve, dipToBlack, dipToWhite, wipeLeft/Right/Up/Down, pushLeft/Right/Up/Down, zoomIn, blurDissolve, irisCircle. Undoable.",
    inputSchema: objectSchema({ properties: { clipId, kind, durationSeconds, durationFrames, alignment }, required: ["clipId"] }),
  },
  {
    name: "update_transition",
    description: "Change the kind, duration or alignment of an existing transition, addressed by the outgoing `clipId` or by `transitionId`. Undoable.",
    inputSchema: objectSchema({ properties: { clipId, transitionId, kind, durationSeconds, durationFrames, alignment } }),
  },
  {
    name: "remove_transition",
    description: "Remove a transition, addressed by the outgoing `clipId` or by `transitionId`. Undoable.",
    inputSchema: objectSchema({ properties: { clipId, transitionId } }),
  },
  {
    name: "add_adjustment_layer",
    description: "Add an adjustment layer: a clip with no media whose effects, opacity and masks apply to the composite of every track below it for its time span. Add effects afterwards with apply_effect / apply_color on the returned clipId and limit the area with add_mask. Placed on a new track above all others unless `trackIndex` names a free video track. Undoable.",
    inputSchema: objectSchema({
      properties: {
        startFrame: { type: "integer", description: "Timeline frame. Default: the playhead." },
        durationSeconds: { type: "number", description: "Default 5 seconds." },
        durationFrames: { type: "integer", description: "Used instead of durationSeconds." },
        trackIndex: { type: "integer", description: "Existing video track index from get_timeline; it must be free over the span." },
      },
    }),
  },
];
