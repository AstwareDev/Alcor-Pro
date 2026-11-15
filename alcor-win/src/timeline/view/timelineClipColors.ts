import { createSignal } from "solid-js";
import type { ClipType } from "../../model";

// Port of UI/TimelineClipColors.swift and AppTheme.TrackColor (user-customisable clip body colours).

export const timelineClipColorKinds = ["video", "audio", "image", "text", "animation", "sequence"] as const;
export type TimelineClipColor = (typeof timelineClipColorKinds)[number];

/** sRGB components in 0...1. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

const hex = (r: number, g: number, b: number): RGB => ({ r: r / 255, g: g / 255, b: b / 255 });

const defaults: Record<TimelineClipColor, RGB> = {
  video: hex(0x1d, 0x58, 0x78),
  audio: hex(0x2e, 0x77, 0x65),
  image: hex(0x71, 0x54, 0x86),
  text: hex(0x71, 0x54, 0x86),
  animation: hex(0xa0, 0x78, 0x22),
  sequence: hex(0xb9, 0xb2, 0x9a),
};

export function timelineClipColorDefault(kind: TimelineClipColor): RGB {
  return defaults[kind];
}

export function timelineClipColorDefaultsKey(kind: TimelineClipColor): string {
  return `timelineClipColor.${kind}`;
}

/** The subset of `Storage` the palette needs (localStorage in the app, a map in tests). */
export interface ColorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function storedTimelineClipColor(kind: TimelineClipColor, storage: ColorStorage): RGB {
  const raw = storage.getItem(timelineClipColorDefaultsKey(kind));
  if (raw === null) return defaults[kind];
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    return defaults[kind];
  }
  if (!Array.isArray(values) || values.length !== 3) return defaults[kind];
  if (!values.every((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) return defaults[kind];
  return { r: values[0] as number, g: values[1] as number, b: values[2] as number };
}

export interface TimelineClipColorPalette {
  color(kind: TimelineClipColor): RGB;
  set(color: RGB, kind: TimelineClipColor): void;
  resetAll(): void;
  hasOverrides(): boolean;
  /** Bumps on every change; reading it inside an effect subscribes to palette changes. */
  revision(): number;
}

export function makeTimelineClipColorPalette(storage: ColorStorage): TimelineClipColorPalette {
  const colors = new Map<TimelineClipColor, RGB>();
  const overrides = new Set<TimelineClipColor>();
  for (const kind of timelineClipColorKinds) {
    colors.set(kind, storedTimelineClipColor(kind, storage));
    if (storage.getItem(timelineClipColorDefaultsKey(kind)) !== null) overrides.add(kind);
  }
  const [revision, setRevision] = createSignal(0);
  const bump = () => setRevision((n) => n + 1);
  return {
    color: (kind) => colors.get(kind) ?? defaults[kind],
    set(color, kind) {
      const clamped = { r: clamp01(color.r), g: clamp01(color.g), b: clamp01(color.b) };
      colors.set(kind, clamped);
      overrides.add(kind);
      storage.setItem(timelineClipColorDefaultsKey(kind), JSON.stringify([clamped.r, clamped.g, clamped.b]));
      bump();
    },
    resetAll() {
      for (const kind of timelineClipColorKinds) {
        colors.set(kind, defaults[kind]);
        storage.removeItem(timelineClipColorDefaultsKey(kind));
      }
      overrides.clear();
      bump();
    },
    hasOverrides: () => overrides.size > 0,
    revision,
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

let shared: TimelineClipColorPalette | undefined;

/** `TimelineClipColorPalette.shared`, persisted in localStorage. */
export function sharedTimelineClipColorPalette(): TimelineClipColorPalette {
  shared ??= makeTimelineClipColorPalette(globalThis.localStorage ?? memoryStorage());
  return shared;
}

function memoryStorage(): ColorStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** `ClipType.themeColor`. */
export function clipTypeThemeColorKind(type: ClipType): TimelineClipColor {
  switch (type) {
    case "video": return "video";
    case "audio": return "audio";
    case "image": return "image";
    case "text": return "text";
    case "lottie": return "animation";
    case "sequence": return "sequence";
    case "subtitle": return "text";
  }
}

function linear(component: number): number {
  return component <= 0.04045 ? component / 12.92 : Math.pow((component + 0.055) / 1.055, 2.4);
}

/** `TrackColor.readableForeground(on:)`: black or white, whichever contrasts more. */
export function readableForeground(background: RGB): "black" | "white" {
  const luminance = linear(background.r) * 0.2126 + linear(background.g) * 0.7152 + linear(background.b) * 0.0722;
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "black" : "white";
}

export function rgbCss(c: RGB, alpha = 1): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}
