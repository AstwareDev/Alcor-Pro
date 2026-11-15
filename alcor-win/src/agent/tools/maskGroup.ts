import { maskDefinitions } from "./definitions/maskDefinitions";
import { addMaskTool, removeMaskTool, updateMaskTool } from "./maskTools";
import { defineTools, definitionNamed } from "./toolRegistry";

defineTools("masks", [
  { definition: definitionNamed(maskDefinitions, "add_mask"), run: addMaskTool, publishesTimelineChanges: true },
  { definition: definitionNamed(maskDefinitions, "update_mask"), run: updateMaskTool, publishesTimelineChanges: true },
  { definition: definitionNamed(maskDefinitions, "remove_mask"), run: removeMaskTool, publishesTimelineChanges: true },
]);
