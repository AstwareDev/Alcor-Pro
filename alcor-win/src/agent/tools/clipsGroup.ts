import { clipsDefinitions } from "./definitions/clipsDefinitions";
import { addClips, insertClips, manageClipLinks, manageTracks, moveClipsTool, removeClipsTool, rippleDeleteRangesTool, splitClipsTool, swapClipMediaTool } from "./clipTools";
import { copyClipSettings, setClipProperties, setKeyframes } from "./clipPropertyTools";
import { applyLayout } from "./layoutTools";
import { setSpeedRamp } from "./speedRampTools";
import { undoTool } from "./undoTool";
import { defineTools, definitionNamed } from "./toolRegistry";

const find = (name: string) => definitionNamed(clipsDefinitions, name);

defineTools("clips", [
  { definition: find("manage_tracks"), run: manageTracks, publishesTimelineChanges: true },
  { definition: find("manage_clip_links"), run: manageClipLinks, publishesTimelineChanges: true },
  { definition: find("add_clips"), run: addClips, publishesTimelineChanges: true },
  { definition: find("insert_clips"), run: insertClips, publishesTimelineChanges: true },
  { definition: find("move_clips"), run: moveClipsTool, publishesTimelineChanges: true },
  { definition: find("remove_clips"), run: removeClipsTool, publishesTimelineChanges: true },
  { definition: find("split_clips"), run: splitClipsTool, publishesTimelineChanges: true },
  { definition: find("ripple_delete_ranges"), run: rippleDeleteRangesTool, publishesTimelineChanges: true },
  { definition: find("swap_clip_media"), run: swapClipMediaTool, publishesTimelineChanges: true },
  { definition: find("set_clip_properties"), run: setClipProperties, publishesTimelineChanges: true },
  { definition: find("copy_clip_settings"), run: copyClipSettings, publishesTimelineChanges: true },
  { definition: find("set_keyframes"), run: setKeyframes, publishesTimelineChanges: true },
  { definition: find("set_speed_ramp"), run: setSpeedRamp, publishesTimelineChanges: true },
  { definition: find("apply_layout"), run: applyLayout, publishesTimelineChanges: true },
  { definition: find("undo"), run: undoTool, publishesTimelineChanges: true },
]);
