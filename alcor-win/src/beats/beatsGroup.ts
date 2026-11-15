import { pendingTranscriptDefinitions } from "../agent/tools/definitions/transcriptDefinitions";
import { defineTools, definitionNamed } from "../agent/tools/toolRegistry";
import { detectBeats } from "./beatTools";

// detect_beats: read-only (the analysis is cached, the timeline is untouched).
defineTools("beats", [{ definition: definitionNamed(pendingTranscriptDefinitions, "detect_beats"), run: detectBeats }]);
