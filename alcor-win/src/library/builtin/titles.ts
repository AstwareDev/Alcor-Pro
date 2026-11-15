import { makeTextAnimation } from "../../model";
import type { TitlePreset } from "../presetFormat";
import { title, ts } from "./helpers";

const pop = makeTextAnimation({ preset: "popIn" });
const rise = makeTextAnimation({ preset: "slideUp" });
const type = makeTextAnimation({ preset: "typewriter" });
const reveal = makeTextAnimation({ preset: "wordReveal", perWordFrames: 6 });

export const builtinTitles: readonly TitlePreset[] = [
  title("title.simple", "Simple Title", "Openers", 4, [
    { text: "Your Title", style: ts({ font: "Segoe UI", bold: true, size: 120, shadow: { alpha: 0.5, y: -4, blur: 14 } }), animation: rise },
  ]),
  title("title.cinematic", "Cinematic Title", "Openers", 5, [
    { text: "THE LONG ROAD", style: ts({ font: "Times New Roman", size: 110, caps: true, tracking: 18 }), animation: pop, box: { centerX: 0.5, centerY: 0.46 } },
    { text: "A short film", style: ts({ font: "Times New Roman", italic: true, size: 44, color: "#D8D8D8", tracking: 4 }), layer: 1, startOffsetSeconds: 0.8, animation: rise, box: { centerX: 0.5, centerY: 0.58 } },
  ]),
  title("title.impact-slam", "Impact Slam", "Openers", 3, [
    { text: "BIG MOMENT", style: ts({ font: "Impact", size: 190, caps: true, outline: { color: "#000000", width: 12 }, shadow: { alpha: 0.6, y: -10, blur: 0 } }), animation: pop },
  ]),
  title("title.neon-sign", "Neon Sign", "Openers", 4, [
    { text: "OPEN 24/7", style: ts({ font: "Segoe UI", bold: true, size: 140, color: "#FFE3F4", shadow: { color: "#FF2EA6", alpha: 1, y: 0, blur: 34 } }), animation: pop },
  ]),
  title("title.chapter", "Chapter Number", "Sections", 4, [
    { text: "01", style: ts({ font: "Bahnschrift", bold: true, size: 240, color: "#FFFFFF", blur: 0 }), animation: pop, box: { centerX: 0.5, centerY: 0.42 } },
    { text: "Chapter title", style: ts({ font: "Segoe UI", size: 64, color: "#E8E8E8", tracking: 6, caps: true }), layer: 1, startOffsetSeconds: 0.4, animation: rise, box: { centerX: 0.5, centerY: 0.62 } },
  ]),
  title("title.lower-third", "Lower Third", "Lower thirds", 5, [
    { text: "Full Name", style: ts({ font: "Segoe UI", bold: true, size: 64, align: "left", box: { color: "#0A84FF", alpha: 1, px: 26, py: 12, radius: 6 } }), animation: rise, box: { centerX: 0.24, centerY: 0.79 } },
    { text: "Job title or location", style: ts({ font: "Segoe UI", size: 42, align: "left", box: { color: "#000000", alpha: 0.75, px: 26, py: 10, radius: 6 } }), layer: 1, startOffsetSeconds: 0.25, animation: rise, box: { centerX: 0.26, centerY: 0.87 } },
  ]),
  title("title.lower-third-minimal", "Minimal Lower Third", "Lower thirds", 5, [
    { text: "Speaker Name", style: ts({ font: "Segoe UI", bold: true, size: 58, align: "left", shadow: { alpha: 0.7, y: -3, blur: 10 } }), animation: reveal, box: { centerX: 0.2, centerY: 0.8 } },
    { text: "Topic of the talk", style: ts({ font: "Segoe UI Light", size: 40, align: "left", color: "#E6E6E6", shadow: { alpha: 0.7, y: -3, blur: 10 } }), layer: 1, startOffsetSeconds: 0.3, animation: rise, box: { centerX: 0.2, centerY: 0.87 } },
  ]),
  title("title.location-tag", "Location Tag", "Lower thirds", 4, [
    { text: "TOKYO, JAPAN", style: ts({ font: "Bahnschrift", bold: true, size: 48, tracking: 8, color: "#111111", box: { color: "#FFE600", alpha: 1, px: 24, py: 10, radius: 4 } }), animation: rise, box: { centerX: 0.18, centerY: 0.1 } },
  ]),
  title("title.quote", "Quote", "Sections", 6, [
    { text: "“The best way out is always through.”", style: ts({ font: "Georgia", italic: true, size: 80, color: "#F4EFE6", lineSpacing: 8, shadow: { alpha: 0.4, y: -3, blur: 10 } }), animation: reveal, box: { centerX: 0.5, centerY: 0.46 } },
    { text: "- Robert Frost", style: ts({ font: "Georgia", size: 44, color: "#C9C2B2" }), layer: 1, startOffsetSeconds: 1.6, animation: rise, box: { centerX: 0.5, centerY: 0.64 } },
  ]),
  title("title.breaking-news", "Breaking News", "Sections", 5, [
    { text: "BREAKING NEWS", style: ts({ font: "Arial Black", size: 54, color: "#FFFFFF", align: "left", box: { color: "#D70015", alpha: 1, px: 24, py: 10, radius: 0 } }), animation: rise, box: { centerX: 0.2, centerY: 0.78 } },
    { text: "Headline goes here", style: ts({ font: "Arial", bold: true, size: 56, color: "#111111", align: "left", box: { color: "#FFFFFF", alpha: 0.95, px: 26, py: 14, radius: 0 } }), layer: 1, startOffsetSeconds: 0.3, animation: rise, box: { centerX: 0.3, centerY: 0.86 } },
  ]),
  title("title.typewriter", "Typewriter Intro", "Openers", 5, [
    { text: "Once upon a time...", style: ts({ font: "Courier New", bold: true, size: 84, color: "#F5F0DC" }), animation: type },
  ]),
  title("title.credits", "Opening Credits", "Credits", 5, [
    { text: "A FILM BY", style: ts({ font: "Times New Roman", size: 40, caps: true, tracking: 12, color: "#BEBEBE" }), animation: rise, box: { centerX: 0.5, centerY: 0.44 } },
    { text: "YOUR NAME", style: ts({ font: "Times New Roman", size: 92, caps: true, tracking: 16 }), layer: 1, startOffsetSeconds: 0.6, animation: pop, box: { centerX: 0.5, centerY: 0.54 } },
  ]),
  title("title.thanks", "Thanks for Watching", "Credits", 5, [
    { text: "Thanks for watching!", style: ts({ font: "Trebuchet MS", bold: true, size: 110, shadow: { alpha: 0.5, y: -4, blur: 12 } }), animation: pop, box: { centerX: 0.5, centerY: 0.44 } },
    { text: "Like and subscribe", style: ts({ font: "Segoe UI", bold: true, size: 56, box: { color: "#FF3B30", alpha: 1, px: 40, py: 14, radius: 60 } }), layer: 1, startOffsetSeconds: 0.7, animation: rise, box: { centerX: 0.5, centerY: 0.62 } },
  ]),
];

export const titleCategories: readonly string[] = ["Openers", "Sections", "Lower thirds", "Credits"];
