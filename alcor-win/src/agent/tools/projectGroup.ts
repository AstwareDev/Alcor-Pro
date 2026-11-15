import { projectDefinitions } from "./definitions/projectDefinitions";
import { manageProject } from "./projectTools";
import { defineTools, definitionNamed } from "./toolRegistry";

defineTools("project", [
  { definition: definitionNamed(projectDefinitions, "manage_project"), run: manageProject, needsEditor: false, mcpOnly: true },
]);
