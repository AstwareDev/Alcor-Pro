import { describe, expect, it } from "vitest";
import { effectCanonicalOrder, makeEffect, makeEffectParam, makeStaticEffect } from "../../model/effect";
import {
  effectDescriptor, effectDescriptorMakeEffect, effectDescriptorResolve, effectRegistryAll,
} from "./effectRegistry";

describe("EffectRegistry", () => {
  it("registryDescriptorsHaveUniqueIdsAndValidDefaults", () => {
    const seen = new Set<string>();
    for (const d of effectRegistryAll) {
      expect(seen.has(d.id), `duplicate id ${d.id}`).toBe(false);
      seen.add(d.id);
      for (const s of d.params) {
        expect(s.defaultValue >= s.min && s.defaultValue <= s.max, `${d.id}.${s.key} default outside range`).toBe(true);
      }
    }
  });

  it("covers exactly the canonical order ids", () => {
    expect([...effectRegistryAll.map((d) => d.id)].sort()).toEqual([...effectCanonicalOrder].sort());
  });

  it("keeps Swift registry ordering and metadata", () => {
    expect(effectRegistryAll.map((d) => d.id)).toEqual([
      "color.exposure", "color.contrast", "color.saturation", "color.temperature", "color.highlightsShadows",
      "color.blacksWhites", "color.vibrance", "color.wheels", "color.hueCurves", "color.lut", "color.curves",
      "detail.clarity", "blur.gaussian", "blur.sharpen", "blur.noiseReduction", "blur.motion", "stylize.invert",
      "stylize.grain", "stylize.vignette", "stylize.glow", "key.chroma",
    ]);
    expect(effectDescriptor("color.exposure")?.linearizes).toBe(true);
    expect(effectDescriptor("color.lut")?.resourceKey).toBe("path");
    expect(effectDescriptor("color.temperature")?.params.map((s) => [s.min, s.max, s.defaultValue])).toEqual([
      [2000, 11000, 6500], [-100, 100, 0],
    ]);
    expect(effectDescriptor("key.chroma")?.params[0]?.defaultValue).toBe(0.333);
    expect(effectDescriptor("future.hologram")).toBeUndefined();
  });

  it("makeEffect fills defaults", () => {
    const e = effectDescriptorMakeEffect(effectDescriptor("blur.gaussian")!);
    expect(e.type).toBe("blur.gaussian");
    expect(e.params["radius"]?.value).toBe(8);
  });

  it("resolve clamps to range, falls back to default, and carries strings", () => {
    const d = effectDescriptor("color.exposure")!;
    expect(effectDescriptorResolve(d, makeStaticEffect("color.exposure", { ev: 9 }), 0).values["ev"]).toBe(3);
    expect(effectDescriptorResolve(d, makeEffect({ type: "color.exposure" }), 0).values["ev"]).toBe(0);
    const lut = makeEffect({ type: "color.lut", params: { path: makeEffectParam({ string: "/a.cube" }) } });
    const r = effectDescriptorResolve(effectDescriptor("color.lut")!, lut, 7, 2);
    expect(r.strings["path"]).toBe("/a.cube");
    expect(r.values["intensity"]).toBe(1);
    expect(r.frame).toBe(7);
    expect(r.spatialScale).toBe(2);
  });
});
