import type { JsonObject, ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";

const maskModeEnum = ["add", "subtract", "intersect", "difference"];
const propertyEnum = ["path", "feather", "opacity", "expansion"];

const pointSchema: JsonObject = {
  type: "object",
  properties: {
    x: { type: "number", description: "Vertex x, 0 = left edge of the clip, 1 = right edge." },
    y: { type: "number", description: "Vertex y, 0 = top edge of the clip, 1 = bottom edge." },
    inX: { type: "number", description: "Incoming bezier handle x offset from the vertex. Default 0 (corner)." },
    inY: { type: "number", description: "Incoming bezier handle y offset from the vertex. Default 0." },
    outX: { type: "number", description: "Outgoing bezier handle x offset from the vertex. Default 0." },
    outY: { type: "number", description: "Outgoing bezier handle y offset from the vertex. Default 0." },
  },
  required: ["x", "y"],
};

const pointsProperty: JsonObject = {
  type: "array",
  items: pointSchema,
  description: "Bezier vertices in the clip's own normalized space (0,0 top-left, 1,1 bottom-right), so the mask follows the clip's transform and crop. At least 3 are needed for the mask to have any effect.",
};

export const maskDefinitions: ToolDefinition[] = [
  {
    name: "add_mask",
    description: "Add an After Effects-style mask to a video, image or text clip. A mask limits where the clip is visible; several masks on one clip combine bottom to top by `mode`. Geometry is in the clip's own normalized space (0,0 top-left, 1,1 bottom-right), so masks move, scale and rotate with the clip. Use `shape` rectangle/ellipse with `rect` (default: centered, 60% of the clip) or `shape` path with `points`. `feather` and `expansion` are in pixels at timeline resolution. Returns the clip's masks with their ids. Undoable.",
    inputSchema: objectSchema({
      properties: {
        clipId: { type: "string", description: "Clip id from get_timeline." },
        shape: { type: "string", enum: ["rectangle", "ellipse", "path"], description: "rectangle and ellipse are editable like paths; path needs `points`." },
        rect: {
          type: "object",
          description: "rectangle/ellipse bounds in the clip's normalized space.",
          properties: {
            x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
        },
        points: pointsProperty,
        closed: { type: "boolean", description: "path only. Default true; an open path has no effect on the picture." },
        name: { type: "string", description: "Display name. Default 'Rectangle 1', 'Ellipse 2', …" },
        mode: { type: "string", enum: maskModeEnum, description: "How this mask combines with the masks below it. Default add. A leading subtract starts from a full picture." },
        inverted: { type: "boolean", description: "Swap inside and outside. Default false." },
        feather: { type: "number", description: "Edge blur in pixels at timeline resolution, 0…1000. Default 0." },
        expansion: { type: "number", description: "Grow (positive) or shrink (negative) the shape in pixels, -1000…1000. Default 0." },
        opacity: { type: "number", description: "0…1. Default 1." },
      },
      required: ["clipId", "shape"],
    }),
  },
  {
    name: "update_mask",
    description: "Edit a mask on a clip: rename, change mode, invert, feather, expansion, opacity, path (`points`, `closed`), move it in the stack (`order`), or animate it with `keyframes`. Static fields set the base value and are refused for a property that already has keyframes (use `keyframes` for those). `keyframes` entries stamp a keyframe at an absolute timeline `frame` inside the clip with a `value` (number) or, for `path`, `points`. Path keyframes interpolate per vertex when vertex counts match, otherwise they hold. Undoable as one step.",
    inputSchema: objectSchema({
      properties: {
        clipId: { type: "string", description: "Clip id from get_timeline." },
        maskId: { type: "string", description: "Mask id from add_mask / update_mask output." },
        name: { type: "string" },
        mode: { type: "string", enum: maskModeEnum },
        inverted: { type: "boolean" },
        feather: { type: "number", description: "Pixels at timeline resolution, 0…1000." },
        expansion: { type: "number", description: "Pixels, -1000…1000." },
        opacity: { type: "number", description: "0…1." },
        points: pointsProperty,
        closed: { type: "boolean", description: "With or without `points`; applies to the base path." },
        order: { type: "integer", description: "New position in the stack, 0 = bottom (applied first)." },
        keyframes: {
          type: "array",
          description: "Keyframes to stamp.",
          items: {
            type: "object",
            properties: {
              property: { type: "string", enum: propertyEnum },
              frame: { type: "integer", description: "Absolute timeline frame within the clip." },
              value: { type: "number", description: "feather / opacity / expansion value." },
              points: pointsProperty,
              interpolation: { type: "string", enum: ["linear", "hold", "smooth", "easeIn", "easeOut", "easeInOut"], description: "Interpolation leaving this keyframe. Default smooth." },
            },
            required: ["property", "frame"],
          },
        },
      },
      required: ["clipId", "maskId"],
    }),
  },
  {
    name: "remove_mask",
    description: "Delete a mask from a clip, or with `keyframes` only delete mask keyframes: an entry with `frame` removes that keyframe, an entry without `frame` removes every keyframe of that property (the base value is kept). Undoable.",
    inputSchema: objectSchema({
      properties: {
        clipId: { type: "string", description: "Clip id from get_timeline." },
        maskId: { type: "string", description: "Mask id from add_mask / update_mask output." },
        keyframes: {
          type: "array",
          description: "When given, the mask itself is kept and only these keyframes are removed.",
          items: {
            type: "object",
            properties: {
              property: { type: "string", enum: propertyEnum },
              frame: { type: "integer", description: "Absolute timeline frame. Omit to remove all keyframes of the property." },
            },
            required: ["property"],
          },
        },
      },
      required: ["clipId", "maskId"],
    }),
  },
];
