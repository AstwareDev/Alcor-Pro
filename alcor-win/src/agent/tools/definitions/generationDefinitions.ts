// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";


export const generationDefinitions: ToolDefinition[] = [
{
            name: "list_models",
            description: "Lists AI models with their capabilities (durations, aspect ratios, resolutions, draft mode, first/last frame support, reference support, voices/category for audio, and configurable settings for upscalers). Always call before generate_video, generate_image, generate_audio, or upscale_media so the model you pick actually supports the constraints you need. Returns { models, loaded } — if loaded=false the catalog hasn't synced yet (e.g. user not signed in); the models array may be empty even when models exist, so do not conclude no models are available. Retry after the user signs in.",
            inputSchema: objectSchema({
                properties: {
                    "type": {"type": "string", "enum": ["video", "image", "audio", "upscale"], "description": "Filter by type. Omit to list all models."},
                }
            })
        },
{
            name: "generate_video",
            description: "Starts an async AI video generation. Returns a placeholder asset ID immediately; generation runs in the background and the asset becomes usable in add_clips once ready. Costs real money and is not undoable.",
            inputSchema: objectSchema({
                properties: {
                    "prompt": {"type": "string", "description": "Text description of the video to generate. Optional for transforms such as lip sync that do not use a prompt."},
                    "name": {"type": "string", "description": "Display name for the asset in the media library. Defaults to first 30 chars of prompt."},
                    "model": {"type": "string", "description": "Model ID (e.g. 'veo3.1-fast'). Use list_models to see options. Defaults to first available model."},
                    "duration": {"type": "integer", "description": "Duration in seconds. Valid values depend on model."},
                    "aspectRatio": {"type": "string", "description": "Aspect ratio (e.g. '16:9', '9:16', '1:1')"},
                    "resolution": {"type": "string", "description": "Resolution (e.g. '720p', '1080p', '4k')"},
                    "draft": {"type": "boolean", "description": "Generate a lower-cost 720p preview when list_models reports supportsDraft=true. The resulting media can be enhanced later without changing its motion."},
                    "enhanceDraftMediaRef": {"type": "string", "description": "Completed draft asset ID to render at full quality without changing its motion. Use alone instead of prompt/model/input parameters."},
                    "startFrameMediaRef": {"type": "string", "description": "Media asset ID to use as the first frame (image-to-video)"},
                    "endFrameMediaRef": {"type": "string", "description": "Media asset ID to use as the last frame (supported by some models)"},
                    "sourceVideoMediaRef": {"type": "string", "description": "Media asset ID of a source video required by video-to-video models. Pass duration when the selected model lists output durations; otherwise the source duration determines billing."},
                    "sourceClipId": {"type": "string", "description": "Optional. Clip id (from get_timeline) referencing sourceVideoMediaRef. When set and the clip is trimmed, only the clip's visible range is sent to the model, not the full source — matches the UI's 'Use trimmed portion only'."},
                    "referenceImageMediaRefs": {"type": "array", "items": {"type": "string"}, "description": "Media asset IDs of image references. Covers both reference-to-video generation (Seedance, Kling V3/O3 elements, Grok — refer as @Image1/@Element1 in prompt) and the single-image ref used by video-to-video edit models (Kling V3 Motion Control). See list_models maxReferenceImages for per-model cap."},
                    "referenceVideoMediaRefs": {"type": "array", "items": {"type": "string"}, "description": "Media asset IDs of video references (Seedance only). Refer to them as @Video1, @Video2. See maxReferenceVideos and maxCombinedVideoRefSeconds."},
                    "referenceAudioMediaRefs": {"type": "array", "items": {"type": "string"}, "description": "Media asset IDs of audio references. Lip-sync models use this as the replacement audio track; prompt-driven models refer to them as @Audio1, @Audio2. See maxReferenceAudios, requiresReferenceAudio, and maxCombinedAudioRefSeconds."},
                    "folder": {"type": "string", "description": "Optional destination folder path, e.g. 'Hero shots/Takes'. Created if missing. Omit for the project root."},
                }
            })
        },
{
            name: "generate_image",
            description: "Starts an async AI image generation. Returns a placeholder asset ID immediately; generation runs in the background. Costs real money and is not undoable.",
            inputSchema: objectSchema({
                properties: {
                    "prompt": {"type": "string", "description": "Text description of the image to generate"},
                    "name": {"type": "string", "description": "Display name for the asset in the media library. Defaults to first 30 chars of prompt."},
                    "model": {"type": "string", "description": "Model ID (e.g. 'nano-banana-pro'). Use list_models to see options. Defaults to first available model."},
                    "aspectRatio": {"type": "string", "description": "Aspect ratio (e.g. '16:9', '9:16')"},
                    "resolution": {"type": "string", "description": "Resolution (e.g. '2K', '4K')"},
                    "quality": {"type": "string", "description": "Image quality (e.g. 'low', 'medium', 'high'). Only supported by some models — see list_models."},
                    "referenceMediaRefs": {"type": "array", "items": {"type": "string"}, "description": "Media asset IDs to use as reference images"},
                    "folder": {"type": "string", "description": "Optional destination folder path, e.g. 'Hero shots/Takes'. Created if missing. Omit for the project root."},
                },
                required: ["prompt"]
            })
        },
{
            name: "generate_audio",
            description: "Starts an async AI audio generation or transformation. Returns a placeholder asset ID immediately; the asset appears in get_media and becomes usable in add_clips once ready. TTS converts text into speech. Generative audio models create dialogue, music, or sound effects from a prompt, video, or supported image/audio references. Voice Cleanup isolates speech from background audio. Dubbing translates source speech while preserving speaker delivery; pass targetLanguage. For models whose inputs include audio or video, provide sourceMediaRef. Video-to-audio scoring models also accept videoSourceStartFrame+videoSourceEndFrame and place the result on the timeline automatically. Other results land in the media library for placement with add_clips. Use list_models with type='audio' to inspect inputs, category, voices, reference caps, and limits. Costs real money and is not undoable.",
            inputSchema: objectSchema({
                properties: {
                    "prompt": {"type": "string", "description": "Required for text-driven models. TTS uses it as spoken text; generative audio models use it as the scene, music, or sound description. Omit for Voice Cleanup and Dubbing."},
                    "name": {"type": "string", "description": "Display name for the asset in the media library. Defaults to first 30 chars of prompt."},
                    "model": {"type": "string", "description": "Model ID. Use list_models with type='audio' to see options and their 'inputs'. Defaults to the first model."},
                    "voice": {"type": "string", "description": "TTS only. Voice preset name. list_models shows voicesSample (first 3) + voiceCount; any voice supported by the model is accepted. Defaults to the model's defaultVoice. Ignored by music models."},
                    "lyrics": {"type": "string", "description": "MiniMax Music only. Lyrics with optional [Verse]/[Chorus] section tags. If omitted and instrumental=false, MiniMax auto-writes lyrics from the prompt."},
                    "styleInstructions": {"type": "string", "description": "Gemini TTS only. Optional delivery instructions (e.g. 'warm and slow', 'British accent')."},
                    "instrumental": {"type": "boolean", "description": "Music models only. true = no vocals when the selected model supports it. Defaults to false."},
                    "duration": {"type": "integer", "description": "Length in seconds. ElevenLabs Music: 3–600. Sonilo text-to-music: up to 600. Video-to-audio models default to the source span; pass a value to request a different output length. Voice Cleanup and Dubbing always preserve the source length. Ignored by TTS, MiniMax, and Lyria 3 Pro."},
                    "sourceMediaRef": {"type": "string", "description": "Source audio or video asset ID for models whose inputs include audio or video. Required for Voice Cleanup and Dubbing."},
                    "targetLanguage": {"type": "string", "description": "Required for Dubbing. ISO language code such as 'es', 'fr', 'de', or 'ja'."},
                    "referenceImageMediaRefs": {"type": "array", "items": {"type": "string"}, "description": "Image asset IDs for audio models that support image references. See list_models for the count limit. Mutually exclusive with referenceAudioMediaRefs when list_models reports referenceImagesAndAudiosExclusive."},
                    "referenceAudioMediaRefs": {"type": "array", "items": {"type": "string"}, "description": "Audio asset IDs for audio models that support audio references. Refer to them in the prompt as @Audio1, @Audio2, and @Audio3. See list_models for the count, duration, and file-type limits."},
                    "multilingual": {"type": "boolean", "description": "Enable multilingual generation when supported by the selected model. Defaults to false."},
                    "videoSourceStartFrame": {"type": "integer", "description": "Video-to-audio models only. Start frame (timeline) of a span to render and score — pair with videoSourceEndFrame. Use get_timeline for frame numbers; for the whole timeline use 0 to the timeline's end frame."},
                    "videoSourceEndFrame": {"type": "integer", "description": "Video-to-audio models only. End frame (exclusive) of the span to score. Must be > videoSourceStartFrame."},
                    "videoSourceMediaRef": {"type": "string", "description": "Video-to-audio models only. Score this existing video asset instead of a timeline span. Mutually exclusive with the videoSource frames."},
                    "folder": {"type": "string", "description": "Optional destination folder path, e.g. 'Hero shots/Takes'. Created if missing. Omit for the project root."},
                },
                required: []
            })
        },
{
            name: "upscale_media",
            description: "Enhances an existing video or image with an AI upscaler. It can change resolution, interpolate video frame rate, or apply model-specific restoration settings. Returns a placeholder asset ID immediately; the result appears in get_media once ready. Call list_models with type='upscale' first and use its exact setting IDs and values. Costs real money and is not undoable.",
            inputSchema: objectSchema({
                properties: {
                    "mediaRef": {"type": "string", "description": "ID of the video or image asset to upscale"},
                    "model": {"type": "string", "description": "Upscaler model ID (e.g. 'bytedance-upscaler', 'seedvr-image-upscaler'). Defaults to the first model that supports the asset's type."},
                    "sourceClipId": {"type": "string", "description": "Optional. Video clip id (from get_timeline) referencing mediaRef. When set and the clip is trimmed, only the clip's visible range is upscaled, not the full source."},
                    "settings": {
                        "type": "object",
                        "description": "Optional flat map of setting ID to value from list_models. Select settings take strings, numeric settings take numbers, and toggle settings take booleans. Omitted settings use model defaults. Example: {\"targetResolution\":\"4k\",\"targetFPS\":\"60\",\"enhancementModel\":\"Proteus\",\"noise\":0.2}.",
                    },
                },
                required: ["mediaRef"]
            })
        },
];
