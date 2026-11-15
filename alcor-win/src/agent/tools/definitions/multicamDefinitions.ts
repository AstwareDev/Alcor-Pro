// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";
import { videoLayouts } from "../../../model";

export const multicamDefinitions: ToolDefinition[] = [
{
            name: "sync_clips",
            description: "Align one or more clips to a reference clip by shifting targets on the timeline — use for dual-system sound (camera + external audio) or multicam. Default mode 'auto' aligns by embedded source timecode when both files carry one (exact, confidence 1.0), falling back to audio cross-correlation otherwise (seeded by capture dates when present); force a method with mode. referenceClipId stays put unless a target would land before frame 0, in which case the whole group shifts right together (reported as shiftedFrames). Returns offsetFrames, confidence (0–1), and method (timecode|audio) per target; refuses weak audio matches. Refused on multicam clips — a group's members are already aligned by its sync maps (manage_multicam).",
            inputSchema: objectSchema({
                properties: {
                    "referenceClipId": {"type": "string", "description": "Clip the others align to. Stays put."},
                    "targetClipId": {"type": "string", "description": "Single clip to align. Use targetClipIds for several."},
                    "targetClipIds": {"type": "array", "items": {"type": "string"}, "description": "Clips to align with the reference."},
                    "mode": {"type": "string", "enum": ["auto", "audio", "timecode"], "description": "auto (default): timecode when available, else audio. audio/timecode force that method."},
                    "searchWindowSeconds": {"type": "number", "description": "Optional max ± offset to search in seconds. Omit to search the full feasible overlap."},
                    "minConfidence": {"type": "number", "description": "Minimum audio correlation confidence 0–1 (default 0.5)."},
                },
                required: ["referenceClipId"]
            })
        },
{
            name: "manage_multicam",
            description: "Create or ungroup a multicam group. create syncs session media into ordinary stamped timeline clips: one program video track, one audio track per mic, and angle switches through change_cam. Use member kind angle for scratch-camera audio, mic for program audio, and both for a camera whose audio should play. Pin offsetSeconds when correlation cannot align a member. ungroup strips stamps and leaves clips in place.",
            inputSchema: objectSchema({
                properties: {
                    "create": objectSchema({
                        properties: {
                            "members": {
                                "type": "array",
                                "description": "Session source files, at least two.",
                                "items": objectSchema({
                                    properties: {
                                        "mediaRef": {"type": "string", "description": "Media asset id from get_media."},
                                        "kind": {"type": "string", "enum": ["angle", "mic", "both"], "description": "angle = camera scratch audio, mic = audio in the mix, both = camera plus program audio."},
                                        "angleLabel": {"type": "string", "description": "Handle used by change_cam. Default: file name."},
                                        "offsetSeconds": {"type": "number", "description": "Pin this member's group-clock offset instead of correlating."},
                                    },
                                    required: ["mediaRef", "kind"]
                                }),
                            },
                            "name": {"type": "string", "description": "Group name. Default: Multicam N."},
                            "master": {"type": "string", "description": "angleLabel or mediaRef whose audio clock defines the group. Default: first mic/both member."},
                            "startFrame": {"type": "integer", "description": "Timeline frame to place the group. Default: timeline end."},
                            "searchWindowSeconds": {"type": "number", "description": "Max ± audio sync search window, seconds (default 240)."},
                        },
                        required: ["members"]
                    }),
                    "ungroup": objectSchema({
                        properties: {
                            "groupId": {"type": "string", "description": "Group to dissolve; its clips stay put, unstamped."},
                        },
                        required: ["groupId"]
                    }),
                }
            })
        },
{
            name: "change_cam",
            description: "Switch a multicam group's camera angle over timeline frame ranges, full-frame or in a multi-angle layout. Batched entries are one undo step. Ranges where an angle was not recording clamp or skip. Returns switched count, optional clamps/skips/overlayClipIds, and program rows over the touched span.\n\nEach entry is EITHER {range, angle} — full-frame switch — or {range, layout, angles} — PiP/split/grid: angles fill the layout's slots in order (first = the full-frame program slot; fewer angles than slots leaves cells empty), extra angles land as synced overlay clips above the program. A later full-frame entry over the same range clears the layout. Overlay clips are ordinary group clips — restyle with set_clip_properties/apply_layout, remove with remove_clips.",
            inputSchema: objectSchema({
                properties: {
                    "groupId": {"type": "string", "description": "The multicam group (from manage_multicam create or get_timeline's multicamGroups). Or pass clipId."},
                    "clipId": {"type": "string", "description": "Any clip of the group on the active timeline."},
                    "entries": {
                        "type": "array",
                        "description": "Switches to apply, in order. Later entries win on overlap.",
                        "items": objectSchema({
                            properties: {
                                "range": {"type": "array", "items": {"type": "integer"}, "description": "[startFrame, endFrame) in timeline frames."},
                                "angle": {"type": "string", "description": "angleLabel to show full-frame. Omit when using layout."},
                                "layout": {
                                    "type": "string",
                                    "enum": [...videoLayouts].filter((layout) => layout !== "full"),
                                    "description": "Multi-angle layout. Grid cells are rNcN counting from the top-left (r1c1 is top-left, row 1 is the top row); shaped layouts name slots by role.",
                                },
                                "angles": {"type": "array", "items": {"type": "string"}, "description": "angleLabels in slot order for layout; [0] is the program slot."},
                            },
                            required: ["range"]
                        }),
                    },
                },
                required: ["entries"]
            })
        },
{
            name: "get_multicam",
            description: "Read a multicam group: members (angleLabel, kind, offsetSeconds, confidence, which is master), the current program cut as run-length [angle, startFrame, endFrame) rows in timeline frames, and the track indexes the group occupies. Use it to learn angle labels before change_cam, or to review the cut as one program instead of piecing it together from get_timeline's clips. Window long timelines with startFrame/endFrame.",
            inputSchema: objectSchema({
                properties: {
                    "groupId": {"type": "string", "description": "The multicam group id. Or pass clipId."},
                    "clipId": {"type": "string", "description": "Any clip of the group on the active timeline."},
                    "startFrame": {"type": "integer", "description": "Optional window start for program rows."},
                    "endFrame": {"type": "integer", "description": "Optional window end (exclusive)."},
                }
            })
        },
];
