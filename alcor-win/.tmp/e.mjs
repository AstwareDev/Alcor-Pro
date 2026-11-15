import fs from "fs";
function sub(p, a, b) { let s = fs.readFileSync(p, "utf8"); const crlf = s.includes("\r\n"); if (crlf) s = s.replace(/\r\n/g, "\n"); if (!s.includes(a)) throw new Error("missing in " + p + ": " + a.slice(0,50)); s = s.replace(a, () => b); if (crlf) s = s.replace(/\n/g, "\r\n"); fs.writeFileSync(p, s); }
const k = "src/editor/mutations/keyframes.ts";
sub(k, `const interp = (track.keyframes[idx] as { interpolationOut: Interpolation }).interpolationOut;
    track.keyframes.splice(idx, 1);
    keyframeTrackUpsert(track, makeKeyframe(toOffset, newDb, interp));`, `const old = track.keyframes[idx] as { interpolationOut: Interpolation; bezier?: BezierHandles };
    track.keyframes.splice(idx, 1);
    keyframeTrackUpsert(track, makeKeyframe(toOffset, newDb, old.interpolationOut, old.bezier));`);
sub(k, `  type FadeEdge,
  type Interpolation,`, `  type BezierHandles,
  type FadeEdge,
  type Interpolation,`);
sub(k, `  interpolation: Interpolation,
): void {
  commitClipProperty(editor, clipId, (clip) => clipSetInterpolation(clip, property, frame, interpolation), "Change Interpolation");`, `  interpolation: Interpolation,
  bezier?: BezierHandles,
): void {
  commitClipProperty(editor, clipId, (clip) => clipSetInterpolation(clip, property, frame, interpolation, bezier), "Change Interpolation");`);
const f = "src/preview/frameGraph.ts";
sub(f, `if (a.interpolationOut === "smooth") for (const o of smoothSubdivisions(a.frame, b.frame)) set.add(o);
      else if (a.interpolationOut === "hold"`, `if (a.interpolationOut !== "linear" && a.interpolationOut !== "hold") for (const o of smoothSubdivisions(a.frame, b.frame)) set.add(o);
      else if (a.interpolationOut === "hold"`);
