import { sub } from "./e2lib.mjs";
const t = "src/agent/tools/speedRampTools.ts";
sub(t, `    // bezier curves are not stored on speed keyframes' preset path; validated for a clear error, then applied.
    kfBezier(raw.length > 3 ? raw[3] : undefined, interpolation, \`keyframes[\${i}][3] (bezier)\`);
    return { frame: kfInt(raw[0], \`keyframes[\${i}][0] (frame)\`), speed: kfDouble(raw[1], \`keyframes[\${i}][1] (speed)\`), interpolation };`, `    const bezier = kfBezier(raw.length > 3 ? raw[3] : undefined, interpolation, \`keyframes[\${i}][3] (bezier)\`);
    const point: SpeedRampPoint = { frame: kfInt(raw[0], \`keyframes[\${i}][0] (frame)\`), speed: kfDouble(raw[1], \`keyframes[\${i}][1] (speed)\`), interpolation };
    if (bezier) point.bezier = bezier;
    return point;`);
const m = "src/editor/mutations/speedRamp.ts";
sub(m, `  interpolation?: Interpolation;
}`, `  interpolation?: Interpolation;
  bezier?: BezierHandles;
}`);
sub(m, `makeKeyframe(p.frame, p.speed, p.interpolation ?? "smooth")`, `makeKeyframe(p.frame, p.speed, p.interpolation ?? "smooth", p.bezier)`);
sub(m, `speedRampPresets, speedRampRange, type Interpolation,`, `speedRampPresets, speedRampRange, type BezierHandles, type Interpolation,`);
// definition + group
const d = "src/agent/tools/definitions/clipsDefinitions.ts";
sub(d, `{
            name: "apply_layout",`, `{
            name: "set_speed_ramp",
            description: "Time-remap one clip with a speed ramp (variable speed) in one undoable action. The clip keeps its timeline length; source time is the integral of the speed curve, so a preset slows and speeds the same source range. Pass either 'preset' or 'keyframes'.\n\n'preset' is one of: none (remove the ramp), montage (fast-slow-fast), hero (normal, dramatic slow-mo, normal), bullet (extreme slow-mo with fast ends), flashIn (very fast start settling to normal), flashOut (normal ending in a fast flash), smoothSlowMo (eased dip into slow-mo). Presets are scaled so the clip's average speed stays what it is now.\n\n'keyframes' rows are \`[frame, speed, interp?, bezier?]\` with CLIP-RELATIVE frames (0 = first frame, below the clip length), speed 0.05-20 (1 = normal), interp ∈ {linear, hold, smooth, easeIn, easeOut, easeInOut, bezier} for the segment leaving that keyframe, and a \`[x1, y1, x2, y2]\` curve for 'bezier'. An empty array removes the ramp. The clip's speed becomes the ramp's average and trimEndFrame is adjusted to keep the same total source range. Linked audio/video partners are ramped together; preview audio keeps its pitch, exports follow the speed (varispeed).\n\n'frameBlending' mixes adjacent source frames when slower than 1x (applied in export) and can be set alone. Refused on multicam clips. A later set_clip_properties speed change rescales the ramp proportionally.",
            inputSchema: objectSchema({
                properties: {
                    "clipId": {"type": "string", "description": "The clip ID."},
                    "preset": {"type": "string", "enum": ["none", "montage", "hero", "bullet", "flashIn", "flashOut", "smoothSlowMo"], "description": "Named ramp. 'none' removes the ramp."},
                    "keyframes": {"type": "array", "description": "Explicit speed keyframes [frame, speed, interp?, bezier?]. Empty array removes the ramp.", "items": {"type": "array"}},
                    "frameBlending": {"type": "boolean", "description": "Blend adjacent frames while slower than 1x (export)."},
                },
                required: ["clipId"]
            })
        },
{
            name: "apply_layout",`);
const g = "src/agent/tools/clipsGroup.ts";
sub(g, `import { applyLayout } from "./layoutTools";`, `import { applyLayout } from "./layoutTools";
import { setSpeedRamp } from "./speedRampTools";`);
sub(g, `  { definition: find("apply_layout"),`, `  { definition: find("set_speed_ramp"), run: setSpeedRamp, publishesTimelineChanges: true },
  { definition: find("apply_layout"),`);
