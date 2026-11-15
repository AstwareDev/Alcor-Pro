import { textsDefinitions } from "./definitions/textsDefinitions";
import { addTexts, updateText } from "./textTools";
import { defineTools, definitionNamed } from "./toolRegistry";

const find = (name: string) => definitionNamed(textsDefinitions, name);

defineTools("texts", [
  { definition: find("add_texts"), run: addTexts, publishesTimelineChanges: true },
  { definition: find("update_text"), run: updateText, publishesTimelineChanges: true },
]);
