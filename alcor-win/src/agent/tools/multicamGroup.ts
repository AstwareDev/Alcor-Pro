import { multicamDefinitions } from "./definitions/multicamDefinitions";
import { changeCam, getMulticam, manageMulticam, syncClipsTool } from "./multicamTools";
import { defineTools, definitionNamed } from "./toolRegistry";

const find = (name: string) => definitionNamed(multicamDefinitions, name);

defineTools("multicam", [
  { definition: find("sync_clips"), run: syncClipsTool, publishesTimelineChanges: true },
  { definition: find("manage_multicam"), run: manageMulticam, publishesTimelineChanges: true },
  { definition: find("change_cam"), run: changeCam, publishesTimelineChanges: true },
  { definition: find("get_multicam"), run: getMulticam, readsInactiveProject: true },
]);
