// Generated from Swift ToolDefinitions.swift; strings are verbatim.
import type { ToolDefinition } from "../toolRegistry";
import { objectSchema } from "./schema";
import { skillLimits } from "./limits";

export const metaDefinitions: ToolDefinition[] = [
{
        name: "read_skill",
        description: "Load the full instructions for one of the skills listed under # Skills in your system prompt. Call this before starting a task that matches a skill's description, then follow the returned procedure. Pass the id exactly as listed.",
        inputSchema: objectSchema({
            properties: {
                "id": {"type": "string", "description": "The skill id, exactly as listed under # Skills."},
            },
            required: ["id"]
        })
    },
{
        name: "manage_skills",
        description: "Create, update, or permanently remove reusable skills for the in-app assistant. Set `action` to: `create` with name, description, and complete Markdown instructions; `update` with an exact skill id and at least one field to replace; or `remove` with an exact skill id. Updates are partial patches, but `instructions`, when present, replaces the complete Markdown body, so call read_skill first when preserving existing instructions. Use remove only when the user explicitly asks to delete that skill. The app generates and returns a stable id for created skills.",
        inputSchema: objectSchema({
            properties: {
                "action": {
                    "type": "string",
                    "enum": ["create", "update", "remove"],
                    "description": "Skill operation.",
                },
                "id": {
                    "type": "string",
                    "description": "Update/remove only. Exact skill id listed under # Skills.",
                },
                "name": {
                    "type": "string",
                    "maxLength": skillLimits.maximumNameLength,
                    "description": "Create/update. Concise skill display name on one line.",
                },
                "description": {
                    "type": "string",
                    "maxLength": skillLimits.maximumDescriptionLength,
                    "description": "Create/update. One-line trigger description explaining when the assistant should use the skill.",
                },
                "instructions": {
                    "type": "string",
                    "maxLength": skillLimits.maximumInstructionsLength,
                    "description": "Create/update. Complete replacement Markdown instructions without YAML frontmatter.",
                },
            },
            required: ["action"]
        })
    },
];

/** Definitions whose executors are not ported yet; never advertised. */
export const pendingMetaDefinitions: ToolDefinition[] = [
{
            name: "send_feedback",
            description: "Report an agent limitation or bug to the Palmier team so they can improve the product. Use when you can't do what the user asked because a capability or tool is missing or behaves wrong, the result is clearly off, or the user is plainly hitting a rough edge. This sends directly — there is no user confirmation step — so write the report in English and PARAPHRASE in your own words: translate non-English user text to English, and never include verbatim user messages, prompts, file paths, media, transcript text, or any project content. App/OS version and your recent tool names are attached automatically. Use sparingly: at most once per distinct issue.",
            inputSchema: objectSchema({
                properties: {
                    "category": {"type": "string", "enum": ["missing_capability", "wrong_result", "confusing_ux", "failure", "suggestion"], "description": "What kind of problem this is."},
                    "summary": {"type": "string", "description": "One-line paraphrased summary of the issue. Becomes the report's subject."},
                    "details": {"type": "string", "description": "Optional. Paraphrased explanation of what the user was trying to do and what went wrong or was missing. No verbatim content."},
                    "severity": {"type": "string", "enum": ["low", "medium", "high"], "description": "Optional. How much this blocked the user."},
                },
                required: ["category", "summary"]
            })
        },
];
