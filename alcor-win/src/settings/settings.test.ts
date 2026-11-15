import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../platform/backend", () => ({ secretListPresent: vi.fn(), secretSet: vi.fn(), secretDelete: vi.fn(), httpFetch: vi.fn(), httpCancel: vi.fn() }));

import * as backend from "../platform/backend";
import { providersWithKeys } from "../generation/providers/registry";
import { makeAppearanceStore, parseAppearance, resolveTheme } from "./appearance";
import { refreshProviderKeys } from "./keys";
import { makeModelPreferences } from "./modelPreferences";
import { memoryStorage } from "./storage";

describe("refreshProviderKeys", () => {
  it("fills providersWithKeys from the credential store", async () => {
    vi.mocked(backend.secretListPresent).mockResolvedValue(["fal", "openai"]);
    await refreshProviderKeys();
    expect([...providersWithKeys()].sort()).toEqual(["fal", "openai"]);
    expect(backend.secretListPresent).toHaveBeenCalledWith(expect.arrayContaining(["fal", "elevenlabs", "openai", "google", "replicate"]));
  });
});

describe("model preferences", () => {
  it("persists disabled ids and defaults", () => {
    const storage = memoryStorage();
    createRoot((dispose) => {
      const prefs = makeModelPreferences(storage);
      expect(prefs.isEnabled("fal/x")).toBe(true);
      prefs.setEnabled("fal/x", false);
      prefs.setDefaultModel("video", "fal/kling/v4");
      expect(JSON.parse(storage.getItem("disabledModelIds") ?? "[]")).toEqual(["fal/x"]);
      const again = makeModelPreferences(storage);
      expect(again.isEnabled("fal/x")).toBe(false);
      expect(again.defaultModel("video")).toBe("fal/kling/v4");
      again.setEnabled("fal/x", true);
      again.setDefaultModel("video", undefined);
      expect(storage.getItem("disabledModelIds")).toBe("[]");
      expect(storage.getItem("defaultModel.video")).toBeNull();
      dispose();
    });
  });
});

describe("appearance", () => {
  it("resolves system against the OS preference and stores the choice", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(parseAppearance("bogus")).toBe("dark");
    const attrs = new Map<string, string>();
    const storage = memoryStorage();
    createRoot((dispose) => {
      const store = makeAppearanceStore(storage, { setAttribute: (k, v) => void attrs.set(k, v) });
      expect(attrs.get("data-theme")).toBe("dark");
      store.set("light");
      expect(attrs.get("data-theme")).toBe("light");
      expect(storage.getItem("appearance")).toBe("light");
      dispose();
    });
  });
});
