// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";
import { effectCatalog } from "./effectCatalog";

export const colorDefinitions: ToolDefinition[] = [
{
            name: "apply_color",
            description: "Author/refine a color grade on video/image clips with named controls — the colorist path, distinct from apply_effect (looks/FX). Returns the clips with their resulting grade as a `color` object — the same object get_timeline shows; pass one back via the `color` parameter to copy a grade between clips (replaces the whole grade). MERGES with the clip's current grade: only the params you pass change, the rest are preserved, so you can nudge one knob at a time (pass reset:true to start from neutral). Applies as live, editable color.* effects; non-color effects untouched. Iterate: apply_color → inspect_color(clipId, reference) → read the gap → adjust → repeat. Undoable. All knobs optional. Color WHEELS use HUE (0–360°, standard) + AMOUNT per tonal zone — to push shadows teal, set shadowsHue 180 and shadowsAmount ~0.15. CURVES (master + per-channel R/G/B) give precise tone shaping — per-channel curves are tone-selective (e.g. pull the blue curve down in the highlights to tame a bright sky). HUE CURVES do secondary/qualified correction — target a source hue and shift its hue/saturation/lightness (e.g. desaturate greens, warm the skin) without a mask; pair with inspect_color's hueHistogram to find which hues are present. LUT applies a .cube film-look pack on top of the grade.",
            inputSchema: objectSchema({
                properties: {
                    "clipIds": {"type": "array", "items": {"type": "string"}, "description": "Clip ids from get_timeline."},
                    "reset": {"type": "boolean", "description": "Start from neutral instead of merging onto the clip's current grade. Default false."},
                    "color": {"type": "object", "description": "A complete grade object as read from a clip's `color` key (get_timeline or an apply_color echo). Replaces the target clips' grade — the grade-copy path. Mutually exclusive with reset and individual knobs."},
                    "exposure": {"type": "number", "description": "-3…3 EV. Overall brightness in linear light."},
                    "contrast": {"type": "number", "description": "0.5…1.5 (1 = neutral)."},
                    "saturation": {"type": "number", "description": "0…2 (1 = neutral; <1 mutes)."},
                    "vibrance": {"type": "number", "description": "-1…1 (protects skin tones)."},
                    "temperature": {"type": "number", "description": "2000…11000 K. HIGHER = WARMER, lower = cooler/bluer (6500 = neutral)."},
                    "tint": {"type": "number", "description": "-100…100. Positive = green, negative = magenta."},
                    "highlights": {"type": "number", "description": "-1…1. Recover (<0) or lift (>0) highlights."},
                    "shadows": {"type": "number", "description": "-1…1. Lift (>0) or deepen (<0) shadows."},
                    "blacks": {"type": "number", "description": "-1…1. Black point. Negative deepens, positive lifts (faded look)."},
                    "whites": {"type": "number", "description": "-1…1. White point."},
                    "shadowsHue": {"type": "number", "description": "Shadow color-push hue 0–360° (0 red, 30 orange, 60 yellow, 120 green, 180 cyan, 240 blue, 300 magenta). Use with shadowsAmount."},
                    "shadowsAmount": {"type": "number", "description": "0…1 strength of the shadow color push (0 = neutral)."},
                    "shadowsLum": {"type": "number", "description": "-0.5…0.5 shadow lift (brightness)."},
                    "midsHue": {"type": "number", "description": "Midtone color-push hue 0–360° (see shadowsHue). Use with midsAmount."},
                    "midsAmount": {"type": "number", "description": "0…1 strength of the midtone color push."},
                    "midsGamma": {"type": "number", "description": "0.5…2 midtone brightness (gamma; 1 = neutral)."},
                    "highsHue": {"type": "number", "description": "Highlight color-push hue 0–360° (see shadowsHue). Use with highsAmount."},
                    "highsAmount": {"type": "number", "description": "0…1 strength of the highlight color push."},
                    "highsGain": {"type": "number", "description": "0.5…1.5 highlight brightness (gain; 1 = neutral)."},
                    "masterCurve": {"type": "array", "items": {"type": "array", "items": {"type": "number"}},
                                    "description": "Luma tone curve as [x,y] control points in 0–1 (input→output), preserves chroma. E.g. [[0,0.06],[1,0.95]] = lifted/faded film toe."},
                    "redCurve": {"type": "array", "items": {"type": "array", "items": {"type": "number"}},
                                 "description": "Red-channel tone curve, [x,y] points 0–1."},
                    "greenCurve": {"type": "array", "items": {"type": "array", "items": {"type": "number"}},
                                   "description": "Green-channel tone curve, [x,y] points 0–1."},
                    "blueCurve": {"type": "array", "items": {"type": "array", "items": {"type": "number"}},
                                  "description": "Blue-channel tone curve, [x,y] points 0–1. Tone-selective: e.g. [[0,0],[0.7,0.7],[1,0.85]] pulls blue only in the highlights (tames a sky) and leaves shadows."},
                    "hueCurves": {
                        "type": "object",
                        "description": "Secondary/qualified correction (Resolve-style Hue-vs-Hue/Sat/Lum). Targets replace any existing hue curve. Selectivity is ~±22° around each target hue.",
                        "properties": {
                            "targets": {
                                "type": "array",
                                "description": "One or more source-hue regions to adjust (e.g. skin at 30, sky at 210).",
                                "items": objectSchema({
                                    properties: {
                                        "targetHue": {"type": "number", "description": "Source hue to act on, 0–360° (0 red, 30 orange/skin, 60 yellow, 120 green, 180 cyan, 210 sky-blue, 240 blue, 300 magenta)."},
                                        "hueShift": {"type": "number", "description": "Rotate that hue by -30…30°."},
                                        "satScale": {"type": "number", "description": "Saturation multiplier for that hue, 0–2 (1 = neutral; 1.3 pops it, 0.6 mutes it, 0 fully desaturates)."},
                                        "lumShift": {"type": "number", "description": "Lightness shift for that hue, -0.5…0.5."},
                                    },
                                    required: ["targetHue"]
                                }),
                            },
                        },
                    },
                    "lut": {
                        "type": "object",
                        "description": "Apply a .cube 3D LUT (e.g. a film-look pack) on top of the primary grade; replaces any prior LUT. The agent does not author LUT data — pass a real file path.",
                        "properties": {
                            "path": {"type": "string", "description": "Absolute path to a .cube file (~ is expanded). Copied into project storage so it survives saves."},
                            "strength": {"type": "number", "description": "Dry/wet mix 0-1 (default 1)."},
                        },
                    },
                },
                required: ["clipIds"]
            })
        },
{
            name: "apply_effect",
            description: `Apply non-color effects (blur, sharpen, stylize, detail, key) to video/image clips as a live, editable effect stack — the looks/FX path, distinct from apply_color (grading). MERGES: each effect you pass is added or updated by type; effects you don't mention are left in place. Pass enabled:false to bypass one without removing it, or list its type in \`remove\` to delete it. Out-of-range params are clamped; params you omit keep their current (or default) value. Effects render in a fixed canonical order regardless of the order you pass them. Setting blur.gaussian.radius clears blur keyframes. Undoable. Returns the clips with their resulting effects as [{type, params}] — the same shape this tool accepts, so copying effects between clips is passing a clip's effects array back in.

Available effects — type: param (range, default):
${effectCatalog()}`,
            inputSchema: objectSchema({
                properties: {
                    "clipIds": {"type": "array", "items": {"type": "string"}, "description": "Clip ids from get_timeline."},
                    "effects": {
                        "type": "array",
                        "description": "Effects to add or update on the clips.",
                        "items": objectSchema({
                            properties: {
                                "type": {"type": "string", "description": "Effect type id, e.g. stylize.glow (see list above)."},
                                "params": {"type": "object", "description": "Param values keyed by name. Out-of-range values are clamped; omitted params keep their current/default value."},
                                "enabled": {"type": "boolean", "description": "Default true. false bypasses the effect without removing it."},
                            },
                            required: ["type"]
                        }),
                    },
                    "remove": {"type": "array", "items": {"type": "string"}, "description": "Effect type ids to remove from the clips."},
                },
                required: ["clipIds"]
            })
        },
{
            name: "inspect_color",
            description: "Measure color scopes of a timeline clip's current graded look (clipId) OR a raw media asset (mediaRef) — black/white points, % clipping, mean & per-channel levels, shadow/mid/highlight color tilt, saturation, warm-cool / green-magenta balance, and a saturation-weighted hueHistogram (12 bins of 30° from 0°/red — shows which hues are present, e.g. an orange cluster = skin, a cyan/blue cluster = sky) — and return the rendered frame too. Use this to grade by the numbers instead of eyeballing, to find hues to target with apply_color's hueCurves, or to measure footage/references before grading. clipId applies the clip's effects (graded look); mediaRef measures the raw asset. Pass a reference image/video id to also measure it and get the subject−reference GAP plus hints that map onto apply_color knobs. The loop: apply_color → inspect_color(clipId, reference) → read the gap → adjust → repeat until the gap is small.",
            inputSchema: objectSchema({
                properties: {
                    "clipId": {"type": "string", "description": "Timeline clip to measure — returns its current GRADED look (effects applied). Provide this or mediaRef."},
                    "mediaRef": {"type": "string", "description": "Media asset id from get_media to measure RAW (no grade). Provide this or clipId."},
                    "atFrame": {"type": "integer", "description": "Optional project frame to sample a clip. Defaults to the clip's midpoint. Ignored for mediaRef."},
                    "reference": {"type": "string", "description": "Optional image/video asset id from get_media to compare against; returns its scopes + the subject−reference gap."},
                }
            })
        },
];

/** Definitions whose executors are not ported yet; never advertised. */
export const pendingColorDefinitions: ToolDefinition[] = [
{
            name: "denoise_audio",
            description: "Remove background noise from audio clips using an on-device speech-enhancement model (DeepFilterNet3). strength is a dry/wet mix 0-1: 0 leaves the audio untouched, 1 is fully denoised. Full strength can sound thin or over-gated on real-world recordings, so the default is 0.6. The bake runs in the background — the timeline updates automatically when it finishes; no need to poll. Pass enabled:false to turn denoise off. Undoable.",
            inputSchema: objectSchema({
                properties: {
                    "clipIds": {"type": "array", "items": {"type": "string"}, "description": "Audio clip ids from get_timeline."},
                    "strength": {"type": "number", "description": "Dry/wet mix, 0–1 (default 0.6). Lower it if voices sound thin or over-compressed."},
                    "enabled": {"type": "boolean", "description": "Default true. false removes the denoise effect from the clips."},
                },
                required: ["clipIds"]
            })
        },
];
