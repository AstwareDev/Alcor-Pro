import type { ToolExecutor } from "./toolExecutor";
import type { ToolResult } from "./toolResult";
import type { Editor } from "../../editor/editor";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** MCP `tools/list` entry. Strings and schemas are copied verbatim from Palmier Pro. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  annotations?: JsonObject;
}

export type ToolArgs = Record<string, unknown>;

export interface ToolContext {
  executor: ToolExecutor;
  editor: Editor;
}

export type ToolHandler = (context: ToolContext, args: ToolArgs) => ToolResult | Promise<ToolResult>;

export interface ToolRegistration {
  definition: ToolDefinition;
  run: ToolHandler;
  /** `ToolName.publishesTimelineChanges`: successful timeline changes are highlighted in the editor. */
  publishesTimelineChanges?: boolean;
  /** `canReadInactiveProject`: allowed while another project is frontmost. */
  readsInactiveProject?: boolean;
  /** Runs before an editor is resolved (manage_project). */
  needsEditor?: false;
  /** Only the in-app assistant sees this tool (never advertised over MCP). */
  inAppOnly?: boolean;
  /** Only MCP sessions see this tool. */
  mcpOnly?: boolean;
}

/** Swift `ToolDefinitions.all` order, so groups registered in any sequence still list like the original. */
const canonicalOrder = [
  "get_timeline", "inspect_timeline", "create_timeline", "set_active_timeline", "manage_markers", "set_project_settings",
  "export_project", "manage_exports", "get_media", "inspect_media", "search_media", "import_media", "capture_frame",
  "organize_media", "add_clips", "insert_clips", "move_clips", "remove_clips", "manage_clip_links", "manage_tracks",
  "split_clips", "ripple_delete_ranges", "swap_clip_media", "set_clip_properties", "copy_clip_settings", "set_keyframes",
  "apply_layout", "sync_clips", "manage_multicam", "change_cam", "get_multicam", "undo", "get_transcript", "remove_words",
  "remove_silence", "detect_beats", "add_texts", "update_text", "add_captions", "apply_color", "apply_effect",
  "inspect_color", "denoise_audio", "list_models", "generate_video", "generate_image", "generate_audio", "upscale_media",
  "send_feedback", "read_skill", "manage_skills", "manage_project",
];

const groups = new Map<string, ToolRegistration[]>();
const listeners = new Set<() => void>();

/**
 * Registers a group's tools (replacing any earlier registration of the same group). Each group module calls this
 * once at import time, so adding a group never touches another group's files.
 */
export function defineTools(group: string, registrations: ToolRegistration[]): void {
  groups.set(group, registrations);
  for (const listener of listeners) listener();
}

export function registeredTools(): ToolRegistration[] {
  const all = [...groups.values()].flat();
  const rank = (name: string): number => {
    const i = canonicalOrder.indexOf(name);
    return i < 0 ? canonicalOrder.length : i;
  };
  return all
    .map((registration, index) => ({ registration, index }))
    .sort((a, b) => rank(a.registration.definition.name) - rank(b.registration.definition.name) || a.index - b.index)
    .map((entry) => entry.registration);
}

export function registeredTool(name: string): ToolRegistration | undefined {
  return registeredTools().find((r) => r.definition.name === name);
}

/** `ToolDefinitions.mcpServer`: everything except in-app-only tools. */
export function mcpServerTools(): ToolRegistration[] {
  return registeredTools().filter((r) => r.inAppOnly !== true);
}

/** `ToolDefinitions.inAppAgent`: everything except MCP-only tools. */
export function inAppAgentTools(): ToolRegistration[] {
  return registeredTools().filter((r) => r.mcpOnly !== true);
}

/** Fires when a group is (re)registered, so the MCP bridge can announce the changed tool list. */
export function onToolRegistryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The definition named `name` from a group's definition list (throws if the Swift tool is missing). */
export function definitionNamed(definitions: readonly ToolDefinition[], name: string): ToolDefinition {
  const found = definitions.find((d) => d.name === name);
  if (!found) throw new Error(`missing tool definition: ${name}`);
  return found;
}
