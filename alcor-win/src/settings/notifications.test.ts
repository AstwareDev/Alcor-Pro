import { describe, expect, it } from "vitest";
import { makeNotificationsStore, parseNotificationsEnabled, type NotificationHost } from "./notifications";
import { memoryStorage } from "./storage";

function host(p: Partial<{ permission: NotificationPermission | "unsupported"; focused: boolean }> = {}) {
  const shown: Array<[string, string]> = [];
  let permission = p.permission ?? "granted";
  let requests = 0;
  const h: NotificationHost = {
    permission: () => permission,
    requestPermission: async () => {
      requests += 1;
      permission = "granted";
      return permission;
    },
    windowFocused: () => p.focused ?? false,
    show: (t, b) => void shown.push([t, b]),
  };
  return { h, shown, requests: () => requests };
}

describe("notifications", () => {
  it("defaults to enabled, like the Swift store", () => {
    expect(parseNotificationsEnabled(null)).toBe(true);
    expect(parseNotificationsEnabled("false")).toBe(false);
  });

  it("notifies only when the window is unfocused", () => {
    const f = host();
    const store = makeNotificationsStore(memoryStorage(), f.h);
    expect(store.notifyGenerationComplete("Clip is ready.")).toBe(true);
    expect(f.shown).toEqual([["Generation complete", "Clip is ready."]]);
    const focused = host({ focused: true });
    expect(makeNotificationsStore(memoryStorage(), focused.h).notifyGenerationComplete("x")).toBe(false);
    expect(focused.shown).toEqual([]);
  });

  it("stays silent when disabled or not permitted, and persists the flag", () => {
    const storage = memoryStorage();
    const f = host();
    const store = makeNotificationsStore(storage, f.h);
    store.setEnabled(false);
    expect(storage.getItem("notifications.enabled")).toBe("false");
    expect(store.notifyGenerationComplete("x")).toBe(false);
    const denied = host({ permission: "denied" });
    expect(makeNotificationsStore(memoryStorage(), denied.h).notifyGenerationComplete("x")).toBe(false);
  });

  it("asks for permission when enabled and undecided", () => {
    const f = host({ permission: "default" });
    const store = makeNotificationsStore(memoryStorage(), f.h);
    expect(f.requests()).toBe(1);
    store.setEnabled(false);
    store.setEnabled(true);
    expect(f.requests()).toBe(1);
  });
});
