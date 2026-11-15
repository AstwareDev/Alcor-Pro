// Content that ships as downloadable packs (not bundled in the app). `buildCatalog.ts` turns these into
// `library-catalog/` (index.json + one presets.json per pack) for publishing.
import { makeTextAnimation } from "../../model";
import {
  blur, clarity, contrast, effectPreset, exposure, glow, grain, hiSh, levels, look, lut, motionBlur, saturation, sharpen,
  temperature, textStyle, title, ts, vibrance, vignette, wheels,
} from "../builtin/helpers";
import type { PackKind, PackLicence } from "../catalog";
import type { Preset } from "../presetFormat";

export interface RemoteFile {
  path: string;
  /** Absolute URL of a file hosted elsewhere (its sha256 is pinned in `remoteFiles`). */
  url: string;
  sha256: string;
  size: number;
}

export interface PackDefinition {
  id: string;
  name: string;
  kind: PackKind;
  version: string;
  description: string;
  author: string;
  sourceUrl: string;
  licence: PackLicence;
  attribution: string;
  presets: Preset[];
  /** Files fetched straight from the original publisher (not rehosted). */
  remoteFiles: RemoteFile[];
}

const ours: PackLicence = { name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", requiresAttribution: false };
const author = "Alcor Pro";
const source = "https://github.com/alcor-pro/library";

const rise = makeTextAnimation({ preset: "slideUp" });
const pop = makeTextAnimation({ preset: "popIn" });

const seasons: Preset[] = [
  look("pack.season-spring", "Spring Bloom", "Seasons", [temperature(6700, 8), saturation(1.12), vibrance(0.18), exposure(0.1), wheels({ gain: [100, 0.08], lift: [330, 0.08] }), glow(0.14, 26, 0.65, 0.2)]),
  look("pack.season-summer", "Summer Haze", "Seasons", [temperature(7300, 4), saturation(1.18), contrast(1.06), exposure(0.08), wheels({ gain: [48, 0.14] }), glow(0.2, 30, 0.6, 0.6)]),
  look("pack.season-autumn", "Autumn Leaves", "Seasons", [temperature(7800, 10), saturation(1.2), contrast(1.1), wheels({ gamma: [30, 0.16], lift: [15, 0.1] }), vignette(-0.2)]),
  look("pack.season-winter", "Winter Frost", "Seasons", [temperature(4900, -4), saturation(0.82), contrast(1.08), exposure(0.1), wheels({ gain: [210, 0.12] }), clarity(0.2)]),
  look("pack.season-golden-fall", "Golden Fall", "Seasons", [temperature(8400, 12), saturation(1.14), contrast(1.08), wheels({ gain: [42, 0.26] }), glow(0.18, 28, 0.62, 0.7)]),
  look("pack.season-cherry", "Cherry Blossom", "Seasons", [temperature(6800, 16), saturation(0.95), exposure(0.14), contrast(0.94), wheels({ gain: [340, 0.16], lift: [335, 0.08] }), glow(0.2, 30, 0.58, 0.3)]),
  look("pack.season-monsoon", "Monsoon", "Seasons", [saturation(0.8), contrast(1.1), exposure(-0.15), temperature(5600, -6), wheels({ lift: [170, 0.16] }), clarity(0.15)]),
  look("pack.season-desert", "Desert Noon", "Seasons", [temperature(7900, 6), contrast(1.18), saturation(1.05), exposure(0.12), hiSh(-0.2, 0.05), wheels({ gain: [45, 0.12] })]),
  look("pack.season-snow", "Snowfall", "Seasons", [exposure(0.2), contrast(0.96), saturation(0.7), temperature(5100), levels(0.04, 0.08), glow(0.16, 26, 0.7, 0)]),
  look("pack.season-harvest", "Harvest", "Seasons", [temperature(7500, 8), saturation(1.1), contrast(1.06), wheels({ gamma: [35, 0.14], gain: [60, 0.1] }), grain(0.1)]),
  look("pack.season-midsummer", "Midsummer Night", "Seasons", [exposure(-0.2), contrast(1.12), saturation(1.08), wheels({ lift: [250, 0.3], gain: [30, 0.14] }), glow(0.2, 26, 0.62, 0.2)]),
  look("pack.season-indian", "Indian Summer", "Seasons", [temperature(8000, 6), saturation(1.16), contrast(1.04), levels(0.04, 0), wheels({ gamma: [28, 0.12] }), vignette(-0.18)]),
];

const creators: Preset[] = [
  look("pack.creator-vlog", "Vlog Bright", "Creators", [exposure(0.12), contrast(1.06), vibrance(0.2), saturation(1.1), temperature(6800, 2), sharpen(0.3)]),
  look("pack.creator-gaming", "Gaming Neon", "Creators", [saturation(1.35), contrast(1.18), wheels({ lift: [265, 0.22], gain: [185, 0.2] }), glow(0.3, 22, 0.55, 0), sharpen(0.4)]),
  look("pack.creator-unboxing", "Unboxing Clean", "Creators", [exposure(0.14), contrast(1.08), saturation(0.98), temperature(6500), sharpen(0.55), clarity(0.2)]),
  look("pack.creator-fitness", "Fitness Punch", "Creators", [contrast(1.28), saturation(1.1), clarity(0.4), hiSh(-0.1, 0.12), sharpen(0.45), vignette(-0.2)]),
  look("pack.creator-street", "Street Grit", "Creators", [contrast(1.25), saturation(0.75), clarity(0.35), grain(0.25, 2), wheels({ lift: [200, 0.1] }), vignette(-0.28)]),
  look("pack.creator-lifestyle", "Lifestyle Cream", "Creators", [temperature(7000, 6), exposure(0.12), contrast(0.94), saturation(0.92), levels(0.08, -0.02), glow(0.14, 28, 0.62, 0.4)]),
  look("pack.creator-cafe", "Moody Cafe", "Creators", [temperature(7400, 8), exposure(-0.12), contrast(1.1), saturation(0.9), wheels({ gamma: [28, 0.14], lift: [210, 0.08] }), vignette(-0.3)]),
  look("pack.creator-product", "Product White", "Creators", [exposure(0.22), contrast(1.06), saturation(0.96), temperature(6400), sharpen(0.6)]),
  look("pack.creator-sports", "Sports Action", "Creators", [contrast(1.2), saturation(1.22), vibrance(0.12), clarity(0.35), sharpen(0.55)]),
  look("pack.creator-drone", "Drone Aerial", "Creators", [contrast(1.1), saturation(1.14), vibrance(0.2), hiSh(-0.25, 0.2), clarity(0.25, 0.2), sharpen(0.35)]),
];

const socialText: Preset[] = [
  textStyle("pack.text-tiktok", "Short-form Bold", "Social", ts({ font: "Arial Black", size: 104, caps: true, outline: { color: "#000000", width: 10 } })),
  textStyle("pack.text-reel-yellow", "Reel Yellow", "Social", ts({ font: "Impact", size: 110, color: "#FFE600", caps: true, outline: { color: "#000000", width: 9 }, shadow: { alpha: 0.6, y: -6, blur: 0 } })),
  textStyle("pack.text-story-pill", "Story Pill", "Social", ts({ font: "Segoe UI", bold: true, size: 64, color: "#111111", box: { color: "#FFFFFF", alpha: 0.95, px: 36, py: 14, radius: 40 } })),
  textStyle("pack.text-story-dark", "Story Dark", "Social", ts({ font: "Segoe UI", bold: true, size: 64, box: { color: "#000000", alpha: 0.6, px: 36, py: 14, radius: 40 } })),
  textStyle("pack.text-podcast", "Podcast Caption", "Social", ts({ font: "Bahnschrift", bold: true, size: 70, color: "#FFFFFF", box: { color: "#7C3AED", alpha: 1, px: 28, py: 12, radius: 14 } })),
  textStyle("pack.text-news", "News Ticker", "Social", ts({ font: "Arial", bold: true, size: 58, align: "left", box: { color: "#0B3D91", alpha: 1, px: 30, py: 12, radius: 0 } })),
  textStyle("pack.text-lofi", "Lo-fi Mono", "Social", ts({ font: "Consolas", size: 72, color: "#F5E9D3", tracking: 2, shadow: { color: "#FF6B6B", alpha: 0.9, x: -4, y: 0, blur: 0 } })),
  textStyle("pack.text-ice", "Ice", "Social", ts({ font: "Segoe UI", bold: true, size: 100, color: "#E6F7FF", shadow: { color: "#4FC3F7", alpha: 1, y: 0, blur: 22 } })),
  textStyle("pack.text-fire", "Fire", "Social", ts({ font: "Impact", size: 118, color: "#FFB020", caps: true, shadow: { color: "#E8230A", alpha: 1, y: 0, blur: 24 } })),
  textStyle("pack.text-chalk", "Chalkboard", "Social", ts({ font: "Segoe Print", size: 88, color: "#F4F4F0", shadow: { alpha: 0.5, y: -2, blur: 3 } })),
  textStyle("pack.text-mint-box", "Mint Box", "Social", ts({ font: "Segoe UI", bold: true, size: 68, color: "#06352B", box: { color: "#5EEAD4", alpha: 1, px: 30, py: 12, radius: 10 } })),
  textStyle("pack.text-outline-white", "White Outline", "Social", ts({ font: "Arial Black", size: 108, color: "#FFFFFF", outline: { color: "#FF2D55", width: 12 } })),
];

const socialTitles: Preset[] = [
  title("pack.title-subscribe", "Subscribe Button", "Social", 4, [
    { text: "SUBSCRIBE", style: ts({ font: "Arial Black", size: 64, box: { color: "#FF0000", alpha: 1, px: 44, py: 18, radius: 12 } }), animation: pop, box: { centerX: 0.5, centerY: 0.84 } },
  ]),
  title("pack.title-follow", "Follow Me", "Social", 4, [
    { text: "Follow for more", style: ts({ font: "Segoe UI", bold: true, size: 70, box: { color: "#000000", alpha: 0.7, px: 36, py: 14, radius: 40 } }), animation: rise, box: { centerX: 0.5, centerY: 0.82 } },
  ]),
  title("pack.title-episode", "Episode Card", "Social", 5, [
    { text: "EPISODE 12", style: ts({ font: "Bahnschrift", bold: true, size: 56, tracking: 10, color: "#FFD60A" }), animation: rise, box: { centerX: 0.5, centerY: 0.42 } },
    { text: "The Big Reveal", style: ts({ font: "Georgia", italic: true, size: 110 }), layer: 1, startOffsetSeconds: 0.5, animation: pop, box: { centerX: 0.5, centerY: 0.55 } },
  ]),
  title("pack.title-vs", "Versus", "Social", 4, [
    { text: "VS", style: ts({ font: "Impact", size: 220, color: "#FF3B30", outline: { color: "#FFFFFF", width: 10 } }), animation: pop },
  ]),
  title("pack.title-stat", "Big Number", "Social", 4, [
    { text: "1,000,000", style: ts({ font: "Bahnschrift", bold: true, size: 190, shadow: { alpha: 0.5, y: -5, blur: 14 } }), animation: pop, box: { centerX: 0.5, centerY: 0.44 } },
    { text: "views", style: ts({ font: "Segoe UI", size: 66, caps: true, tracking: 10, color: "#E6E6E6" }), layer: 1, startOffsetSeconds: 0.4, animation: rise, box: { centerX: 0.5, centerY: 0.6 } },
  ]),
  title("pack.title-date", "Date Stamp", "Social", 4, [
    { text: "14 . 11 . 2026", style: ts({ font: "Consolas", bold: true, size: 56, color: "#FFB020", align: "left", shadow: { alpha: 0.8, y: -2, blur: 4 } }), animation: makeTextAnimation({ preset: "typewriter" }), box: { centerX: 0.84, centerY: 0.92 } },
  ]),
];

const extras: Preset[] = [
  effectPreset("pack.fx-dream-blur", "Dream Blur", "Glow", [blur(4), glow(0.5, 36, 0.5, 0.2), exposure(0.08)]),
  effectPreset("pack.fx-tilt-speed", "Speed Rush", "Blur", [motionBlur(48, 0), contrast(1.08), saturation(1.1)]),
  effectPreset("pack.fx-vertical-streak", "Vertical Streak", "Blur", [motionBlur(36, 90)]),
  effectPreset("pack.fx-cctv", "Security Cam", "Stylize", [saturation(0.3), contrast(1.2), grain(0.55, 2.4), vignette(-0.4), sharpen(0.3)]),
  effectPreset("pack.fx-lowlight-clean", "Low-light Clean", "Detail", [exposure(0.3), hiSh(0, 0.35), sharpen(0.2)]),
  effectPreset("pack.fx-bloom-hard", "Hard Bloom", "Glow", [glow(1, 30, 0.35, 0.3), contrast(1.1)]),
];

/** Pinned to the publisher's commit so the sha256 values stay valid. https://github.com/slaycamera/luts (CC BY 4.0). */
const slayCommit = "a1709044efe115640dde1dee17d4185fc059af0d";
const slayFiles: RemoteFile[] = [
  ["slay-01-amber", "5912a5761bb9663901ae1a311add997055390e94972f77fe32407d88dca20b08", 970501],
  ["slay-02-fade", "0fc029d88a11c13abad35729c4a665ccd4bccfe8fb841d89874ab6c74651dc96", 970500],
  ["slay-03-neon", "07ac89f666c74e638d79fb28f4de5a5e18ae47bfc9ba04bb5c50e005555e7141", 970500],
  ["slay-04-film", "d846f24a0ce3affbeaa5f3969b0dde5b54018a9aedf7e46614bf963fffbf4738", 970500],
  ["slay-05-portrait", "432898146d41e061db1d36d37f89130d1394fb9f4eb13e80630e18e10d2cc895", 970504],
].map(([name, sha256, size]) => ({
  path: `luts/${name as string}.cube`,
  url: `https://raw.githubusercontent.com/slaycamera/luts/${slayCommit}/luts/${name as string}.cube`,
  sha256: sha256 as string,
  size: size as number,
}));

const slayLooks: Preset[] = [
  ["slay-01-amber", "slay Amber"], ["slay-02-fade", "slay Fade"], ["slay-03-neon", "slay Neon"],
  ["slay-04-film", "slay Film"], ["slay-05-portrait", "slay Portrait"],
].map(([file, name]) => look(`pack.lut-${file as string}`, name as string, "LUTs", [lut(`slay-cinematic-luts/luts/${file as string}.cube`, 1)], ["lut", "cinematic"]));

export const packDefinitions: readonly PackDefinition[] = [
  { id: "looks-seasons", name: "Seasons Looks", kind: "looks", version: "1.0.0", description: "Twelve looks for every time of year.", author, sourceUrl: source, licence: ours, attribution: "", presets: seasons, remoteFiles: [] },
  { id: "looks-creators", name: "Creator Looks", kind: "looks", version: "1.0.0", description: "Looks tuned for vlogs, gaming, products and sport.", author, sourceUrl: source, licence: ours, attribution: "", presets: creators, remoteFiles: [] },
  { id: "text-social", name: "Social Text Styles", kind: "text", version: "1.0.0", description: "Caption and overlay styles for short-form video.", author, sourceUrl: source, licence: ours, attribution: "", presets: socialText, remoteFiles: [] },
  { id: "titles-social", name: "Social Titles", kind: "titles", version: "1.0.0", description: "Call-outs, episode cards and stat titles.", author, sourceUrl: source, licence: ours, attribution: "", presets: socialTitles, remoteFiles: [] },
  { id: "effects-extras", name: "Extra Effects", kind: "effects", version: "1.0.0", description: "Blur, glow and clean-up effect presets.", author, sourceUrl: source, licence: ours, attribution: "", presets: extras, remoteFiles: [] },
  {
    id: "slay-cinematic-luts",
    name: "slay Cinematic LUTs",
    kind: "luts",
    version: "1.0.0",
    description: "Five free cinematic .cube LUTs (33x33x33). Downloaded from the author's GitHub repository, not rehosted.",
    author: "slay",
    sourceUrl: "https://github.com/slaycamera/luts",
    licence: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", requiresAttribution: true },
    attribution: "LUTs by slay (slaycamera.com)",
    presets: slayLooks,
    remoteFiles: slayFiles,
  },
];
