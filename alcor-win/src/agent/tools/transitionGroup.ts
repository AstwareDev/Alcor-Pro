import { transitionDefinitions } from "./definitions/transitionDefinitions";
import { addAdjustmentLayerTool, addTransitionTool, removeTransitionTool, updateTransitionTool } from "./transitionTools";
import { defineTools, definitionNamed } from "./toolRegistry";

defineTools("transitions", [
  { definition: definitionNamed(transitionDefinitions, "add_transition"), run: addTransitionTool, publishesTimelineChanges: true },
  { definition: definitionNamed(transitionDefinitions, "update_transition"), run: updateTransitionTool, publishesTimelineChanges: true },
  { definition: definitionNamed(transitionDefinitions, "remove_transition"), run: removeTransitionTool, publishesTimelineChanges: true },
  { definition: definitionNamed(transitionDefinitions, "add_adjustment_layer"), run: addAdjustmentLayerTool, publishesTimelineChanges: true },
]);
