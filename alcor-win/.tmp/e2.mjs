
export function sub(p, a, b) { let s = fs.readFileSync(p, "utf8"); const crlf = s.includes("\r\n"); if (crlf) s = s.replace(/\r\n/g, "\n"); if (!s.includes(a)) throw new Error("missing in " + p + ": " + a.slice(0,50)); s = s.replace(a, () => b); if (crlf) s = s.replace(/\n/g, "\r\n"); fs.writeFileSync(p, s); }
sub("src/model/clipEffectKeyframes.ts", `  const track = existing ? { keyframes: existing.keyframes.map((k) => ({ ...k })) } : makeKeyframeTrack<number>();
  keyframeTrackUpsert(track, makeKeyframe(frame - clip.startFrame, value));`, `  const track = existing ? cloneKeyframeTrack(existing) : makeKeyframeTrack<number>();
  const prev = track.keyframes.find((k) => k.frame === frame - clip.startFrame);
  keyframeTrackUpsert(track, makeKeyframe(frame - clip.startFrame, value, prev?.interpolationOut, prev?.bezier));`);
sub("src/model/clipEffectKeyframes.ts", `  doubleInterpolator, keyframeTrackIsActive,`, `  cloneKeyframeTrack, doubleInterpolator, keyframeTrackIsActive,`);
sub("src/model/keyframe.ts", `  keyframeTrackUpsert(t, makeKeyframe(toOffset(clip, frame), value));`, `  const offset = toOffset(clip, frame);
  const prev = t.keyframes.find((k) => k.frame === offset);
  // Editing a value at an existing keyframe keeps its easing.
  keyframeTrackUpsert(t, makeKeyframe(offset, value, prev?.interpolationOut, prev?.bezier));`);
