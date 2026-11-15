import { mediaDefinitions } from "./definitions/mediaDefinitions";
import { importMedia } from "./importTools";
import { getMedia, inspectMedia } from "./mediaTools";
import { organizeMedia } from "./organizeTools";
import { searchMedia } from "../../visualsearch/searchMediaTool";
import { defineTools, definitionNamed } from "./toolRegistry";

defineTools("media", [
  { definition: definitionNamed(mediaDefinitions, "get_media"), run: getMedia },
  { definition: definitionNamed(mediaDefinitions, "inspect_media"), run: inspectMedia },
  { definition: definitionNamed(mediaDefinitions, "import_media"), run: importMedia },
  { definition: definitionNamed(mediaDefinitions, "organize_media"), run: organizeMedia },
  { definition: definitionNamed(mediaDefinitions, "search_media"), run: searchMedia },
]);
