import { describe, expect, it } from "vitest";
import { maxLagHops } from "./multicamEngine";

// The editor-dependent MulticamEngineTests live in src/editor/mutations/multicam.test.ts.
describe("Multicam", () => {
  it("lagSearchKeepsHalfOverlap", () => {
    // 3:35 files (~21500 hops) with a 240s window: without the clamp, +-220s lags
    // with seconds of overlap were legal - the false-peak that doubled a group's length.
    expect(maxLagHops(240, 0.01, 21500, 21500)).toBe(10750);
    expect(maxLagHops(240, 0.01, 54000, 54000)).toBe(24000);
    expect(maxLagHops(240, 0.01, 0, 100)).toBe(1);
  });
});
