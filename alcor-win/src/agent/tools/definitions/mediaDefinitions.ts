// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";


export const mediaDefinitions: ToolDefinition[] = [
{
            name: "organize_media",
            description: "Reorganizes the library in one undoable action: create folders, move items into folders, rename items, delete items. An item is a media asset id (from get_media), a timelineId, or a folder path like 'B-roll/Sunset' — the tool tells them apart. Folders are always addressed by path, never by id; destination paths are created if missing. Arrays apply in order (createFolders, moves, renames, deletes), but item references resolve against the library as it was before the call — only 'into' destinations may name folders the same call creates.\n\nDeleting an asset also removes every clip referencing it (reported as clipsRemoved). Deleting a folder deletes its subfolders and assets; timelines inside move to the root instead. Deleting a timeline leaves nest clips referencing it rendering black (a warning reports how many); the last remaining timeline can't be deleted. Returns only what actually happened — createdFolders, moved, renamed, deleted, clipsRemoved, warnings.",
            inputSchema: objectSchema({
                properties: {
                    "createFolders": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Folder paths to ensure exist, e.g. ['Hero shots/Takes']. Existing folders are left alone. Rarely needed — moves and generation 'folder' params create folders on their own.",
                    },
                    "moves": {
                        "type": "array",
                        "description": "Each entry files items into one destination folder.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "items": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "Asset ids, timeline ids, and/or folder paths to move.",
                                },
                                "into": {"type": "string", "description": "Destination folder path; created if missing. Omit to move to the project root."},
                            },
                            "required": ["items"],
                        },
                    },
                    "renames": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "item": {"type": "string", "description": "Asset id, timeline id, or folder path."},
                                "name": {"type": "string", "description": "New display name (a name, not a path — renaming never moves)."},
                            },
                            "required": ["item", "name"],
                        },
                    },
                    "deletes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Asset ids, timeline ids, and/or folder paths to delete.",
                    },
                }
            })
        },
{
            name: "capture_frame",
            description: "Capture one video frame as a full-resolution PNG media asset. Use timelineFrame to capture the active timeline's final composited image, including transforms, crop, edge softness, edge rounding, color, effects, text, and captions. Use mediaRef with sourceSeconds to capture an unedited frame directly from a source video instead. Pass the asset's durationSeconds as sourceSeconds to capture its final decodable frame. Exactly one mode is allowed. The returned mediaRef is ready for add_clips, generate_video startFrameMediaRef/endFrameMediaRef, generate_image references, or inspect_media. Every call creates one new undoable media asset.",
            inputSchema: objectSchema({
                properties: {
                    "timelineFrame": {"type": "integer", "description": "Project frame in the active timeline. Use this alone for the composited timeline image."},
                    "mediaRef": {"type": "string", "description": "Video asset ID from get_media. Use with sourceSeconds for a raw source frame."},
                    "sourceSeconds": {"type": "number", "description": "Source time in seconds for mediaRef. May equal durationSeconds to select the final decodable frame."},
                    "name": {"type": "string", "description": "Optional media-library name for the captured PNG."},
                }
            })
        },
{
            name: "get_media",
            description: "The library inventory: media assets, folders, and timelines. Call before referencing any asset — every mediaRef in other tools comes from the asset ids returned here. Assets report name, type, durationSeconds, width/height/fps, hasAudio, folder path, and (for AI-generated assets) the generation prompt as a content hint. generationStatus appears only while an async generation/import is unresolved (preparing | generating | downloading | failed) — its absence means the asset is ready.\n\nFilters: ids (poll specific placeholders cheaply), folder (a path; includes subfolders), pending:true (only unresolved generations/imports). Filtered reads return just the matching assets; unfiltered reads also include folders (as paths) and timelines.",
            inputSchema: objectSchema({
                properties: {
                    "ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional. Return only these asset ids — the cheap way to poll a generation placeholder.",
                    },
                    "folder": {"type": "string", "description": "Optional folder path filter, e.g. 'B-roll/Sunset'. Includes subfolders."},
                    "pending": {"type": "boolean", "description": "Optional. true returns only assets with an unresolved generationStatus."},
                }
            })
        },
{
            name: "inspect_media",
            description: "Look at a media asset before referencing or editing it. Images: the image plus dimensions and EXIF. Video: sample frames plus a transcription of the audio track. Audio: transcription. Lottie: frames sampled evenly across the animation (over gray), plus framerate and duration — use this to verify a Lottie you wrote looks and moves right. Sampled frames and stills overlay a 0–1 coordinate grid (origin top-left). Overview storyboards do not include the grid. Transcription is sentence-level segments — [text, start, end] tuples, capped at 400 — in source seconds, or project frames when clipId is set. When capped, pass the returned nextStartSeconds as startSeconds for the next page.\n\nLong media: pass overview=true for a one-image storyboard, read the segments, then re-call with startSeconds/endSeconds to zoom — windowed calls only transcribe that span, so they are fast.",
            inputSchema: objectSchema({
                properties: {
                    "mediaRef": {"type": "string", "description": "Asset ID from get_media."},
                    "clipId": {"type": "string", "description": "Optional. A clip referencing this mediaRef; transcript times come back as project frames for that clip (out-of-range entries dropped)."},
                    "maxFrames": {"type": "integer", "description": "Video and Lottie. Sample frame count (default 6, max 12)."},
                    "startSeconds": {"type": "number", "description": "Video/audio. Source-time window start; scopes frames and transcription."},
                    "endSeconds": {"type": "number", "description": "Video/audio. Window end (default: asset duration)."},
                    "wordTimestamps": {"type": "boolean", "description": "Video/audio. Add word-level [text, start, end] tuples (capped at 10000 — most clips return all words at once; narrow with startSeconds/endSeconds only for very long media). Use for word-boundary edits like filler-word removal."},
                    "overview": {"type": "boolean", "description": "Video only. One storyboard grid of visually distinct, timestamped moments instead of frames — far more coverage per token; few tiles means static footage. maxFrames ignored."},
                    "language": {"type": "string", "description": "Optional BCP-47 language tag of the spoken audio (e.g. 'es', 'fr', 'ja', 'zh-Hans'). Defaults to the system language. Specify when the spoken language differs from the system locale — on-device models are language-specific and will produce garbled output if the wrong language is used."},
                },
                required: ["mediaRef"]
            })
        },
{
            name: "import_media",
            description: "Imports external media into the project's library — the bridge for assets coming from other MCP servers (stock libraries, music services, web search) or local files the user already has. The 'source' object must set exactly one of: url (HTTPS only — downloaded in the background, the dominant case; max 1 GB), path (absolute local file path — referenced in place and not copied into the project; may also be a directory, which is imported recursively, mirroring its subfolder structure as media folders), bytes (base64-encoded inline data — max ~15 MB of base64 ≈ 11 MB binary; use url/path for anything larger), or matte (a generated solid-color PNG). For url, type is inferred from the URL path's file extension unless source.mimeType is set as an override (needed for signed URLs whose path has no usable extension). For bytes, source.mimeType is required.\n\nSupported types and extensions: video (mov, mp4, m4v), audio (mp3, wav, aac, m4a, aiff, aifc, caf, flac), image (png, jpg, jpeg, tiff, heic), subtitle (srt, vtt — becomes a subtitle asset; place its cues as caption clips at their timecodes via add_captions subtitleMediaRef or a user drag onto the timeline; not placeable via add_clips). Anything else is rejected — the caller must transcode externally.\n\nURL imports run in the background and return {mediaRef, status:'downloading'} — poll get_media with ids:[mediaRef] until generationStatus clears, then the asset is usable in add_clips. Path, directory, bytes, and matte imports finish inline with status:'ready'. Costs nothing.",
            inputSchema: objectSchema({
                properties: {
                    "source": {
                        "type": "object",
                        "description": "Exactly one of url, path, bytes, or matte must be set. mimeType is required when bytes is set; for url it acts as a type-inference override.",
                        "properties": {
                            "url": {"type": "string", "description": "HTTPS URL. Pre-signed URLs are fine but must not expire mid-download."},
                            "path": {"type": "string", "description": "Absolute local file or directory path, readable by the Palmier process. Files are referenced in place and must remain available. A directory is imported recursively and its folder structure is replicated as media folders."},
                            "bytes": {"type": "string", "description": "Base64-encoded media data. Prefer url or path for anything over ~10MB."},
                            "matte": {
                                "type": "object",
                                "description": "Generates a solid-color PNG matte instead of importing a file.",
                                "properties": {
                                    "hex": {"type": "string", "description": "Hex color, e.g. '#000000' or '#FFFFFF'."},
                                    "aspectRatio": {
                                        "type": "string",
                                        "enum": ["Project", "16:9", "9:16", "1:1", "4:3", "9:14", "2.4:1"],
                                        "description": "Defaults to Project (timeline resolution). Other values use the project's short edge.",
                                    },
                                },
                                "required": ["hex"],
                            },
                            "mimeType": {"type": "string", "description": "Required when bytes is set. Optional override for url when its path has no usable extension (e.g. signed URLs). Accepted: video/mp4, video/quicktime, audio/mpeg, audio/wav, audio/aac, audio/mp4, image/png, image/jpeg, image/tiff, image/heic, application/x-subrip, text/vtt."},
                        },
                    },
                    "name": {"type": "string", "description": "Display name in the library. Defaults to the filename derived from url/path, or 'Imported asset' for bytes."},
                    "folder": {"type": "string", "description": "Optional destination folder path, e.g. 'B-roll/Sunset'. Created if missing. Omit for the project root."},
                },
                required: ["source"]
            })
        },
{
            name: "search_media",
            description: "Search the media library by content: what's on screen (visual) and what's said (spoken). Visual matching is semantic and on-device — phrase the query like an image caption ('a wide shot of a harbor at sunset'), not keywords; covers videos and stills. A visual search automatically installs a missing on-device model. Spoken matching layers exact keywords over on-device semantic matching of transcript segments — quote the words said, or paraphrase them; transcripts are created automatically while indexing (and by inspect_media and add_captions), so coverage grows as indexing completes. The two groups rank independently and are never blended. Scores are uncalibrated — use them for ordering only.\n\nHits are source-second ranges (image hits have no time range). To place exactly that moment, pass [startSeconds, endSeconds] straight to add_clips as source — no unit conversion.\n\nAn `index` object appears only while it can explain missing results (status: indexing | downloadingModel | preparing | disabled | failed, with indexedAssets vs indexableAssets). modelDownloadProgress is 0...1 while downloading; modelDownloadError reports the current failure. When present, moments may be incomplete — report that instead of concluding the footage doesn't exist, and don't poll in a loop. No index key means visual search was complete. Spoken results work regardless.",
            inputSchema: objectSchema({
                properties: {
                    "query": {"type": "string", "description": "What to find. Visual: a caption-style scene description. Spoken: the words to match."},
                    "scope": {"type": "string", "enum": ["visual", "spoken", "both"], "description": "Optional. Default both."},
                    "mediaRef": {"type": "string", "description": "Optional. Restrict the search to one asset from get_media."},
                    "limit": {"type": "integer", "description": "Optional. Max hits per group (default 10, max 50)."},
                },
                required: ["query"]
            })
        },
];
