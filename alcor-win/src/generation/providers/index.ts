import { elevenLabsProvider } from "./elevenlabs";
import { falProvider } from "./fal";
import { googleProvider } from "./google";
import { openAIProvider } from "./openai";
import { registerProvider } from "./registry";
import { replicateProvider } from "./replicate";

// Importing this module registers every adapter.
registerProvider(falProvider);
registerProvider(elevenLabsProvider);
registerProvider(openAIProvider);
registerProvider(googleProvider);
registerProvider(replicateProvider);
