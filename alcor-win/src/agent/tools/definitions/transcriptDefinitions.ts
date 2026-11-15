// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";
import { silenceRemovalLimits } from "./limits";

export const transcriptDefinitions: ToolDefinition[] = [
{
            name: "get_transcript",
            description: "Returns the spoken transcript of the CURRENT timeline in project frames — the post-edit caption track in one call. Unlike inspect_media (which transcribes one source asset in isolation, in source seconds), this walks every audio/video clip on the timeline, maps each word through that clip's trim/speed/position, and concatenates in timeline order. Deleted ranges are gone by construction, so after cuts this always reflects what's actually audible — no stale results, no per-clip frame math. Pass trackIndex to isolate one dialogue or multicam mic track; omit it to read every eligible timeline source (multicam defaults to its master mic). The app chooses cloud only when the signed-in account has enough credits for the uncached request; otherwise it uses local transcription and reports the resolved transcriptionSource in the response.\n\nReturns clips in timeline order, each with its words as compact [index, text, startFrame] rows (a word runs to the next word's start; the last word to its clip's end). Speakers, when identified, arrive as run-length turns: speakers = [[firstWordIndex, name], ...]. The index is a stable, 0-based position in the requested transcript; pass it straight to remove_words to cut that word (the intuitive path for text-based editing). Indices stay stable when paged with a window. Capped at 10000 words; page with startFrame/endFrame using nextStartFrame.\n\nFor comprehension rather than cutting — summarizing, finding a topic, take selection on long media — pass granularity='segments': sentence rows [firstWordIndex, text, start, end] at a fraction of the tokens, whose firstWordIndex jumps you back into word mode for the cut window.\n\nUse for transcript-driven edits (filler-word / dead-air removal, locating a quote, take selection) and to verify what remains after cutting. To cut, prefer remove_words (give it the indices); drop to ripple_delete_ranges only for non-word-aligned spans.",
            inputSchema: objectSchema({
                properties: {
                    "startFrame": {"type": "integer", "description": "Optional. Only return words ending after this project frame. Use with the returned nextStartFrame to page a long timeline."},
                    "endFrame": {"type": "integer", "description": "Optional. Only return words starting before this project frame."},
                    "clipId": {"type": "string", "description": "Scope the transcript to a single clip — returns only what that clip says, in project frames. Answers \"what's in clip X?\" without scanning the whole timeline."},
                    "trackIndex": {"type": "integer", "description": "Scope transcription to one current timeline track from get_timeline. Use this to choose a dialogue or multicam mic lane. Mutually exclusive with clipId."},
                    "granularity": {"type": "string", "enum": ["words", "segments"], "description": "words (default) for cutting with remove_words; segments for cheap sentence-level reading — rows carry firstWordIndex to drill back into words."},
                    "language": {"type": "string", "description": "Optional BCP-47 speech language. Applies to local only; cloud auto-detects."},
                }
            })
        },
{
            name: "remove_words",
            description: "Cut speech by the word, Descript-style — the primary tool for text-based editing (filler words, flubbed sentences, dropped retakes, tightening a ramble). Pass words for precise get_transcript indices/ranges, or matches for exact filler tokens like \"um\" and \"uh\". This resolves them to frames, removes the surrounding pause so survivors don't end up double-spaced, merges adjacent removals, cuts linked A/V partners, and closes the gaps. You never deal in frame numbers — that's the whole point versus ripple_delete_ranges.\n\nWorkflow: call get_transcript, read it as prose, then pass the indices of the words to drop. Omit language by default; remove_words reuses the previous get_transcript provider and track selection so word indices stay aligned. Words across multiple clips on ONE track are handled in a single undoable action, and any linked A/V partner (e.g. the video paired with this audio) is cut automatically. Edit one track at a time: if your indices span multiple unlinked tracks (e.g. two separate mics), the call is refused — cut each track in its own call, or link the tracks into one unit first. After it runs, indices have shifted — re-read get_transcript before another remove_words.\n\nWhen to use which: words for selective edits after reading the transcript; matches for removing every exact filler token; ripple_delete_ranges only for spans that aren't word-aligned. Verify reworded retakes and sub-frame seam fragments against the word list, not a summary.",
            inputSchema: objectSchema({
                properties: {
                    "words": {
                        "type": "array",
                        "description": "Words to remove, by get_transcript index. Each element is either a single index (e.g. 42) or an inclusive [startIndex, endIndex] span (e.g. [12, 18]). Mutually exclusive with matches. Re-read after any edit.",
                        "items": {"type": ["integer", "array"]},
                    },
                    "matches": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Exact single-word tokens to remove everywhere, case-insensitive with surrounding punctuation ignored, e.g. [\"um\", \"uh\", \"hmm\"]. Mutually exclusive with words. Avoid broad words like \"like\" unless the user explicitly wants every occurrence removed.",
                    },
                    "cutAggressiveness": {
                        "type": "string",
                        "enum": ["tight", "balanced", "loose"],
                        "description": "How much silence to leave between the words on either side of a cut. 'tight' butts them close (snappy, can feel clipped), 'balanced' (default) keeps a natural beat, 'loose' leaves more breathing room. The removed words' own frames always go regardless.",
                    },
                    "language": {"type": "string", "description": "Optional BCP-47 speech language for local transcription. Omit to reuse the previous get_transcript language."},
                },
                required: []
            })
        },
];

/** Definitions whose executors are not ported yet; never advertised. */
export const pendingTranscriptDefinitions: ToolDefinition[] = [
{
            name: "remove_silence",
            description: "Remove dead air — quiet, speech-free sections — from the timeline's audio, ripple-closing the gaps. Sections come from on-device speech detection (the same spans marked red on waveforms): non-speech runs whose level sits well below the recording's own speech level, so music beds and loud ambience are never cut. Cuts linked A/V partners and honors sync lock; the whole pass is one undoable action.\n\nOmit clipIds to process the whole timeline, or pass clip IDs from get_timeline to process only those clips. A scoped selection must include audio from exactly one track, and all selected clips must share one track or belong to one linked A/V unit. By default, this uses the current Minimum Pause and Speech Padding controls. Pass either optional value as a one-shot override without changing those controls. Use this to tighten pacing (long pauses, dead space between takes) before or instead of word-level edits: remove_silence handles pauses, remove_words handles fillers and flubbed lines. No transcript needed. If it reports no dead air, speech analysis may still be running in the background — wait a moment and retry.",
            inputSchema: objectSchema({
                properties: {
                    "clipIds": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "description": "Optional timeline clip IDs from get_timeline. Restricts removal to these clips; linked A/V partners are cut with them. Include audio clips from exactly one track, and select clips from one track or one link group. Omit to process the whole timeline.",
                    },
                    "minimumPauseSeconds": {
                        "type": "number",
                        "minimum": silenceRemovalLimits.minimumPause.min,
                        "maximum": silenceRemovalLimits.minimumPause.max,
                        "description": "Minimum quiet, speech-free pause to remove. Omit to use the current Minimum Pause control.",
                    },
                    "speechPaddingSeconds": {
                        "type": "number",
                        "minimum": silenceRemovalLimits.speechPadding.min,
                        "maximum": silenceRemovalLimits.speechPadding.max,
                        "description": "Audio to keep before and after detected speech. Omit to use the current Speech Padding control.",
                    },
                },
                required: []
            })
        },
{
            name: "detect_beats",
            description: "Detect musical beats and downbeats in a media asset's audio, on-device. Returns beats and downbeats in SOURCE seconds (multiply by fps for frame values, same convention as search_media hits) plus estimated bpm. Downbeats mark bar starts — cut on downbeats for edits that land musically; beats are fine for faster montage rhythms.\n\nUse for beat-synced editing: snapping cuts to a music bed, building montages where clip boundaries hit the beat, or timing text/caption entrances to the bar. To place a cut at a beat B on a clip, the timeline frame is startFrame + (B × fps − trimStartFrame) / speed. Works on music; speech or ambience returns few or no beats. Runs locally — no subscription needed.",
            inputSchema: objectSchema({
                properties: {
                    "mediaRef": {"type": "string", "description": "Audio or video asset id from get_media."},
                    "startSeconds": {"type": "number", "description": "Optional. Return only beats at or after this source-media second. The whole file is analyzed once and cached; windowing trims the response, not the work."},
                    "endSeconds": {"type": "number", "description": "Optional. Return only beats at or before this source-media second."},
                },
                required: ["mediaRef"]
            })
        },
];
