import { describe, expect, it } from "vitest";
import { seededCorrelate } from "../../audio/audioSyncCorrelator";
import type { SourceTiming, SyncServices } from "../../audio/sourceTiming";
import { envelopeHopSeconds } from "../../media/peaks";
import { syncMulticamMembers } from "./multicam";

// syncMulticamMembers (EditorViewModel+Multicam.swift "Source sync") over synthetic envelopes.

function noise(count: number, seed: number): Float32Array {
  let state = BigInt(seed);
  const mask = (1n << 64n) - 1n;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & mask;
    out[i] = Number((state >> 33n) % 1000n) / 1000;
  }
  return out;
}

function services(envelopes: Record<string, Float32Array>, timings: Record<string, SourceTiming> = {}): SyncServices {
  return {
    envelope: async (ref) => (envelopes[ref] ? { hopSeconds: envelopeHopSeconds, samples: envelopes[ref] } : null),
    timing: async (ref) => timings[ref] ?? {},
    correlate: (params, signal) => seededCorrelate(params, signal),
  };
}

const master = noise(12_000, 5);

describe("syncMulticamMembers", () => {
  it("pinsOffsetsAndMarksMasterWithoutDecoding", async () => {
    const outcome = await syncMulticamMembers(services({}), {
      masterRef: "mic",
      specs: [
        { mediaRef: "mic", kind: "mic" },
        { mediaRef: "cam", kind: "angle", pinnedOffsetSeconds: 5 },
      ],
      rebase: false,
    });
    expect(outcome.maps.get("mic")).toEqual({ offsetSeconds: 0, confidence: 1, locked: false });
    expect(outcome.maps.get("cam")).toEqual({ offsetSeconds: 5, confidence: 1, locked: true });
    expect(outcome.failures).toEqual([]);
  });

  it("correlatesMembersAgainstMasterAndRebasesToEarliest", async () => {
    // cam started 3 s before the master (its audio holds master[0...] at hop 1200): lag = -1200 hops = -3 s.
    const cam = new Float32Array(10_000);
    cam.set(noise(1_200, 6), 0);
    cam.set(master.slice(0, 8_800), 1_200);
    const outcome = await syncMulticamMembers(services({ mic: master, cam }), {
      masterRef: "mic",
      specs: [
        { mediaRef: "mic", kind: "mic" },
        { mediaRef: "cam", kind: "angle" },
      ],
    });
    const camMap = outcome.maps.get("cam");
    const micMap = outcome.maps.get("mic");
    expect(outcome.failures).toEqual([]);
    expect(camMap?.offsetSeconds).toBeCloseTo(0, 3);
    expect(micMap?.offsetSeconds).toBeCloseTo(3, 2);
    expect(camMap?.confidence ?? 0).toBeGreaterThan(0.5);
  });

  it("reportsUnsyncedMembersAndMissingMasterAudio", async () => {
    const unmatched = await syncMulticamMembers(services({ mic: master, cam: noise(10_000, 123) }), {
      masterRef: "mic",
      specs: [
        { mediaRef: "mic", kind: "mic" },
        { mediaRef: "cam", kind: "angle" },
      ],
    });
    expect(unmatched.maps.get("cam")).toEqual({ offsetSeconds: 0, confidence: 0, locked: false });
    expect(unmatched.failures[0]?.reason).toContain("No confident alignment");

    const noMaster = await syncMulticamMembers(services({ cam: master }), {
      masterRef: "mic",
      specs: [
        { mediaRef: "mic", kind: "mic" },
        { mediaRef: "cam", kind: "angle" },
      ],
    });
    expect(noMaster.failures.map((f) => f.reason)).toEqual(["Master has no readable audio.", "No audio to sync with and no shared timecode."]);
  });

  it("fallsBackToSharedTimecodeWhenAudioIsUnreadable", async () => {
    const outcome = await syncMulticamMembers(
      services({ mic: master }, { mic: { timecode: { seconds: 100 } }, cam: { timecode: { seconds: 107.5 } } }),
      {
        masterRef: "mic",
        specs: [
          { mediaRef: "mic", kind: "mic" },
          { mediaRef: "cam", kind: "angle" },
        ],
        rebase: false,
      },
    );
    expect(outcome.maps.get("cam")).toEqual({ offsetSeconds: 7.5, confidence: 1, locked: false });
    expect(outcome.failures).toEqual([]);
  });
});
