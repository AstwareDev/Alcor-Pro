import { createSignal } from "solid-js";
import { defaultStorage, type KeyValueStorage } from "./storage";

// Port of AppNotifications (generation complete) on the WebView Notification API. Unlike the Mac app, which always
// notifies, a notification only fires while the window is not focused: the in-app toast already covers the focused case.

const KEY = "notifications.enabled";

export function parseNotificationsEnabled(raw: string | null): boolean {
  return raw === null ? true : raw === "true";
}

/** The WebView subset used here, so tests can fake it. */
export interface NotificationHost {
  permission(): NotificationPermission | "unsupported";
  requestPermission(): Promise<NotificationPermission | "unsupported">;
  windowFocused(): boolean;
  show(title: string, body: string): void;
}

export function webViewNotificationHost(): NotificationHost {
  const supported = typeof Notification !== "undefined";
  return {
    permission: () => (supported ? Notification.permission : "unsupported"),
    requestPermission: async () => (supported ? await Notification.requestPermission() : "unsupported"),
    windowFocused: () => document.hasFocus(),
    show: (title, body) => {
      new Notification(title, { body, silent: false });
    },
  };
}

export interface NotificationsStore {
  enabled(): boolean;
  setEnabled(next: boolean): void;
  /** Shows a notification when enabled, permitted and the window is not focused; returns whether it was shown. */
  notifyGenerationComplete(body: string): boolean;
}

export function makeNotificationsStore(storage: KeyValueStorage, host: NotificationHost): NotificationsStore {
  const [enabled, setEnabledSignal] = createSignal(parseNotificationsEnabled(storage.getItem(KEY)));
  const askPermission = (): void => {
    if (host.permission() === "default") void host.requestPermission().catch(() => undefined);
  };
  if (enabled()) askPermission();
  return {
    enabled,
    setEnabled(next) {
      setEnabledSignal(next);
      storage.setItem(KEY, String(next));
      if (next) askPermission();
    },
    notifyGenerationComplete(body) {
      if (!enabled() || host.windowFocused() || host.permission() !== "granted") return false;
      host.show("Generation complete", body);
      return true;
    },
  };
}

let shared: NotificationsStore | undefined;
export function sharedNotifications(): NotificationsStore {
  shared ??= makeNotificationsStore(defaultStorage(), webViewNotificationHost());
  return shared;
}
