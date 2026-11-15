import type { LookPreset } from "../presetFormat";
import {
  clarity, contrast, exposure, grain, hiSh, levels, look, saturation, sharpen, temperature, vibrance, vignette, wheels, glow,
} from "./helpers";

// Hand-tuned looks built from the existing colour effects. Hue angles for `wheels`: 0 red, 30 orange, 60 yellow,
// 120 green, 185 teal, 220 blue, 280 purple, 330 pink.

const cinematic: LookPreset[] = [
  look("look.cine-teal-orange", "Teal & Orange", "Cinematic", [
    contrast(1.12), saturation(1.08), wheels({ lift: [190, 0.34], gain: [28, 0.32] }), vignette(-0.18, 0.55, 0.6),
  ], ["blockbuster", "teal", "orange"]),
  look("look.cine-blockbuster", "Blockbuster", "Cinematic", [
    contrast(1.2), saturation(0.95), exposure(-0.1), wheels({ lift: [200, 0.28], gain: [35, 0.26], gammaM: 1.05 }), hiSh(-0.12, 0.08), vignette(-0.25),
  ], ["action", "teal"]),
  look("look.cine-noir-night", "Night City", "Cinematic", [
    exposure(-0.25), contrast(1.18), saturation(1.1), wheels({ lift: [235, 0.4], gamma: [280, 0.12], gain: [330, 0.18] }), glow(0.18, 24, 0.7, 0.2),
  ], ["night", "neon", "blue"]),
  look("look.cine-golden-hour", "Golden Hour", "Cinematic", [
    temperature(7600, 8), exposure(0.08), contrast(1.06), saturation(1.1), wheels({ gain: [38, 0.3], lift: [20, 0.08] }), glow(0.15, 28, 0.65, 0.6),
  ], ["warm", "sunset"]),
  look("look.cine-desat-drama", "Desaturated Drama", "Cinematic", [
    saturation(0.62), contrast(1.22), hiSh(-0.2, 0.05), wheels({ lift: [200, 0.12] }), clarity(0.25), vignette(-0.3),
  ], ["serious", "war", "muted"]),
  look("look.cine-bleach", "Bleach Bypass", "Cinematic", [
    saturation(0.5), contrast(1.35), clarity(0.35), levels(-0.05, 0.08), grain(0.14), vignette(-0.15),
  ], ["gritty", "contrast"]),
  look("look.cine-sci-fi", "Sci-Fi Cold", "Cinematic", [
    temperature(5000, -6), contrast(1.14), saturation(0.9), wheels({ lift: [190, 0.3], gain: [200, 0.18] }), glow(0.2, 26, 0.7, 0), sharpen(0.3),
  ], ["future", "cold", "teal"]),
  look("look.cine-western", "Dusty Western", "Cinematic", [
    temperature(7900, 10), contrast(1.1), saturation(0.82), wheels({ lift: [25, 0.14], gamma: [40, 0.14] }), hiSh(-0.1, 0.12), grain(0.1), vignette(-0.3, 0.5, 0.7),
  ], ["desert", "warm"]),
  look("look.cine-horror", "Horror Green", "Cinematic", [
    exposure(-0.3), contrast(1.2), saturation(0.7), wheels({ lift: [140, 0.22], gamma: [120, 0.14] }), vignette(-0.5, 0.45, 0.6), grain(0.12),
  ], ["dark", "green"]),
  look("look.cine-arctic", "Arctic", "Cinematic", [
    temperature(4600), exposure(0.12), contrast(1.08), saturation(0.85), hiSh(-0.15, 0.1), wheels({ gain: [210, 0.14] }),
  ], ["ice", "cold", "winter"]),
];

const film: LookPreset[] = [
  look("look.film-kodak-warm", "Kodak Warm", "Film", [
    temperature(7000, 4), contrast(1.08), saturation(1.12), wheels({ lift: [15, 0.1], gain: [45, 0.16] }), grain(0.16, 1.8), vignette(-0.12),
  ], ["35mm", "portra", "warm"]),
  look("look.film-fuji-cool", "Fuji Cool", "Film", [
    temperature(5600, -4), contrast(1.06), saturation(1.05), wheels({ lift: [160, 0.12], gain: [130, 0.08] }), grain(0.15, 1.8),
  ], ["35mm", "green", "cool"]),
  look("look.film-16mm", "16mm Film", "Film", [
    contrast(1.05), saturation(0.92), levels(0.06, -0.03), grain(0.34, 2.4), sharpen(0.2), vignette(-0.2, 0.5, 0.7), temperature(6900, 3),
  ], ["grain", "indie"]),
  look("look.film-super8", "Super 8", "Film", [
    saturation(1.15), contrast(0.95), levels(0.1, -0.06), temperature(7600, 8), grain(0.5, 3.2), glow(0.18, 18, 0.6, 0.5), vignette(-0.4, 0.4, 0.8),
  ], ["home movie", "retro", "grain"]),
  look("look.film-print-2383", "Print Stock", "Film", [
    contrast(1.14), saturation(1.04), levels(0.04, -0.02), wheels({ lift: [215, 0.12], gain: [40, 0.1] }), hiSh(-0.1, 0.08), grain(0.1),
  ], ["kodak", "print"]),
  look("look.film-tungsten", "Tungsten Night", "Film", [
    temperature(4300, 6), exposure(-0.1), contrast(1.1), saturation(1.1), wheels({ lift: [225, 0.2] }), grain(0.2, 2),
  ], ["cinestill", "night", "blue"]),
  look("look.film-slide", "Slide Film", "Film", [
    saturation(1.3), contrast(1.18), vibrance(0.15), exposure(-0.05), wheels({ gain: [50, 0.06] }), vignette(-0.15),
  ], ["velvia", "punchy"]),
  look("look.film-expired", "Expired Film", "Film", [
    saturation(0.85), contrast(0.94), levels(0.12, -0.08), temperature(6200, 14), wheels({ lift: [300, 0.14], gamma: [160, 0.08] }), grain(0.3, 2.6), vignette(-0.3),
  ], ["faded", "light leak"]),
];

const bw: LookPreset[] = [
  look("look.bw-classic", "B&W Classic", "Black & White", [saturation(0), contrast(1.1), levels(-0.02, 0.04)], ["monochrome"]),
  look("look.bw-high-contrast", "B&W High Contrast", "Black & White", [saturation(0), contrast(1.4), levels(-0.2, 0.12), clarity(0.2)], ["monochrome", "punchy"]),
  look("look.bw-soft", "B&W Soft", "Black & White", [saturation(0), contrast(0.9), hiSh(-0.15, 0.25), glow(0.18, 30, 0.55, 0)], ["monochrome", "dreamy"]),
  look("look.bw-noir", "Film Noir", "Black & White", [
    saturation(0), contrast(1.35), exposure(-0.25), levels(-0.18, 0.1), vignette(-0.55, 0.45, 0.55), grain(0.18),
  ], ["monochrome", "dark", "detective"]),
  look("look.bw-grain", "B&W Film Grain", "Black & White", [saturation(0), contrast(1.12), grain(0.42, 2.2), vignette(-0.2)], ["monochrome", "35mm"]),
  look("look.bw-faded", "B&W Faded", "Black & White", [saturation(0), contrast(0.88), levels(0.18, -0.1), grain(0.1)], ["monochrome", "matte"]),
  look("look.bw-cold", "B&W Cold Tone", "Black & White", [saturation(0.1), contrast(1.18), wheels({ lift: [215, 0.3], gain: [200, 0.2] }), vignette(-0.2)], ["monochrome", "blue"]),
  look("look.bw-sepia", "Sepia", "Black & White", [saturation(0.3), contrast(1.05), temperature(8600, 18), wheels({ lift: [30, 0.22], gain: [42, 0.34], gamma: [35, 0.22] }), vignette(-0.25)], ["brown", "old"]),
];

const vintage: LookPreset[] = [
  look("look.vint-70s", "70s Warm", "Vintage", [
    temperature(7800, 12), saturation(1.05), contrast(0.96), levels(0.08, -0.04), wheels({ lift: [20, 0.16], gain: [50, 0.18] }), grain(0.22, 2.2), glow(0.16, 22, 0.6, 0.6),
  ], ["retro", "orange"]),
  look("look.vint-80s", "80s Neon", "Vintage", [
    saturation(1.25), contrast(1.1), wheels({ lift: [275, 0.26], gain: [330, 0.22] }), glow(0.28, 26, 0.55, 0.3), grain(0.1),
  ], ["synthwave", "purple", "pink"]),
  look("look.vint-vhs", "VHS Tape", "Vintage", [
    saturation(1.15), contrast(0.94), levels(0.08, -0.05), wheels({ lift: [205, 0.1], gain: [345, 0.12] }), grain(0.4, 1.4), sharpen(0.5), glow(0.14, 12, 0.6, 0),
  ], ["retro", "lofi"]),
  look("look.vint-polaroid", "Polaroid", "Vintage", [
    saturation(1.05), contrast(0.92), levels(0.12, -0.04), temperature(6900, 10), wheels({ lift: [190, 0.14], gain: [55, 0.14] }), vignette(-0.28, 0.45, 0.8),
  ], ["instant", "retro"]),
  look("look.vint-old-photo", "Old Photograph", "Vintage", [
    saturation(0.55), contrast(0.9), levels(0.14, -0.08), temperature(7700, 14), wheels({ gamma: [40, 0.14] }), grain(0.3, 2.8), vignette(-0.45, 0.4, 0.8),
  ], ["aged", "sepia"]),
  look("look.vint-technicolor", "Technicolor", "Vintage", [
    saturation(1.4), vibrance(0.2), contrast(1.12), wheels({ lift: [190, 0.14], gain: [20, 0.14] }), glow(0.1, 18, 0.7, 0.3),
  ], ["classic", "saturated"]),
];

const warmCool: LookPreset[] = [
  look("look.tone-warm", "Warm", "Warm & Cool", [temperature(7400, 4), saturation(1.06), contrast(1.04)], ["sun", "cozy"]),
  look("look.tone-sunset", "Sunset Glow", "Warm & Cool", [
    temperature(8200, 14), saturation(1.15), contrast(1.08), wheels({ gain: [20, 0.28], lift: [330, 0.1] }), glow(0.22, 30, 0.6, 0.8),
  ], ["orange", "pink"]),
  look("look.tone-amber", "Amber", "Warm & Cool", [temperature(8800, 6), contrast(1.1), saturation(1.12), wheels({ gamma: [38, 0.2] })], ["gold", "warm"]),
  look("look.tone-cool", "Cool", "Warm & Cool", [temperature(5400, -2), saturation(1.04), contrast(1.04)], ["blue", "fresh"]),
  look("look.tone-ocean", "Ocean", "Warm & Cool", [
    temperature(5000, -10), saturation(1.15), contrast(1.1), wheels({ lift: [195, 0.22], gamma: [185, 0.1] }), vibrance(0.12),
  ], ["blue", "water", "teal"]),
  look("look.tone-forest", "Forest", "Warm & Cool", [
    saturation(1.08), contrast(1.08), temperature(6200, -14), wheels({ lift: [140, 0.2], gamma: [100, 0.14], gain: [70, 0.1] }), vibrance(0.1),
  ], ["green", "nature"]),
  look("look.tone-rose", "Rose", "Warm & Cool", [temperature(6900, 18), saturation(1.04), exposure(0.08), wheels({ gain: [345, 0.18], gamma: [340, 0.1] }), glow(0.12, 24, 0.65, 0.4)], ["pink", "romantic"]),
];

const faded: LookPreset[] = [
  look("look.fade-matte", "Matte", "Faded", [contrast(0.9), levels(0.16, -0.08), saturation(0.9)], ["lifted blacks"]),
  look("look.fade-soft", "Soft Fade", "Faded", [contrast(0.88), levels(0.12, -0.05), saturation(0.82), exposure(0.08), glow(0.12, 28, 0.6, 0.2)], ["airy"]),
  look("look.fade-washed", "Washed Out", "Faded", [saturation(0.55), contrast(0.85), levels(0.2, -0.1), exposure(0.1)], ["muted"]),
  look("look.fade-dusty", "Dusty Blue", "Faded", [contrast(0.92), levels(0.14, -0.06), saturation(0.78), temperature(5800, 2), wheels({ lift: [215, 0.16], gain: [30, 0.06] })], ["blue", "matte"]),
];

const vivid: LookPreset[] = [
  look("look.vivid-pop", "Vivid Pop", "Vivid", [saturation(1.35), vibrance(0.25), contrast(1.12), sharpen(0.35)], ["bright", "punchy"]),
  look("look.vivid-hdr", "HDR Pop", "Vivid", [contrast(1.15), hiSh(-0.35, 0.4), clarity(0.55, 0.15), saturation(1.2), sharpen(0.45)], ["detail", "hdr"]),
  look("look.vivid-clean", "Clean & Crisp", "Vivid", [contrast(1.1), exposure(0.1), vibrance(0.18), saturation(1.08), sharpen(0.5), clarity(0.2)], ["bright", "product"]),
  look("look.vivid-travel", "Travel Vlog", "Vivid", [temperature(6800, 2), saturation(1.22), vibrance(0.2), contrast(1.1), hiSh(-0.15, 0.15), clarity(0.2)], ["vlog", "colour"]),
  look("look.vivid-food", "Delicious", "Vivid", [temperature(7200, 4), saturation(1.25), contrast(1.12), vibrance(0.15), wheels({ gain: [40, 0.14] }), sharpen(0.4)], ["food", "warm"]),
];

const moody: LookPreset[] = [
  look("look.moody-dark", "Dark & Moody", "Moody", [exposure(-0.35), contrast(1.2), saturation(0.8), hiSh(-0.1, 0.12), vignette(-0.45, 0.45, 0.6)], ["dark"]),
  look("look.moody-green", "Moody Green", "Moody", [exposure(-0.2), contrast(1.15), saturation(0.75), wheels({ lift: [150, 0.2], gamma: [120, 0.12] }), vignette(-0.35)], ["forest", "dark"]),
  look("look.moody-blue", "Midnight Blue", "Moody", [exposure(-0.25), contrast(1.15), saturation(0.85), temperature(5000, -4), wheels({ lift: [230, 0.32] }), vignette(-0.4)], ["night", "blue"]),
  look("look.moody-rain", "Rainy Day", "Moody", [saturation(0.6), contrast(1.05), exposure(-0.12), temperature(5200), wheels({ gamma: [200, 0.1] }), clarity(0.15), grain(0.12)], ["grey", "cold"]),
];

const pastel: LookPreset[] = [
  look("look.pastel-dream", "Pastel Dream", "Pastel", [saturation(0.78), contrast(0.88), levels(0.12, -0.04), exposure(0.14), wheels({ lift: [300, 0.14], gain: [190, 0.1] }), glow(0.2, 30, 0.55, 0.3)], ["soft", "pink"]),
  look("look.pastel-candy", "Cotton Candy", "Pastel", [saturation(0.9), contrast(0.9), exposure(0.12), levels(0.1, -0.04), wheels({ lift: [190, 0.16], gain: [335, 0.18] })], ["pink", "blue"]),
  look("look.pastel-peach", "Peach", "Pastel", [temperature(7000, 10), saturation(0.85), contrast(0.9), exposure(0.12), levels(0.1, -0.03), wheels({ gain: [25, 0.14] })], ["soft", "warm"]),
  look("look.pastel-mint", "Mint", "Pastel", [temperature(6000, -8), saturation(0.82), contrast(0.9), exposure(0.12), levels(0.1, -0.03), wheels({ gain: [150, 0.12], lift: [180, 0.1] })], ["soft", "green"]),
];

const portrait: LookPreset[] = [
  look("look.port-smooth", "Smooth Skin", "Portrait", [contrast(0.96), exposure(0.08), hiSh(-0.1, 0.12), vibrance(0.08), glow(0.14, 22, 0.65, 0.3), sharpen(0.1)], ["beauty", "soft"]),
  look("look.port-glow", "Radiant", "Portrait", [temperature(6900, 6), exposure(0.12), saturation(1.06), glow(0.24, 26, 0.55, 0.5), contrast(1.02)], ["beauty", "glow"]),
  look("look.port-studio", "Studio Portrait", "Portrait", [contrast(1.12), saturation(0.96), clarity(0.2), wheels({ gain: [32, 0.1], lift: [210, 0.08] }), vignette(-0.25, 0.5, 0.7)], ["studio"]),
];

export const builtinLooks: readonly LookPreset[] = [
  ...cinematic, ...film, ...bw, ...vintage, ...warmCool, ...faded, ...vivid, ...moody, ...pastel, ...portrait,
];

export const lookCategories: readonly string[] = [
  "Cinematic", "Film", "Black & White", "Vintage", "Warm & Cool", "Faded", "Vivid", "Moody", "Pastel", "Portrait",
];
