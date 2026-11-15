import { describe, expect, it } from "vitest";
import { AudioMeterChannelState, AudioMeterHub, activeSegmentCount, amplitudeToDb, meterBand, meterLayout, segmentY } from "./audioMeter";

describe("audio meter", () => {
  it("converts amplitude to dB with a -60 floor", () => {
    expect(amplitudeToDb(1)).toBe(0);
    expect(amplitudeToDb(0)).toBe(-60);
    expect(amplitudeToDb(1e-6)).toBe(-60);
    expect(amplitudeToDb(0.5)).toBeCloseTo(-6.02, 1);
  });

  it("decays level at 24 dB/s and holds the peak 1.5 s then 18 dB/s", () => {
    const c = new AudioMeterChannelState();
    c.ingest(1, 10);
    expect(c.display(10).levelDb).toBe(0);
    expect(c.display(10.5).levelDb).toBeCloseTo(-12);
    expect(c.display(11.5).peakDb).toBe(0);
    expect(c.display(12.5).peakDb).toBeCloseTo(-18);
    expect(c.display(100).levelDb).toBe(-60);
  });

  it("latches clipping until reset", () => {
    const hub = new AudioMeterHub();
    hub.ingest(1, 0.2, 1);
    expect(hub.left.display(5).clipped).toBe(true);
    expect(hub.right.display(5).clipped).toBe(false);
    hub.resetClipping();
    expect(hub.left.display(5).clipped).toBe(false);
  });

  it("settles after decaying to the floor", () => {
    const hub = new AudioMeterHub();
    hub.ingest(1, 1, 0);
    expect(hub.settled(0.1)).toBe(false);
    expect(hub.settled(10)).toBe(true);
  });

  it("lays out 1px segments with 1px gaps", () => {
    const l = meterLayout(101);
    expect(l.count).toBe(51);
    expect(l.segmentHeight).toBe(1);
    expect(segmentY(l, 0)).toBe(100);
    expect(activeSegmentCount(l, -60)).toBe(0);
    expect(activeSegmentCount(l, 0)).toBe(51);
    expect(meterLayout(0).count).toBe(0);
  });

  it("bands at -20 and -6 dB", () => {
    expect(meterBand(-30)).toBe("green");
    expect(meterBand(-20)).toBe("yellow");
    expect(meterBand(-6)).toBe("red");
  });
});
