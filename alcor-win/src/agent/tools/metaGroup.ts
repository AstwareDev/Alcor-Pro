import { metaDefinitions } from "./definitions/metaDefinitions";
import { manageSkills, readSkill } from "./skillTools";
import { defineTools, definitionNamed } from "./toolRegistry";

// Only the skill tools are ported; send_feedback stays in pendingMetaDefinitions (there is no Palmier backend to send to).
// Skills are in-app only, like Swift's `ToolDefinitions.inAppAgent`.
defineTools("meta", [
  { definition: definitionNamed(metaDefinitions, "read_skill"), run: readSkill, inAppOnly: true },
  { definition: definitionNamed(metaDefinitions, "manage_skills"), run: manageSkills, inAppOnly: true },
]);
