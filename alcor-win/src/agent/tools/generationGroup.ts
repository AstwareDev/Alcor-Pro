import { providersWithKeys } from "../../generation/providers/registry";
import { generationDefinitions } from "./definitions/generationDefinitions";
import { generateAudio, generateImage, generateVideo, listModels, upscaleMedia } from "./generateTools";
import { agentToolHooks } from "./toolHooks";
import { defineTools, definitionNamed } from "./toolRegistry";

// No Palmier account here: generation works when at least one provider API key is stored.
agentToolHooks.canGenerate = () => providersWithKeys().size > 0;

defineTools("generation", [
  { definition: definitionNamed(generationDefinitions, "list_models"), run: listModels },
  { definition: definitionNamed(generationDefinitions, "generate_video"), run: generateVideo },
  { definition: definitionNamed(generationDefinitions, "generate_image"), run: generateImage },
  { definition: definitionNamed(generationDefinitions, "generate_audio"), run: generateAudio },
  { definition: definitionNamed(generationDefinitions, "upscale_media"), run: upscaleMedia },
]);
