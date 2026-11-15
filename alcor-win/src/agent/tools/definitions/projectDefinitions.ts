// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";


export const projectDefinitions: ToolDefinition[] = [
{
        name: "manage_project",
        description: "List, open, create, or close Palmier projects for this MCP session. Set `action` to: `list` for known projects plus session-active and visible state; `open` with a name, id from list, or .palmier path; `create` with an optional name and initial fps/aspectRatio/quality; or `close` to save and close the session project, optionally targeting another open project by name/id/path. Opening or creating changes only this session's target. Closing always completes a final save first. This tool never deletes projects or files.",
        inputSchema: objectSchema({
            properties: {
                "action": {"type": "string", "enum": ["list", "open", "create", "close"], "description": "Project operation."},
                "name": {"type": "string", "description": "Project name. For open/close, matched case-insensitively; for create, defaults to 'Untitled Project'."},
                "id": {"type": "string", "description": "Project id returned by action='list'. Used by open or close."},
                "path": {"type": "string", "description": "Filesystem path to a .palmier package. Used by open or close."},
                "fps": {"type": "integer", "description": "Create only. Optional timeline frame rate (1-120)."},
                "aspectRatio": {
                    "type": "string",
                    "description": "Create only. Optional canvas aspect ratio as width:height, such as '16:9', '3:2', or '2.39:1'.",
                },
                "quality": {
                    "type": "string",
                    "enum": ["720p", "1080p", "2K", "4K"],
                    "description": "Create only. Optional resolution preset applied to the aspect ratio.",
                },
            },
            required: ["action"]
        })
    },
];

/** Definitions whose executors are not ported yet; never advertised. */
export const pendingProjectDefinitions: ToolDefinition[] = [

];
