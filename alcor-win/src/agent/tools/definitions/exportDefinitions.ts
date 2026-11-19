// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";


export const exportDefinitions: ToolDefinition[] = [
{
            name: "export_project",
            description: "Queues an export from the current project using the same modes as the Export dialog. mode defaults to video. video renders H.264, H.265, or ProRes; xml writes XMEML timeline XML; fcpxml writes FCPXML; palmier writes a self-contained .palmier project package. For timeline interchange, pick the format by the target editor: Premiere Pro -> xml; DaVinci Resolve or Final Cut Pro -> fcpxml (fcpxml also carries text, transforms, crop, opacity, and keyframes that xml cannot). Video exports render edge softness and edge rounding, Alcor project exports preserve them, and xml/fcpxml interchange omits them. Omit outputPath to write a unique file to ~/Downloads. Existing direct outputPath files are overwritten by default to match the UI save flow; pass overwrite=false to refuse. Every mode returns status=started or status=queued with a jobId and destination path. Use manage_exports to check progress, warnings/results, or cancel by jobId; agent exports post a system notification on completion or failure.",
            inputSchema: objectSchema({
                properties: {
                    "mode": {"type": "string", "enum": ["video", "xml", "fcpxml", "palmier"], "description": "Optional. Default video. Use xml for Premiere Pro, fcpxml for DaVinci Resolve or Final Cut Pro."},
                    "codec": {"type": "string", "enum": ["H.264", "H.265", "ProRes"], "description": "Video mode only. Optional. Default H.264."},
                    "resolution": {"type": "string", "enum": ["720p", "1080p", "2K", "4K", "Match Timeline"], "description": "Video mode only. Optional. Default Match Timeline."},
                    "outputPath": {"type": "string", "description": "Optional. Absolute destination path. If omitted, a unique project-named file is written to ~/Downloads. If no extension is provided, the mode's extension is appended."},
                    "overwrite": {"type": "boolean", "description": "Optional. Default true, matching the UI save flow. false refuses when outputPath already exists."},
                    "fcpxmlTarget": {"type": "string", "enum": ["resolve", "fcp"], "description": "fcpxml mode only. Optional, default resolve. Davinci Resolve and Final Cut interpret crop and position values differently; pick the app the file will be imported into."},
                    "timelineId": {"type": "string", "description": "Optional. Timeline to export (from get_timeline's timelines list). Defaults to the active timeline. Not valid for palmier mode, which packages every timeline."},
                }
            })
        },
{
            name: "manage_exports",
            description: "Lists or cancels exports for the current project. action=list returns newest first with jobId, filename, path, status, progress percent, and any warnings/result. action=cancel requires the exact jobId returned by export_project or list; a waiting job is removed from the queue and an active job begins canceling. Cancel only when the user asks, or to undo an export just queued with incorrect settings. Never infer that an export is stuck from elapsed time alone.",
            inputSchema: objectSchema({
                properties: {
                    "action": {"type": "string", "enum": ["list", "cancel"]},
                    "jobId": {"type": "string", "description": "Required for cancel. Exact jobId from export_project or manage_exports list."},
                },
                required: ["action"]
            })
        },
];
