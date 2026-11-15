import { pendingColorDefinitions } from "../agent/tools/definitions/colorDefinitions";
import { defineTools, definitionNamed } from "../agent/tools/toolRegistry";
import { denoiseAudio } from "./denoiseTools";

defineTools("denoise", [{ definition: definitionNamed(pendingColorDefinitions, "denoise_audio"), run: denoiseAudio, publishesTimelineChanges: true }]);
