// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";
import { textAnimationAgentValues, textFillModes } from "../../../model";
import { mergedProperties, textStyleProperties, textTransformProperties } from "./textProperties";
import { captionGapLimits } from "./limits";

export const textsDefinitions: ToolDefinition[] = [
{
            name: "add_texts",
            description: "Adds text clips as timeline layers. Omit trackIndex on every entry to create one new top video track; otherwise set trackIndex on every entry. Text boxes auto-fit their content; transform optionally sets their alignment-relative horizontal anchor, vertical center, Z rotation, and static X/Y perspective tilt. Left-aligned text grows rightward from x, centered text grows around x, and right-aligned text grows leftward from x. Use style widthScale and heightScale to stretch glyphs. Use the nested style object for typography, outline, shadow, background, and whole-layer Gaussian blur. fillMode 'footage' stencils layers below through the letter shapes over a matte set by style.color; it defaults to black when color is omitted. 'inverted' renders white glyphs with Difference blending and ignores color, outline, shadow, and background while active. Use add_captions for spoken audio captions. Unknown fields are rejected.",
            inputSchema: objectSchema({
                properties: {
                    "entries": {
                        "type": "array",
                        "description": "Text clips to add.",
                        "items": {
                            "type": "object",
                            "properties": mergedProperties({
                                "trackIndex": {"type": "integer", "description": "Existing non-audio track. Omit on all entries to create a new top track."},
                                "startFrame": {"type": "integer", "description": "Timeline start frame."},
                                "endFrame": {"type": "integer", "description": "Occupy timeline frames [startFrame, endFrame) — copy a clip's frames pair to title exactly that span."},
                                "content": {"type": "string", "description": "Text. Supports \\n."},
                                "transform": {
                                    "type": "object",
                                    "description": "Optional position and rotation. Omitted x or y uses the default centered position. Size always auto-fits the text.",
                                    "properties": textTransformProperties(),
                                },
                            }, textStyleProperties(false), {
                                "animation": {"type": "string", "enum": [...textAnimationAgentValues], "description": "Animation preset; off clears."},
                                "highlightColor": {"type": "string", "description": "Active-word hex."},
                                "fillMode": {"type": "string", "enum": [...textFillModes], "description": "color = solid typography (default). footage = stencil layers below through the letter shapes over a matte set by style.color, defaulting to black when color is omitted. inverted = white Difference-blended glyphs; color, outline, shadow, and background are ignored while active."},
                            }),
                            "required": ["startFrame", "endFrame", "content"],
                        },
                    },
                },
                required: ["entries"]
            })
        },
{
            name: "update_text",
            description: "Updates text clips or a captionGroupId. The nested style object is a partial patch: omitted values stay unchanged. Use it for typography, color, outline, shadow, background, and whole-layer Gaussian blur. style.blur is measured in 1080p canvas pixels, scales with output resolution, and 0 removes it; setting it clears blur keyframes. Use style widthScale and heightScale to stretch glyphs. fillMode 'footage' stencils layers below through the glyphs over a matte set by style.color; entering it defaults to black when color is omitted. 'inverted' renders white glyphs with Difference blending and ignores color, outline, shadow, and background while active. Content and layout-affecting style changes auto-fit the box while preserving its alignment-relative x anchor. transform can reposition, rotate, or apply static X/Y perspective tilt without changing its size. Static Z rotation uses clockwise degrees and clears rotation keyframes. Unknown fields are rejected.",
            inputSchema: objectSchema({
                properties: mergedProperties({
                    "clipIds": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Text clip IDs. Optional if captionGroupId is given.",
                    },
                    "captionGroupId": {"type": "string", "description": "Caption group id from get_timeline."},
                    "content": {"type": "string", "description": "Replacement text. Supports \\n."},
                    "transform": {
                        "type": "object",
                        "description": "Partial position and rotation; omitted fields keep current values. Size remains auto-fit.",
                        "properties": textTransformProperties(),
                    },
                }, textStyleProperties(true), {
                    "animation": {"type": "string", "enum": [...textAnimationAgentValues], "description": "Animation preset; off clears."},
                    "highlightColor": {"type": "string", "description": "Active-word hex."},
                    "fillMode": {"type": "string", "enum": [...textFillModes], "description": "color = solid typography. footage = stencil layers below through the letter shapes over a matte set by style.color, defaulting to black when entering without color. inverted = white Difference-blended glyphs; color, outline, shadow, and background are ignored while active."},
                }),
                required: []
            })
        },
{
            name: "add_captions",
            description: "Transcribes spoken audio and creates caption text clips on their own track. Style, animation, and transform are optional overrides: omit them ALL for the app's clean default captions (plain white Helvetica, lower-third) — do not invent fonts, colors, outlines, backgrounds, blur, or animations the user didn't ask for. style.blur adds whole-layer Gaussian blur. Pass trackIndex to caption one dialogue or multicam mic track; omit it to automatically choose the timeline track with the most speech. The app uses cloud only when the signed-in account has enough credits for the uncached request; otherwise it uses local transcription. Cloud auto-detects language. Per-word animations are timed from the transcript. Alternatively, pass subtitleMediaRef (a subtitle asset from import_media/get_media) to place that SRT/WebVTT file's cues as captions at their authored timecodes — no transcription; the file's text, timing, and default styling are used as-is (overlapping cues are trimmed so clips never overlap on the track), so subtitleMediaRef can't be combined with any other parameter. Returns the caption group summary (captionGroupId, clipCount, frameRange, shared style, textPreview) — restyle it later with update_text and that captionGroupId.",
            inputSchema: objectSchema({
                properties: mergedProperties({
                    "subtitleMediaRef": {"type": "string", "description": "Subtitle asset id (type 'subtitle'). Places the file's cues at their timecodes instead of transcribing. Mutually exclusive with every other parameter."},
                    "language": {"type": "string", "description": "BCP-47 speech language. Applies to local only; cloud auto-detects."},
                    "trackIndex": {"type": "integer", "description": "Caption one current timeline track from get_timeline. Omit to auto-detect the dominant speech track."},
                    "transform": {
                        "type": "object",
                        "description": "Caption position and rotation; size is auto-fit per caption. x uses the selected text alignment edge.",
                        "properties": textTransformProperties(),
                    },
                    "censorProfanity": {"type": "boolean", "description": "Mask profanity."},
                    "maxWords": {"type": "integer", "minimum": 1, "description": "Max words per caption."},
                    "maxCharacters": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "Max characters per caption, including spaces and punctuation. A single word may exceed this limit.",
                    },
                    "maximumGapSeconds": {
                        "type": "number",
                        "minimum": captionGapLimits.maximumGap.min,
                        "maximum": captionGapLimits.maximumGap.max,
                        "description": "Extend captions to close shorter gaps and hold the final caption for up to this duration. Default 0.5 seconds; 0 disables.",
                    },
                }, textStyleProperties(false), {
                    "animation": {"type": "string", "enum": [...textAnimationAgentValues], "description": "Caption animation preset. Omit for static captions; set only when the user asks for animation."},
                    "highlightColor": {"type": "string", "description": "Active-word hex."},
                })
            })
        },
];

/** Definitions whose executors are not ported yet; never advertised. */
export const pendingTextsDefinitions: ToolDefinition[] = [
];
