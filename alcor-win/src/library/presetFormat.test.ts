import { describe, expect, it } from "vitest";
import { effectDescriptor } from "../preview/effects/effectRegistry";
import { builtinAnimations, builtinEffects, builtinLooks, builtinPresets, builtinTextStyles, builtinTitles } from "./builtin";
import { decodePreset, decodePresetDocument, encodePresetDocument, presetFormatVersion } from "./presetFormat";

describe("built-in content", () => {
  it("meets the content targets", () => {
    expect(builtinLooks.length).toBeGreaterThanOrEqual(40);
    expect(builtinTextStyles.length).toBeGreaterThanOrEqual(20);
    expect(builtinAnimations.length).toBeGreaterThanOrEqual(10);
    expect(builtinTitles.length).toBeGreaterThanOrEqual(12);
    expect(builtinEffects.length).toBeGreaterThanOrEqual(10);
  });

  it("has unique ids and names within a kind", () => {
    expect(new Set(builtinPresets.map((p) => p.id)).size).toBe(builtinPresets.length);
    for (const kind of ["look", "effect", "textStyle", "textAnimation", "title"] as const) {
      const names = builtinPresets.filter((p) => p.kind === kind).map((p) => p.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it("only uses registered effects and in-range parameters", () => {
    for (const preset of [...builtinLooks, ...builtinEffects]) {
      for (const e of preset.effects) {
        const d = effectDescriptor(e.type);
        expect(d, `${preset.id} ${e.type}`).toBeDefined();
        for (const [key, value] of Object.entries(e.params)) {
          const spec = d?.params.find((s) => s.key === key);
          expect(spec, `${preset.id} ${e.type}.${key}`).toBeDefined();
          expect(value).toBeGreaterThanOrEqual(spec?.min ?? 0);
          expect(value).toBeLessThanOrEqual(spec?.max ?? 0);
        }
      }
    }
  });

  it("looks are distinct from each other", () => {
    const signatures = builtinLooks.map((l) => JSON.stringify(l.effects));
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("round-trips through JSON without warnings", () => {
    const json: unknown = JSON.parse(JSON.stringify(encodePresetDocument(builtinPresets)));
    const result = decodePresetDocument(json);
    expect(result.warnings).toEqual([]);
    expect(result.presets).toHaveLength(builtinPresets.length);
    expect(result.presets).toEqual(builtinPresets);
  });
});

describe("preset decoding", () => {
  const doc = (presets: unknown[], extra: Record<string, unknown> = {}): unknown => ({ format: "alcor-preset", version: 1, presets, ...extra });

  it("skips unknown effects and parameters with warnings", () => {
    const r = decodePresetDocument(doc([
      { id: "a", name: "A", kind: "look", effects: [{ type: "color.saturation", params: { amount: 5, nope: 1 } }, { type: "bogus.fx" }] },
    ]));
    expect(r.presets).toHaveLength(1);
    expect(r.presets[0]).toMatchObject({ effects: [{ type: "color.saturation", params: { amount: 2 } }] });
    expect(r.warnings.some((w) => w.includes("bogus.fx"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("nope"))).toBe(true);
  });

  it("drops presets that are unusable but keeps the rest", () => {
    const r = decodePresetDocument(doc([
      { id: "x", name: "X", kind: "look", effects: [{ type: "bogus" }] },
      { id: "y", name: "Y", kind: "mystery" },
      { id: "z", name: "Z", kind: "textAnimation", animation: { preset: "popIn" } },
      { id: "z", name: "Z2", kind: "textAnimation", animation: { preset: "popIn" } },
      { id: "w", name: "W", kind: "textAnimation", animation: { preset: "spin" } },
    ]));
    expect(r.presets.map((p) => p.id)).toEqual(["z"]);
    expect(r.warnings).toHaveLength(6);
  });

  it("rejects a wrong or newer envelope", () => {
    expect(() => decodePresetDocument({ format: "other", version: 1, presets: [] })).toThrow();
    expect(() => decodePresetDocument(doc([], { version: presetFormatVersion + 1 }))).toThrow(/newer/);
    expect(() => decodePresetDocument(doc([], { version: 0 }))).toThrow();
    expect(() => decodePresetDocument({ format: "alcor-preset", version: 1 })).toThrow();
  });

  it("decodes text styles leniently and titles with defaults", () => {
    const style = decodePreset({ id: "s", name: "S", kind: "textStyle", style: { fontName: "Impact" }, fillMode: "footage" });
    expect(style).toMatchObject({ kind: "textStyle", fillMode: "footage", style: { fontName: "Impact", fontSize: 96 } });
    const title = decodePreset({ id: "t", name: "T", kind: "title", items: [{ text: "Hi", box: { centerX: 2, centerY: 0.3 } }] });
    expect(title).toMatchObject({ kind: "title", durationSeconds: 4, items: [{ text: "Hi", layer: 0, box: { centerX: 1, centerY: 0.3 } }] });
  });

  it("keeps a LUT resource only on effects that take a file", () => {
    const r = decodePresetDocument(doc([
      { id: "l", name: "L", kind: "look", effects: [{ type: "color.lut", params: { intensity: 0.5 }, resource: "pack/a.cube" }, { type: "color.contrast", resource: "x" }] },
    ]));
    expect(r.presets[0]).toMatchObject({ effects: [{ type: "color.lut", resource: "pack/a.cube" }, { type: "color.contrast" }] });
    expect("resource" in ((r.presets[0] as { effects: object[] }).effects[1] ?? {})).toBe(false);
  });
});
