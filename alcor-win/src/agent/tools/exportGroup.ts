import { exportDefinitions } from "./definitions/exportDefinitions";
import { exportProject, manageExports } from "./exportTools";
import { defineTools, definitionNamed } from "./toolRegistry";

defineTools("export", [
  { definition: definitionNamed(exportDefinitions, "export_project"), run: exportProject },
  { definition: definitionNamed(exportDefinitions, "manage_exports"), run: manageExports },
]);
