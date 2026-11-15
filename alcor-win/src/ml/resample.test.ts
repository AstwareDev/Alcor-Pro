import { describe, expect, it } from "vitest";
import { StreamResampler, resample } from "./resample";

function sine(freq: number, rate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function maxError(a: Float32Array, freq: number, rate: number, skip: number): number {
  let worst = 0;
  for (let i = skip; i < a.length - skip; i++) worst = Math.max(worst, Math.abs((a[i] as number) - Math.sin((2 * Math.PI * freq * i) / rate)));
  return worst;
}

describe("StreamResampler", () => {
  it("preservesASineAcross44100To22050", () => {
    const out = resample(sine(1000, 44100, 1), 44100, 22050);
    expect(out.length).toBe(22050);
    expect(maxError(out, 1000, 22050, 100)).toBeLessThan(0.01);
  });

  it("preservesASineAcross48000To22050AndUp", () => {
    const down = resample(sine(3000, 48000, 1), 48000, 22050);
    expect(down.length).toBe(22050);
    expect(maxError(down, 3000, 22050, 100)).toBeLessThan(0.01);
    const up = resample(sine(500, 22050, 1), 22050, 48000);
    expect(up.length).toBe(48000);
    expect(maxError(up, 500, 48000, 100)).toBeLessThan(0.01);
  });

  it("attenuatesAliasingFrequencies", () => {
    const out = resample(sine(15000, 48000, 0.5), 48000, 22050);
    let peak = 0;
    for (let i = 200; i < out.length - 200; i++) peak = Math.max(peak, Math.abs(out[i] as number));
    expect(peak).toBeLessThan(0.01);
  });

  it("chunkedPushEqualsOneShot", () => {
    const x = sine(700, 44100, 0.7);
    const whole = resample(x, 44100, 22050);
    const r = new StreamResampler(44100, 22050);
    const parts: Float32Array[] = [];
    for (let i = 0; i < x.length; i += 1000) parts.push(r.push(x.subarray(i, Math.min(x.length, i + 1000))));
    parts.push(r.flush());
    const total = parts.reduce((n, p) => n + p.length, 0);
    expect(total).toBe(whole.length);
    const joined = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      joined.set(p, at);
      at += p.length;
    }
    for (let i = 0; i < total; i++) expect(Math.abs((joined[i] as number) - (whole[i] as number))).toBeLessThan(1e-6);
  });

  it("sameRateIsIdentity", () => {
    const x = sine(100, 8000, 0.1);
    expect(resample(x, 8000, 8000)).toBe(x);
  });
});
