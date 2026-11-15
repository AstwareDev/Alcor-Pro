// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";
import { blendModes, layoutFits, TrackName, VolumeScale, videoLayouts } from "../../../model";

export const clipsDefinitions: ToolDefinition[] = [
{
            name: "add_clips",
            description: "Places one or more media assets on the timeline as a single undoable action. Each entry's asset type must be compatible with its target track (video/image are interchangeable across video/image tracks; audio requires an audio track). When a video asset with audio is placed on a video track, a linked audio clip is automatically created on an audio track (an existing one if available, otherwise a new one). The whole batch is one undo step.\n\ntrackIndex is optional. Omit it on all entries and the tool auto-creates the needed tracks — one shared video track for visual entries (above existing visuals) and one shared audio track for audio entries (appended below existing audio, so linked dialogue on A1 stays put and music/VO land on A2+). To target existing tracks, set trackIndex on every entry. Mixing (some entries specify, others omit) is rejected — split into two calls.\n\nTracks work as layers: clips on the SAME track are sequential — if a new clip's range overlaps an existing clip on that track, the existing clip is trimmed/split/removed to make room, matching the UI's drag-onto-track overwrite behavior.\n\nNESTING: mediaRef may also be a timelineId — the timeline is placed as a single live nested clip (mediaType 'sequence'), with a linked audio clip when the child has audio. Duration defaults to the child's full length; source and endFrame work as for video. Cycles (a timeline containing itself) and empty timelines are rejected.",
            inputSchema: objectSchema({
                properties: {
                    "entries": {
                        "type": "array",
                        "description": "Clips to add. Each entry is validated up front; one bad entry rejects the whole call with no partial state.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "mediaRef": {"type": "string", "description": "ID of the media asset from get_media"},
                                "trackIndex": {"type": "integer", "description": "Optional. Track index (0-based). Omit on every entry to auto-create one shared track per asset zone (video/audio)."},
                                "startFrame": {"type": "integer", "description": "Timeline frame position to place the clip (project frames)."},
                                "endFrame": {"type": "integer", "description": "Optional. Occupy timeline frames [startFrame, endFrame) — a gap from get_timeline copies straight in. For stills and frame-exact fills. Mutually exclusive with source."},
                                "source": {"type": "array", "items": {"type": "number"}, "description": "Optional. [startSeconds, endSeconds] — which span of the source to use, in the source seconds search_media hits and inspect_media segments speak. For stills this is the display length in seconds. Omit both for the whole asset. Mutually exclusive with endFrame."},
                            },
                            "required": ["mediaRef", "startFrame"],
                        },
                    },
                },
                required: ["entries"]
            })
        },
{
            name: "insert_clips",
            description: "Inserts one or more media assets at a single point and RIPPLES: every clip at or after atFrame is pushed right to open a gap, so nothing is overwritten. This is the non-destructive counterpart to add_clips (which clears the landing region, trimming/splitting/removing whatever's there). Use insert_clips to splice footage in without losing existing clips; use add_clips to fill empty space or deliberately overwrite.\n\nEntries are laid end-to-end starting at atFrame on the target track (entry[0] at atFrame, entry[1] immediately after, ...). The push equals the sum of the entries' durations and is applied to the target track, every sync-locked track, AND the audio track any auto-created linked audio lands on — so a clip and its linked audio stay aligned. As in add_clips, a video asset with audio spawns a linked audio clip. One undoable action; one bad entry rejects the whole call with no partial state.\n\ntrackIndex is required — ripple needs an existing track to push. For placement into empty space, use add_clips.\n\nAs in add_clips, mediaRef may be a timelineId to splice in a nested timeline.",
            inputSchema: objectSchema({
                properties: {
                    "trackIndex": {"type": "integer", "description": "Track index (0-based, from get_timeline) to insert into and ripple."},
                    "atFrame": {"type": "integer", "description": "Timeline frame (project frames) where insertion begins. Every clip at or after this frame on rippled tracks shifts right by the total inserted duration."},
                    "entries": {
                        "type": "array",
                        "description": "Clips to insert, placed sequentially from atFrame. Validated up front; one bad entry rejects the whole call.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "mediaRef": {"type": "string", "description": "ID of the media asset from get_media."},
                                "source": {"type": "array", "items": {"type": "number"}, "description": "Optional. [startSeconds, endSeconds] — which span of the source to use, in source seconds; for stills, the display length. Omit for the whole asset. Mutually exclusive with durationFrames."},
                                "durationFrames": {"type": "integer", "description": "Optional. Exact length in project frames (entries stack end-to-end, so they have lengths, not positions). Mutually exclusive with source."},
                            },
                            "required": ["mediaRef"],
                        },
                    },
                },
                required: ["trackIndex", "atFrame", "entries"]
            })
        },
{
            name: "move_clips",
            description: "Moves one or more clips to a new track and/or frame position. Single undoable action. Each move specifies the clip ID and at least one of toTrack (must be compatible with the clip's media type) and toFrame. Overlap on the destination is resolved as in add_clips (existing clips on the destination track are trimmed/split/removed). Linked partners follow the named clip: startFrame propagates as a delta to preserve l-cut / j-cut offsets; tracks stay with the named clip. Multicam clips must move as a whole group; partial group moves and camera lane changes are refused.",
            inputSchema: objectSchema({
                properties: {
                    "moves": {
                        "type": "array",
                        "description": "Per-clip move requests. At least one of toTrack or toFrame is required per entry.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "clipId": {"type": "string", "description": "The clip ID to move."},
                                "toTrack": {"type": "integer", "description": "Destination track index (0-based). Omit to keep the clip on its current track."},
                                "toFrame": {"type": "integer", "description": "Destination start frame. Omit to keep the clip at its current start."},
                            },
                            "required": ["clipId"],
                        },
                    },
                },
                required: ["moves"]
            })
        },
{
            name: "remove_clips",
            description: "Removes one or more clips by ID as a single undoable action. Any clip that belongs to a link group (e.g. a video with its paired audio) takes its whole group with it, matching the UI's linked-delete behavior.",
            inputSchema: objectSchema({
                properties: {
                    "clipIds": {
                        "type": "array",
                        "description": "Clip IDs to remove.",
                        "items": {"type": "string"},
                    },
                },
                required: ["clipIds"]
            })
        },
{
            name: "manage_clip_links",
            description: "Links or unlinks clips as one undoable action without moving, trimming, or aligning them. link merges the complete existing groups touched by clipIds and requires at least two clips of different media types. unlink accepts one or more members and dissolves each member's complete link group. Use unlink before independently trimming the audio or video side of a J-cut or L-cut; relink afterward when the clips should move together again.",
            inputSchema: objectSchema({
                properties: {
                    "action": {
                        "type": "string",
                        "enum": ["link", "unlink"],
                    },
                    "clipIds": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                required: ["action", "clipIds"]
            })
        },
{
            name: "manage_tracks",
            description: "Reorders, names, configures, or removes tracks in one undoable action. Prefer stable trackId selectors; numeric indexes use the order at call time. Index 0 renders on top, and reorder destinations must stay within the track's video/audio zone. Arrays run reorder → set → remove. User-authored names are returned separately from generated V1/A1 labels. Returns receipts and the resulting track order. Tracks holding multicam clips can't be removed or sync-unlocked.",
            inputSchema: objectSchema({
                properties: {
                    "reorder": {
                        "type": "array",
                        "description": "Moves, applied in order. Use to fix stacking, e.g. bring a PIP inset's track to index 0.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "trackId": {"type": "string", "description": "Stable track ID from get_timeline."},
                                "index": {"type": "integer", "description": "Track to move (0-based, current order)."},
                                "to": {"type": "integer", "description": "Exact destination index in the same type zone."},
                            },
                            "required": ["to"],
                        },
                    },
                    "set": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "trackId": {"type": "string", "description": "Stable track ID from get_timeline."},
                                "index": {"type": "integer", "description": "Track to change (0-based, current order)."},
                                "muted": {"type": "boolean", "description": "Silence/unsilence the track's audio."},
                                "hidden": {"type": "boolean", "description": "Exclude/include a video track in the render."},
                                "syncLocked": {"type": "boolean", "description": "Whether ripple edits shift this track along."},
                                "name": {
                                    "type": "string",
                                    "maxLength": TrackName.maximumLength,
                                    "description": "Prefer exactly one short word with no spaces. Avoid generic suffixes: use Main, Brand, Headline, Outro, Product, Dialogue, Music, SFX, Ambience, or Foley; not Main Video, Brand Text, Outro Video, or Audio Bed. Preserve an exact user-supplied name and pass an empty string to clear it.",
                                },
                            },
                        },
                    },
                    "remove": {
                        "type": "array",
                        "description": "Tracks to remove with all their clips. Prefer {trackId}; bare integers are legacy current indexes.",
                        "items": {"type": ["integer", "object"], "properties": {"trackId": {"type": "string"}}},
                    },
                }
            })
        },
{
            name: "split_clips",
            description: "Splits clips into two at one or more cut points, all in a single undoable action. A split only inserts a boundary — it never trims media or moves clips, so unlike ripple_delete_ranges nothing shifts and there's no gap to close.\n\nTwo modes — pass exactly one:\n• splits: an array of {clipId, atFrame} (project frames). Use when you know the clip IDs.\n• trackIndex + frames: cut one track at the given project frames; each frame is matched to whichever clip on that track contains it. Pairs naturally with get_transcript / get_timeline project frames.\n\nEvery frame must fall strictly between a clip's start and end. Multiple cuts on the SAME clip are allowed — pass all the frames at once and each is resolved against the current sub-clips. Duplicate cut points are ignored. Linked audio/video partners are split at the same frame so A/V stays in sync, and the right halves are regrouped into their own link pair. One bad cut point rejects the whole call with no partial state.",
            inputSchema: objectSchema({
                properties: {
                    "splits": {
                        "type": "array",
                        "description": "Explicit cuts. Each item is {clipId, atFrame}.",
                        "items": objectSchema({
                            properties: {
                                "clipId": {"type": "string", "description": "The clip ID to split"},
                                "atFrame": {"type": "integer", "description": "Project frame to split at (strictly between clip start and end)"},
                            },
                            required: ["clipId", "atFrame"]
                        }),
                    },
                    "trackIndex": {"type": "integer", "description": "Track to cut (use with 'frames')"},
                    "frames": {
                        "type": "array",
                        "description": "Project frames to cut on trackIndex; each is matched to the clip containing it.",
                        "items": {"type": "integer"},
                    },
                },
                required: []
            })
        },
{
            name: "ripple_delete_ranges",
            description: "Cuts one or more ranges out and closes the gaps in one undoable action — the fast path for filler-word/dead-air removal. Replaces hand-cranked split_clips → remove_clips → move_clips loops: pass every range at once.\n\nTwo modes — pass exactly one of clipId or trackIndex:\n• trackIndex (preferred for transcript-driven cuts): ranges are PROJECT frames and may span any number of clips on that track. get_transcript returns a clips array with nested words in project frames — collect every cut across the whole timeline and pass them in ONE call, no per-clip splitting and no re-reading the timeline between cuts. units must be 'frames'.\n• clipId: ranges are cut within that single clip only, clamped to its visible span. Allows units 'seconds' (source-media seconds, e.g. inspect_media WITHOUT a clipId or search_media hits); 'frames' = project frames. Use when you already have one clip's per-word timestamps.\n\nOverlapping ranges merge. Linked audio/video partners of every touched clip are cut on the same span so A/V stays in sync. Remaining clips shift left to close every gap; sync-locked tracks shift along to preserve alignment (their content isn't cut). Refuses without changing anything if a sync-locked track can't absorb the shift (e.g. it would move past frame 0). The refusal names the blocking track (e.g. \"V2\") — map it to its index via get_timeline and pass that index in ignoreSyncLockedTracks to cut anyway, leaving that track's clips in place. Returns the anchor track's post-cut layout (clip ids/frames) so you don't need to re-read.",
            inputSchema: objectSchema({
                properties: {
                    "trackIndex": {"type": "integer", "description": "Cut project-frame ranges spanning every clip they cross on this track, in one call. From get_transcript's clips array. Mutually exclusive with clipId; requires units 'frames'."},
                    "clipId": {"type": "string", "description": "Cut ranges within this single clip only, clamped to its visible span. Mutually exclusive with trackIndex."},
                    "ranges": {
                        "type": "array",
                        "description": "Ranges to remove, each a [start, end] pair (end > start). In the unit given by 'units'.",
                        "items": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
                    },
                    "units": {"type": "string", "enum": ["seconds", "frames"], "description": "Interpretation of range values. 'frames' (default) = project/timeline frames, matching get_transcript and inspect_media-with-clipId. 'seconds' = source-media seconds (clipId mode only)."},
                    "ignoreSyncLockedTracks": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Track indices to exempt from sync-lock for this call only. Their clips stay put instead of shifting to close the gap. Use to get past a refusal naming a sync-locked overlay track (e.g. a text track that can't absorb the shift) when the cut doesn't touch that track's content.",
                    },
                },
                required: ["ranges"]
            })
        },
{
            name: "swap_clip_media",
            description: "Replace a clip's source with another library asset while preserving its edit, timing, framing, effects, and keyframes. Linked video/audio clips that share the source are updated together. The replacement must have the same source type, contain audio when a linked audio clip needs it, and cover the current source range; extra tail remains available for trimming. Text, nested timeline, and multicam clips are refused; use change_cam for multicam.",
            inputSchema: objectSchema({
                properties: {"clipId": {"type": "string", "description": "Clip ID from get_timeline."},
                             "mediaRef": {"type": "string", "description": "Replacement asset ID from get_media."}},
                required: ["clipId", "mediaRef"]
            })
        },
{
            name: "set_clip_properties",
            description: "Apply the same generic clip property values to one or more clips in a single undoable action. Pass any combination of durationFrames, trimStartFrame, trimEndFrame, speed, volumeDb, opacity, fades, edgeRounding, edgeSoftness, transform, crop, or blendMode (video/image clips only). For text content, typography, captions, and text animation, use update_text.\n\nNOT for preview layout — split screen, picture-in-picture, grid, sidebar, and any multi-clip canvas arrangement belong to apply_layout, which sets transform and crop together. Do not use transform or crop here (or set_keyframes position/scale/crop) to build those layouts.\n\nAll values apply to every clip in clipIds; for per-clip differences, make separate calls. trimStartFrame/trimEndFrame are offsets from the source media, not the timeline. speed 1.0 is normal, <1.0 slows (clip gets longer on the timeline), >1.0 speeds up. volumeDb is −60 through +15 dB; 0 dB keeps source level and −60 dB is mute. opacity is 0.0–1.0. fadeInFrames/fadeOutFrames are clip-relative lengths; 0 clears that fade, and their sum must fit within the resulting clip duration. Fades multiply existing opacity or volume keyframes instead of replacing them: visual/text clips fade opacity, while audio clips fade gain. Fades are per-clip and don't propagate to linked media — include both the visual clip id and its nested audio.id from get_timeline to fade picture and sound together. edgeRounding and edgeSoftness are 0.0–1.0, where 1 reaches half the shorter visible edge. transform is for rare single-clip tweaks only — 0–1 normalized canvas coords, partial merge; rotation is clockwise degrees; flipHorizontal/flipVertical mirror across the axis.\n\nFor moves and start-frame changes, use move_clips. For animated values (keyframes), use set_keyframes — setting volumeDb, opacity, transform.rotation, or crop here clears any existing keyframe track on that property.\n\nTiming changes (durationFrames, trimStartFrame, trimEndFrame, speed) on a linked clip carry over to its linked partner so audio/video stay in sync — same as the timeline UI. Per-clip fields (volumeDb, opacity, fades, edgeRounding, edgeSoftness, transform, crop, blendMode) don't propagate. trim and speed are skipped for text partners.\n\nTiming fields (trims, durationFrames, speed) are refused on multicam clips — they would slip the clip out of sync; property fields stay editable, and angle changes go through change_cam.",
            inputSchema: objectSchema({
                properties: {
                    "clipIds": {
                        "type": "array",
                        "description": "Clip IDs to update. The property values below apply to every clip in this list.",
                        "items": {"type": "string"},
                    },
                    "durationFrames": {"type": "integer", "description": "New duration in frames."},
                    "trimStartFrame": {"type": "integer", "description": "SOURCE-media offset, NOT a timeline frame: frames trimmed off the start of the source — measured in PROJECT frames (the timeline's fps, same units as startFrame/durationFrames; never the source's own fps). To turn a get_transcript project frame P into this clip's source offset, use trimStartFrame + (P − startFrame) × speed; setting trimStartFrame to that value makes the clip begin at P's source content."},
                    "trimEndFrame": {"type": "integer", "description": "SOURCE-media offset, NOT a timeline frame: frames trimmed off the end of the source, in PROJECT frames. Maps the same way as trimStartFrame via startFrame/speed."},
                    "speed": {"type": "number", "description": "Playback speed multiplier (default 1.0). >1 speeds up, <1 slows down. The clip's timeline length is rescaled to keep the same source content (2x speed → half the frames), unless you also pass durationFrames to set the length explicitly."},
                    "volumeDb": {
                        "type": "number",
                        "minimum": VolumeScale.floorDb,
                        "maximum": VolumeScale.ceilingDb,
                        "description": "Volume in decibels from −60 through +15. 0 dB keeps source level; −60 dB is mute. Clears existing volume keyframes.",
                    },
                    "opacity": {"type": "number", "description": "Opacity 0.0-1.0. Clears any existing opacity keyframes."},
                    "fadeInFrames": {"type": "integer", "minimum": 0, "description": "Fade length from the clip's first frame. 0 clears it. Multiplies existing opacity/volume keyframes."},
                    "fadeOutFrames": {"type": "integer", "minimum": 0, "description": "Fade length ending at the clip's last frame. 0 clears it. fadeInFrames + fadeOutFrames must not exceed the resulting clip duration."},
                    "fadeInInterpolation": {"type": "string", "enum": ["linear", "smooth"], "description": "Curve for the fade in. Omit to keep the current curve."},
                    "fadeOutInterpolation": {"type": "string", "enum": ["linear", "smooth"], "description": "Curve for the fade out. Omit to keep the current curve."},
                    "edgeRounding": {"type": "number", "minimum": 0, "maximum": 1, "description": "Video, image, Lottie, and nested timeline clips only. Uniform edge rounding from 0 (square) to 1 (half the shorter visible edge)."},
                    "edgeSoftness": {"type": "number", "minimum": 0, "maximum": 1, "description": "Video, image, Lottie, and nested timeline clips only. Edge feathering from 0 (crisp) to 1 (half the shorter visible edge)."},
                    "transform": {
                        "type": "object",
                        "description": "Single-clip only — not for split screen, PIP, or grid (use apply_layout). Partial transform; omitted fields keep current values. Static rotation uses clockwise degrees and clears rotation keyframes.",
                        "properties": {
                            "centerX": {"type": "number"},
                            "centerY": {"type": "number"},
                            "width": {"type": "number"},
                            "height": {"type": "number"},
                            "rotation": {"type": "number", "description": "Clockwise degrees."},
                            "flipHorizontal": {"type": "boolean", "description": "Mirror across the vertical axis."},
                            "flipVertical": {"type": "boolean", "description": "Mirror across the horizontal axis."},
                        },
                    },
                    "crop": {
                        "type": "object",
                        "description": "Static source crop for video, image, Lottie, and nested timeline clips. Partial; omitted edges keep current values. Insets are 0–1 of the source (left/top/right/bottom). All zeros restore the full source. Clears crop keyframes. Not for split screen/PIP/grid — use apply_layout.",
                        "properties": {
                            "left": {"type": "number", "description": "Inset from the source left edge, 0–1."},
                            "top": {"type": "number", "description": "Inset from the source top edge, 0–1."},
                            "right": {"type": "number", "description": "Inset from the source right edge, 0–1."},
                            "bottom": {"type": "number", "description": "Inset from the source bottom edge, 0–1."},
                        },
                    },
                    "blendMode": {
                        "type": "string",
                        "enum": [...blendModes],
                        "description": "Video/image clips only. How the clip composites over the tracks below it (Premiere/Photoshop blend modes). 'normal' is the default (source-over) and clears any blend. Rejected on text/audio clips.",
                    },
                },
                required: ["clipIds"]
            })
        },
{
            name: "copy_clip_settings",
            description: "Copy one clip's static settings to one or more clips of the same media type in a single undoable action. Use for requests such as \"make these shots look like that one,\" \"use this title style,\" or \"give these audio clips the same treatment.\"\n\nChoose exactly one target mode. targetClipIds applies to an explicit list and refuses any mismatched media type. targetTrack selects every same-type clip on one stable trackId; add range [startFrame, endFrame) to limit it to clips intersecting that part of the timeline. Track mode excludes the source and mismatched clips, returns compact matched/changed/unchanged/incompatible counts instead of clip IDs, and refuses when no compatible clips match.\n\nVideo, image, Lottie, and nested-timeline clips copy transform, crop, opacity, edge rounding/softness, blend mode, and the complete effect stack including color. Text clips copy typography/style, text animation, fill mode, position, rotation, flips, opacity, and effects; target text, word timings, and caption membership stay intact, and the box is refit to the target content. Audio clips copy volume and effects, including denoise. Settings absent from the source clear the corresponding target setting.\n\nThis does NOT copy placement, duration, trims, speed, fades, top-level keyframes, media, links, caption groups, or multicam membership. Use set_clip_properties and set_keyframes for temporal changes. Linked audio is a separate audio clip: copy it explicitly using the nested audio.id from get_timeline.",
            inputSchema: objectSchema({
                properties: {
                    "sourceClipId": {"type": "string", "description": "Clip whose current static settings are copied."},
                    "targetClipIds": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Explicit destination clips. Every target must have the same mediaType as the source. Use this or targetTrack, not both.",
                    },
                    "targetTrack": objectSchema({
                        properties: {
                            "trackId": {"type": "string", "description": "Stable trackId from get_timeline."},
                            "range": {
                                "type": "array",
                                "items": {"type": "integer"},
                                "minItems": 2,
                                "maxItems": 2,
                                "description": "Optional [startFrame, endFrame) timeline range. Only intersecting clips are considered; omit for the whole track.",
                            },
                        },
                        required: ["trackId"]
                    }),
                },
                required: ["sourceClipId"]
            })
        },
{
            name: "set_keyframes",
            description: "Set animated keyframes on one property of one clip. Replaces the existing keyframe track for that property (pass an empty array to clear). Frames are CLIP-RELATIVE offsets (0 = first frame of the clip), so keyframes follow the clip when it moves. Rows are sorted by frame internally and the LAST row for any duplicate frame wins. Values must be finite numbers. Each row is `[frame, ...values, interp?, bezier?]` where interp ∈ {linear, hold, smooth, easeIn, easeOut, easeInOut, bezier} (default smooth) is the easing of the segment LEAVING that keyframe; interp 'bezier' takes a final `[x1, y1, x2, y2]` cubic-bezier curve (x within 0-1, y may overshoot).\n\nProperties and their value layouts:\n  • volumeDb `[frame, decibels]` — −60 through +15 dB; 0 dB keeps source level and −60 dB is mute\n  • opacity `[frame, value]` — value 0.0–1.0\n  • rotation `[frame, degrees]` — clockwise degrees\n  • position `[frame, topLeftX, topLeftY]` — TOP-LEFT corner in 0–1 normalized canvas coords. NOT the center. (Default static transform centers a full-canvas clip, so top-left of the static is (0, 0); a centered half-size clip has top-left (0.25, 0.25).)\n  • scale `[frame, width, height]` — clip's normalized width and height in 0–1 canvas coords (1.0 = fills the canvas axis), NOT a scale factor. Text clips use this same track; use matching width/height ratios for uniform text scale.\n  • crop `[frame, top, right, bottom, left]` — animated side insets in 0–1 of the source media. Constant crop belongs on set_clip_properties.\n  • blur `[frame, radius]` — whole-layer Gaussian blur from 0–100 px; supported by visual clips including video, images, text, and nested timelines.\n\nMotion keyframes (position/scale/rotation) override the static `transform` value when active.",
            inputSchema: objectSchema({
                properties: {
                    "clipId": {"type": "string", "description": "The clip ID."},
                    "property": {
                        "type": "string",
                        "enum": ["volumeDb", "opacity", "rotation", "position", "scale", "crop", "blur"],
                        "description": "Which property's keyframe track to set.",
                    },
                    "keyframes": {
                        "type": "array",
                        "description": "Replacement keyframe rows. Empty array clears the track. Row shape depends on property — see tool description.",
                        "items": {"type": "array"},
                    },
                },
                required: ["clipId", "property", "keyframes"]
            })
        },
{
            name: "set_speed_ramp",
            description: "Time-remap one clip with a speed ramp (variable speed) in one undoable action. The clip keeps its timeline length; source time is the integral of the speed curve, so a preset slows and speeds the same source range. Pass either 'preset' or 'keyframes'.\n\n'preset' is one of: none (remove the ramp), montage (fast-slow-fast), hero (normal, dramatic slow-mo, normal), bullet (extreme slow-mo with fast ends), flashIn (very fast start settling to normal), flashOut (normal ending in a fast flash), smoothSlowMo (eased dip into slow-mo). Presets are scaled so the clip's average speed stays what it is now.\n\n'keyframes' rows are [frame, speed, interp?, bezier?] with CLIP-RELATIVE frames (0 = first frame, below the clip length), speed 0.05-20 (1 = normal), interp in {linear, hold, smooth, easeIn, easeOut, easeInOut, bezier} for the segment leaving that keyframe, and a [x1, y1, x2, y2] curve for 'bezier'. An empty array removes the ramp. The clip's speed becomes the ramp's average and trimEndFrame is adjusted to keep the same total source range. Linked audio/video partners are ramped together; preview audio keeps its pitch, exports follow the speed (varispeed).\n\n'frameBlending' mixes adjacent source frames when slower than 1x (applied in export) and can be set alone. Refused on multicam clips. A later set_clip_properties speed change rescales the ramp proportionally.",
            inputSchema: objectSchema({
                properties: {
                    "clipId": {"type": "string", "description": "The clip ID."},
                    "preset": {"type": "string", "enum": ["none", "montage", "hero", "bullet", "flashIn", "flashOut", "smoothSlowMo"], "description": "Named ramp. 'none' removes the ramp."},
                    "keyframes": {"type": "array", "description": "Explicit speed keyframes [frame, speed, interp?, bezier?]. Empty array removes the ramp.", "items": {"type": "array"}},
                    "frameBlending": {"type": "boolean", "description": "Blend adjacent frames while slower than 1x (export)."},
                },
                required: ["clipId"]
            })
        },
{
            name: "apply_layout",
            description: "Arrange multiple clips into a common multi-video layout (split screen, picture-in-picture, grid) in one undoable action — the fast path for composing several videos in one frame. Use this instead of hand-setting transforms and screenshot-checking alignment with inspect_timeline.\n\nYou pick a named layout and assign a clip to each of its slots; the tool computes every transform and crop so each clip FILLS its region edge-to-edge WITHOUT stretching — the source is cropped to the slot's shape (cover), like a layout template the videos are dropped into. Pass fit='fit' to letterbox the whole source inside its slot instead (no crop, may leave bars) — use only when the full frame must stay visible (e.g. a screen recording).\n\nThe crop is centered by default. When that chops off something important (a face cropped at the forehead, a subject off to one side), bias which part survives: 'anchor' is a coarse shortcut ('top' keeps the top, etc.), while anchorX/anchorY (0–1) give continuous control for in-between framing — e.g. anchorY 0.35 moves the crop only slightly toward the top, not all the way. To nudge framing after the fact, call apply_layout again with adjusted anchorX/anchorY (clipIds mode re-crops in place).\n\nTwo modes (don't mix across slots):\n• Place new clips: give each slot a 'mediaRef' (media asset from get_media, or a timelineId to nest) plus top-level startFrame (default 0) and endFrame. Creates one stacked video track per slot at that time range; for PIP the inset is placed on top automatically. Video and nested-timeline clips bring their linked audio.\n• Re-layout existing clips: give each slot 'clipIds' — one or more existing clips (video, image, or nested timeline / mediaType 'sequence'), all framed into that slot (handy when a track holds several sequential takes). Only transforms/crop change — timing and tracks are untouched (so existing track order decides stacking).\n\nEvery slot of the chosen layout must be filled. Layouts and their slot names:\n  • full — main\n  • side_by_side — left, right\n  • top_bottom — top, bottom\n  • pip_bottom_right / pip_bottom_left / pip_top_right / pip_top_left — main, inset\n  • grid_2x2 / grid_3x3 / grid_4x4 — equal cells named rNcN, counting from the TOP-LEFT: row 1 is the top row, column 1 is the left column. So r1c1 is top-left, a 3x3's middle is r2c2, and a 3x3's bottom-right is r3c3\n  • main_sidebar — main (70%), sidebar (30%)\n  • three_up — left, center, right (three vertical columns)\n  • three_stack — top, middle, bottom (three horizontal rows)",
            inputSchema: objectSchema({
                properties: {
                    "layout": {
                        "type": "string",
                        "enum": [...videoLayouts],
                        "description": "Which layout template to apply.",
                    },
                    "slots": {
                        "type": "array",
                        "description": "One entry per slot of the chosen layout. Each entry names a 'slot' and gives exactly one of 'mediaRef' (place a new clip) or 'clipIds' (re-layout existing clip(s) into that slot). Don't mix placement (mediaRef) with re-layout (clipIds) across slots.",
                        "items": objectSchema({
                            properties: {
                                "slot": {"type": "string", "description": "Slot name for the chosen layout (e.g. 'left', 'inset', or 'r1c1' for the top-left grid cell)."},
                                "mediaRef": {"type": "string", "description": "Asset ID from get_media, or a timelineId to nest as a sequence clip. Use this OR clipIds."},
                                "clipIds": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "Existing clip(s) to frame into this slot — video, image, or nested timeline (mediaType 'sequence'). Every listed clip gets this slot's transform/crop (pass one id for a single clip, or several when a track holds sequential takes). Use this OR mediaRef. Clips sharing a slot may sit on the same track; clips in DIFFERENT slots still must not overlap on one track.",
                                },
                                "anchor": {
                                    "type": "string",
                                    "enum": ["center", "top", "bottom", "left", "right", "top_left", "top_right", "bottom_left", "bottom_right"],
                                    "description": "Coarse shortcut for which part of the source to keep when cover-cropping (default center). For in-between framing use anchorX/anchorY instead — the named values are just shortcuts for them.",
                                },
                                "anchorX": {"type": "number", "description": "Fine horizontal framing, 0–1: 0 keeps the left edge, 0.5 centers (default), 1 keeps the right. Only affects slots cropped horizontally. Overrides anchor's x."},
                                "anchorY": {"type": "number", "description": "Fine vertical framing, 0–1: 0 keeps the top (e.g. a forehead), 0.5 centers (default), 1 keeps the bottom. Nudge by small amounts (e.g. 0.35) to move the crop gradually. Only affects slots cropped vertically. Overrides anchor's y."},
                            },
                            required: ["slot"]
                        }),
                    },
                    "startFrame": {"type": "integer", "description": "Placement mode only (mediaRef slots). Project frame where the layout begins. Default 0."},
                    "endFrame": {"type": "integer", "description": "Placement mode only (mediaRef slots). The placed clips occupy [startFrame, endFrame). Required when placing new clips."},
                    "fit": {
                        "type": "string",
                        "enum": [...layoutFits],
                        "description": "How each clip fills its slot. 'fill' (default) covers the slot and center-crops the source (no stretch). 'fit' letterboxes the whole source inside the slot.",
                    },
                },
                required: ["layout", "slots"]
            })
        },
{
            name: "undo",
            description: "Reverts the latest action from the editor's shared undo history, whether the user or agent made it. Call only when that latest action should be reversed. For example, verify a cut with get_transcript, then undo if it overshot and retry with corrected ranges. After undoing, ids and frames returned by the reverted action may be invalid; re-read with get_timeline or get_transcript before editing again. Takes no arguments.",
            inputSchema: objectSchema({})
        },
];
