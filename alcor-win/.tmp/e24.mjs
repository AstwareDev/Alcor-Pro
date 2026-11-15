import fs from "fs";
const p = "src/agent/tools/definitions/clipsDefinitions.ts";
let s = fs.readFileSync(p, "utf8");
const a = s.indexOf('name: "set_speed_ramp",');
const inp = s.indexOf("inputSchema:", a);
const desc = [
  "Time-remap one clip with a speed ramp (variable speed) in one undoable action. The clip keeps its timeline length; source time is the integral of the speed curve, so a preset slows and speeds the same source range. Pass either 'preset' or 'keyframes'.",
  "'preset' is one of: none (remove the ramp), montage (fast-slow-fast), hero (normal, dramatic slow-mo, normal), bullet (extreme slow-mo with fast ends), flashIn (very fast start settling to normal), flashOut (normal ending in a fast flash), smoothSlowMo (eased dip into slow-mo). Presets are scaled so the clip's average speed stays what it is now.",
  "'keyframes' rows are [frame, speed, interp?, bezier?] with CLIP-RELATIVE frames (0 = first frame, below the clip length), speed 0.05-20 (1 = normal), interp in {linear, hold, smooth, easeIn, easeOut, easeInOut, bezier} for the segment leaving that keyframe, and a [x1, y1, x2, y2] curve for 'bezier'. An empty array removes the ramp. The clip's speed becomes the ramp's average and trimEndFrame is adjusted to keep the same total source range. Linked audio/video partners are ramped together; preview audio keeps its pitch, exports follow the speed (varispeed).",
  "'frameBlending' mixes adjacent source frames when slower than 1x (applied in export) and can be set alone. Refused on multicam clips. A later set_clip_properties speed change rescales the ramp proportionally.",
].join("\n\n");
s = s.slice(0, a) + 'name: "set_speed_ramp",\n            description: ' + JSON.stringify(desc) + ",\n            " + s.slice(inp);
fs.writeFileSync(p, s);
