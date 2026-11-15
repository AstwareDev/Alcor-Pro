// @ts-expect-error Tests run in Node; the web app intentionally has no Node type dependency.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { timelineClipColorDefault, type TimelineClipColor } from "../timeline/view/timelineClipColors";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function hexToken(name: string): string {
  const match = tokens.match(new RegExp(`--${name}:\\s*(#[a-fA-F0-9]{6});`));
  if (!match?.[1]) throw new Error(`Missing literal color token: ${name}`);
  return match[1].toLowerCase();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("Alcor brand palette", () => {
  it("brand action foregrounds meet WCAG AA in both themes", () => {
    expect(contrast(hexToken("brand-green"), hexToken("brand-black"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hexToken("brand-green-ink"), hexToken("brand-white"))).toBeGreaterThanOrEqual(4.5);
  });

  it("light theme uses dark green rather than lime for text and playhead", () => {
    const light = tokens.split(':root[data-theme="light"]')[1];
    expect(light).toBeDefined();
    for (const name of ["accent-timecode", "accent-primary", "accent-playhead", "accent-link"]) {
      expect(light).toContain(`--${name}: var(--brand-green-ink);`);
    }
  });

  it.each<[TimelineClipColor, string]>([
    ["video", "track-video"], ["audio", "track-audio"], ["image", "track-image"],
    ["text", "track-text"], ["animation", "track-lottie"], ["sequence", "track-sequence"],
  ])("%s canvas default matches its CSS media-panel token", (kind, token) => {
    const color = timelineClipColorDefault(kind);
    const hex = "#" + [color.r, color.g, color.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(hexToken(token));
  });
});
