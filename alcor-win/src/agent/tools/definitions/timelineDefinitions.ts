// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";


export const timelineDefinitions: ToolDefinition[] = [
{
            name: "get_timeline",
            description: "Always call at the start of a session. Returns project settings (fps, resolution, totalFrames, durationSeconds), tracks with a stable trackId, their current index (what every trackIndex parameter takes), type, and clips, plus canGenerate (if false, generation/upscale tools will fail — tell the user to add a provider API key in Settings before attempting them). Clip ids are accepted by clip mutation tools; trackId is accepted by manage_tracks.\n\nEvery clip occupies frames: [start, end) — timeline frames, end exclusive, duration = end − start. gaps on a track lists its empty [start, end) spans; no gaps key means contiguous. A video clip's linked audio partner is folded into it as audio: {id, track, …} carrying only what deviates (volumeDb, effects, differing trims); the partner is not repeated on its own track, which instead reports linkedClips (its folded count). Address the audio side by its nested id.\n\nFields equal to their defaults are omitted: mediaType 'video', sourceClipType = mediaType, speed 1, volumeDb 0, opacity 1, edgeRounding 0, edgeSoftness 0, trims/fades 0, identity transform/crop, default textStyle, track muted/hidden false. Text clips never report trims. Keyframe tracks that animate nothing are shown as what they are: identity tracks are dropped, constant ones appear as the static field (e.g. crop: {left: 0.31}). A graded clip carries `color` — its grade in apply_color's own vocabulary, pasteable to other clips via apply_color's color parameter. Other effects appear as effects: [{type, params}], the exact shape apply_effect accepts.\n\nCaption clips (sharing a captionGroupId) come back per track as captionGroups summaries: clipCount, frameRange, shared style, and a textPreview — individual caption clips and their ids are NOT listed. That summary is all you need to restyle (update_text with captionGroupId) or judge coverage; the spoken words live in get_transcript. Only when you must touch individual caption clips (retime one, delete one, fix one word's style), re-read with captionDetail:true — ideally windowed — to get [clipId, startFrame, endFrame, text] rows, capped at 200 per group. Caption clips whose properties deviate from the group always appear individually in clips.\n\nmarkers contains persistent review notes with markerId, name, comment, color, startFrame, endFrame, and durationFrames. Point markers have durationFrames 0; range markers use half-open [startFrame, endFrame). Windowed reads include only markers in or intersecting the window.",
            inputSchema: objectSchema({
                properties: {
                    "startFrame": {"type": "integer", "description": "Optional. Window start (inclusive); only clips intersecting [startFrame, endFrame) are returned. Omit both startFrame and endFrame for the whole timeline — never pass a zero-width window. Tracks report totalClips when the window hides some."},
                    "endFrame": {"type": "integer", "description": "Optional. Window end (exclusive); must be greater than startFrame. Omit for the whole timeline."},
                    "captionDetail": {"type": "boolean", "description": "Optional. true expands captionGroups into per-clip [clipId, startFrame, endFrame, text] rows. Combine with a window; only needed to edit individual caption clips."},
                }
            })
        },
{
            name: "inspect_timeline",
            description: "See the composited timeline — what the user actually sees in the preview at a given frame: all video tracks stacked with their transforms, opacity, crop, edge softness, edge rounding, and keyframes applied, plus text and caption overlays baked in. Use this to verify your edits landed (a PIP's position, a title's placement, layer order) — inspect_media shows the raw source asset, not the cut.\n\nFrames are project frames (from get_timeline). Pass a single startFrame for one composited frame; add endFrame to sample maxFrames evenly across [startFrame, endFrame) for a transition or sequence. Frames past content render black. Each image carries a 0–1 coordinate grid over the canvas (origin top-left) and its frame number burned into the top-left (f157). Metadata lists, per rendered frame, the clip ids visible on screen top-down (caption clips as their captionGroupId) — so what you see maps straight back to the clips to edit.",
            inputSchema: objectSchema({
                properties: {
                    "startFrame": {"type": "integer", "description": "Project frame to render (default 0). With no endFrame, a single frame is returned."},
                    "endFrame": {"type": "integer", "description": "Optional. Sample maxFrames evenly across [startFrame, endFrame) instead of one frame."},
                    "maxFrames": {"type": "integer", "description": "Frames to sample when endFrame is set (default 6, max 12)."},
                }
            })
        },
{
            name: "create_timeline",
            description: "Creates a timeline and switches to it — every read and edit tool now targets it. Without 'from', the new timeline is empty and inherits fps/resolution from the previously active one. With 'from', it's a full copy of that timeline — the versioning primitive: copy, then edit the copy (\"a tighter cut\", \"a 9:16 version\") while the original stays intact; every clip and track id in the copy is NEW, so re-read get_timeline before editing. Undoable.\n\nUse timelines to organize a project: alternate versions, sections assembled separately, or reusable groups. A timeline can be placed inside another as a single clip (add_clips with the timelineId as mediaRef); it then appears as a clip with mediaType 'sequence'.",
            inputSchema: objectSchema({
                properties: {
                    "name": {"type": "string", "description": "Optional display name. Defaults to 'Timeline N', or '<source> copy' when duplicating."},
                    "from": {"type": "string", "description": "Optional timelineId to duplicate instead of creating empty."},
                }
            })
        },
{
            name: "set_active_timeline",
            description: "Switches the active timeline — the one every read and edit tool targets and the one the user sees. get_media lists the project's timelines (with timelineId). Always re-read get_timeline after switching; clip and track ids from the previous timeline are no longer valid targets.\n\nTo edit the contents of a nested timeline (a clip with mediaType 'sequence'), switch to its mediaRef.",
            inputSchema: objectSchema({
                properties: {
                    "timelineId": {"type": "string", "description": "Timeline id from get_media's timelines list (or a sequence clip's mediaRef)."},
                },
                required: ["timelineId"]
            })
        },
{
            name: "manage_markers",
            description: "Creates, updates, or deletes one persistent timeline marker. A zero duration marks one frame; a positive duration is half-open. Status tracks the review workflow: open is awaiting work, review is ready for user approval, and resolved is accepted. Set review only after applying and verifying the requested edit. Set resolved only when the user explicitly approves or requests it.",
            inputSchema: objectSchema({
                properties: {
                    "action": {"type": "string", "enum": ["create", "update", "delete"]},
                    "markerId": {"type": "string", "description": "Required for update/delete. From get_timeline."},
                    "name": {"type": "string"},
                    "startFrame": {"type": "integer", "description": "Timeline frame."},
                    "durationFrames": {"type": "integer", "description": "0 for a point; positive for a range."},
                    "color": {"type": "string", "description": "#RGB, #RRGGBB, or #RRGGBBAA."},
                    "comment": {"type": "string"},
                    "status": {"type": "string", "enum": ["open", "review", "resolved"]},
                },
                required: ["action"]
            })
        },
{
            name: "set_project_settings",
            description: "Change the project's frame rate, resolution, or aspect ratio. Pass fps, explicit width+height, aspectRatio, or quality. aspectRatio accepts presets or a custom width:height value and preserves the current short-edge resolution unless quality is also supplied. Explicit width/height can't be combined with aspectRatio or quality. The timeline's existing clips are re-fitted automatically: auto-fit transforms recalculate for the new canvas size, and all frame positions/durations rescale when fps changes. Undoable.",
            inputSchema: objectSchema({
                properties: {
                    "fps": {"type": "integer", "description": "Frame rate in frames per second. Common values: 24, 25, 30, 48, 50, 60."},
                    "width": {"type": "integer", "description": "Canvas width in pixels. Requires height for an exact resolution. Mutually exclusive with aspectRatio and quality."},
                    "height": {"type": "integer", "description": "Canvas height in pixels. Requires width for an exact resolution. Mutually exclusive with aspectRatio and quality."},
                    "aspectRatio": {"type": "string", "description": "Canvas aspect ratio as width:height, such as '16:9', '3:2', or '2.39:1'. Preserves the current short edge, or uses quality when supplied. Mutually exclusive with width/height."},
                    "quality": {"type": "string", "enum": ["720p", "1080p", "2K", "4K"], "description": "Resolution quality preset — scales the short edge to the target while preserving the current (or specified) aspect ratio."},
                }
            })
        },
];

/** Definitions whose executors are not ported yet; never advertised. */
export const pendingTimelineDefinitions: ToolDefinition[] = [

];
