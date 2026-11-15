import { describe, expect, it } from "vitest";
import { shortcutTable } from "../timeline/view/shortcuts";
import { formatCombo, shortcutGroups } from "./shortcutsList";

const all = () => shortcutGroups().flatMap((g) => g.rows.map((r) => ({ group: g.title, ...r })));

describe("shortcuts list", () => {
  it("lists the new bindings from the live table", () => {
    const rows = all();
    expect(rows).toContainEqual({ group: "Editing", keys: "Ctrl + T", label: "Add Transition at Playhead" });
    expect(rows).toContainEqual({ group: "Editing", keys: "F9", label: "Easy Ease Selected Keyframes" });
    expect(rows).toContainEqual({ group: "Editing", keys: "Ctrl + K", label: "Split at Playhead" });
    expect(rows.find((r) => r.label === "Focus Prompt Bar")?.keys).toBe("/");
  });

  it("joins alternate keys and skips numpad duplicates", () => {
    const rows = all();
    expect(rows.find((r) => r.label === "Trim Start to Playhead")?.keys).toBe("Q or [");
    expect(rows.find((r) => r.label === "Zoom In")?.keys).toBe("Ctrl + =");
  });

  it("lists every command in the table exactly once", () => {
    const labels = all().map((r) => r.label);
    expect(new Set(labels.filter((l) => l !== "Delete" && l !== "Select All")).size).toBe(labels.filter((l) => l !== "Delete" && l !== "Select All").length);
    for (const b of shortcutTable) {
      if (b.combo.code.startsWith("Numpad")) continue;
      expect(all().some((r) => r.keys.split(" or ").includes(formatCombo(b.combo)))).toBe(true);
    }
  });
});
