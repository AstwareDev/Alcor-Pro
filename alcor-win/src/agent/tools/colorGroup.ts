import { colorDefinitions } from "./definitions/colorDefinitions";
import { applyColor, colorObject, inspectColor } from "./colorTools";
import { applyEffect } from "./effectTools";
import { agentToolHooks } from "./toolHooks";
import { defineTools, definitionNamed } from "./toolRegistry";

// denoise_audio stays in pendingColorDefinitions (owned by another port).
agentToolHooks.colorObject = colorObject;

defineTools("color", [
  { definition: definitionNamed(colorDefinitions, "apply_color"), run: applyColor, publishesTimelineChanges: true },
  { definition: definitionNamed(colorDefinitions, "apply_effect"), run: applyEffect, publishesTimelineChanges: true },
  { definition: definitionNamed(colorDefinitions, "inspect_color"), run: inspectColor, readsInactiveProject: true },
]);
