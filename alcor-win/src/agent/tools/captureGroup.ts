import { mediaDefinitions } from "./definitions/mediaDefinitions";
import { captureFrame } from "./captureTools";
import { defineTools, definitionNamed } from "./toolRegistry";

defineTools("capture", [{ definition: definitionNamed(mediaDefinitions, "capture_frame"), run: captureFrame }]);
