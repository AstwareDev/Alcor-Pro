import { sub } from "./e2lib.mjs";
const a = "src/export/audioMixer.ts";
sub(a, `  /** Source seconds per timeline second. */
  rate: number;
}`, `  /** Source seconds per timeline second. */
  rate: number;
  /** Speed ramps: source seconds at \`startFrame + i\` (one extra trailing value), replacing the constant \`rate\`. */
  sourceTimes?: number[];
}`);
sub(a, `import { audioEnvelopeGain,`, `import { clipHasSpeedRamp } from "../model/speedRamp";
import { audioEnvelopeGain,`);
sub(a, `  const open = new Map<string, { seg: AudioSegment; last: number; tail: number }>();
  const done: AudioSegment[] = [];
  const close = (key: string): void => {
    const o = open.get(key);
    if (!o) return;
    o.seg.gains.push(o.tail);`, `  const open = new Map<string, { seg: AudioSegment; last: number; tail: number; tailSource: number }>();
  const done: AudioSegment[] = [];
  const fps = doc.timelines.find((t) => t.id === timelineId)?.fps ?? 30;
  const close = (key: string): void => {
    const o = open.get(key);
    if (!o) return;
    o.seg.gains.push(o.tail);
    o.seg.sourceTimes?.push(o.tailSource);`);
sub(a, `        o.seg.gains.push(src.gain);
        o.last = f;
        o.tail = tail;
        continue;`, `        o.seg.gains.push(src.gain);
        o.seg.sourceTimes?.push(src.sourceTime);
        o.last = f;
        o.tail = tail;
        o.tailSource = src.sourceTime + src.sourceRate / fps;
        continue;`);
sub(a, `      open.set(src.key, {
        seg: { key: src.key, mediaRef: src.mediaRef, startFrame: f, gains: [src.gain], sourceTime0: src.sourceTime, rate: src.sourceRate },
        last: f,
        tail,
      });`, `      const seg: AudioSegment = { key: src.key, mediaRef: src.mediaRef, startFrame: f, gains: [src.gain], sourceTime0: src.sourceTime, rate: src.sourceRate };
      if (clipHasSpeedRamp(src.clip)) seg.sourceTimes = [src.sourceTime];
      open.set(src.key, { seg, last: f, tail, tailSource: src.sourceTime + src.sourceRate / fps });`);
sub(a, `      const srcAt = (s: number): number => seg.sourceTime0 + ((s - segStart) / sr) * seg.rate;`, `      const times = seg.sourceTimes;
      const srcAt = (s: number): number => {
        if (!times) return seg.sourceTime0 + ((s - segStart) / sr) * seg.rate;
        const p = ((s - segStart) / sr) * fps;
        const i = Math.max(0, Math.min(Math.floor(p), times.length - 2));
        const t0 = times[i] as number;
        return t0 + ((times[i + 1] as number) - t0) * (p - i);
      };`);
