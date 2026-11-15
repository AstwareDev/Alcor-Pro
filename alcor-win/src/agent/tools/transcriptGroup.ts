import { textsDefinitions } from "./definitions/textsDefinitions";
import { transcriptDefinitions } from "./definitions/transcriptDefinitions";
import { addCaptions } from "./captionTools";
import { defineTools, definitionNamed } from "./toolRegistry";
import { getTranscript } from "./transcriptionTools";
import { removeWords } from "./wordsTools";

// remove_silence and detect_beats stay in pendingTranscriptDefinitions. add_captions' definition lives with the
// text tools but its executor is here, so it is registered by this group only (textsGroup does not register it).
defineTools("transcript", [
  { definition: definitionNamed(transcriptDefinitions, "get_transcript"), run: getTranscript, readsInactiveProject: true },
  { definition: definitionNamed(transcriptDefinitions, "remove_words"), run: removeWords, publishesTimelineChanges: true },
  { definition: definitionNamed(textsDefinitions, "add_captions"), run: addCaptions, publishesTimelineChanges: true },
]);
