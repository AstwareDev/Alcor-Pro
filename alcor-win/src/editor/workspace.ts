import { createSignal, type Signal } from "solid-js";

export type LayoutPreset = "default" | "media" | "vertical";
export type FocusedPanel = "media" | "preview" | "inspector" | "timeline";

export function persisted<T>(key: string, fallback: T): Signal<T> {
  const raw = localStorage.getItem(key);
  const [get, set] = createSignal<T>(raw === null ? fallback : (JSON.parse(raw) as T));
  const write = ((value: Parameters<typeof set>[0]) => {
    const next = set(value as never);
    localStorage.setItem(key, JSON.stringify(next));
    return next;
  }) as typeof set;
  return [get, write];
}

export const [layoutPreset, setLayoutPreset] = persisted<LayoutPreset>("layoutPreset", "default");
export const [mediaPanelVisible, setMediaPanelVisible] = persisted("mediaPanelVisible", true);
export const [inspectorPanelVisible, setInspectorPanelVisible] = persisted("inspectorPanelVisible", true);
export const [maximizedPanel, setMaximizedPanel] = createSignal<FocusedPanel | null>(null);
export const [focusedPanel, setFocusedPanel] = createSignal<FocusedPanel | null>(null);

export function panelHidden(panel: FocusedPanel): boolean {
  const max = maximizedPanel();
  if (max) return max !== panel;
  if (panel === "media") return !mediaPanelVisible();
  if (panel === "inspector") return !inspectorPanelVisible();
  return false;
}
