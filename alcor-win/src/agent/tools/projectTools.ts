import type { Editor } from "../../editor/editor";
import { makeTimeline } from "../../model";
import { applyResolvedProjectSettings, validateProjectSettings } from "./projectSettingsTools";
import { ToolError, argString, validateUnknownKeys } from "./toolArgs";
import { jsonString } from "./jsonFormat";
import { shorteningIds, currentIdUniverse } from "./toolExecutorShortId";
import { ToolExecutor } from "./toolExecutor";
import type { AgentHost, AgentHostProjectEntry } from "./agentHost";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { ok, type ToolResult } from "./toolResult";
import { timelineEntries } from "./timelinePayload";

// Port of ToolExecutor+Projects.swift: MCP server-only project navigation. Runs against the AgentHost before an
// editor is available.

const defaultProjectName = "Untitled Project";

function requireHost(executor: ToolExecutor): AgentHost {
  if (!executor.host) throw new ToolError("Project tools are only available to the MCP server.");
  return executor.host;
}

type ProjectSelector = { kind: "name"; value: string } | { kind: "id"; value: string } | { kind: "path"; value: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function projectSelector(args: ToolArgs, path: string): ProjectSelector | undefined {
  const supplied = ["name", "id", "path"].filter((k) => k in args);
  if (supplied.length > 1) throw new ToolError(`${path}: provide only one of: name, id, path.`);
  const key = supplied[0];
  if (key === undefined) return undefined;
  const value = argString(args, key);
  if (value === undefined || value.trim() === "") throw new ToolError(`${path}: '${key}' must be a non-empty string.`);
  if (key === "name") return { kind: "name", value };
  if (key === "path") return { kind: "path", value };
  if (!uuidPattern.test(value)) throw new ToolError(`${path}: 'id' must be a project id returned by action='list'.`);
  return { kind: "id", value };
}

const normalizePathKey = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

async function resolveProjectPath(host: AgentHost, selector: ProjectSelector): Promise<string> {
  if (selector.kind === "path") return selector.value;
  const entries = await host.listProjects();
  if (selector.kind === "id") {
    const entry = entries.find((e) => e.id.toLowerCase() === selector.value.toLowerCase());
    if (!entry) throw new ToolError(`No project with id ${selector.value.toUpperCase()}. Call manage_project with action='list' for valid ids.`);
    return entry.path;
  }
  const matches = entries.filter((e) => e.name.localeCompare(selector.value, undefined, { sensitivity: "accent" }) === 0);
  if (matches.length === 1) return matches[0].path;
  if (matches.length === 0) {
    const known = entries.slice(0, 15).map((e) => e.name);
    throw new ToolError(`No project named '${selector.value}'. Known projects: ${known.join(", ")}. Call manage_project with action='list' for the full list.`);
  }
  throw new ToolError(`${matches.length} projects are named '${selector.value}'. Pick one by path: ${matches.map((m) => m.path).join(", ")}`);
}

function projectSnapshot(host: AgentHost, editor: Editor, status: string, openCount: number): Record<string, unknown> {
  return {
    status,
    name: host.displayName(editor),
    path: editor.projectPath ?? "",
    fps: editor.timeline.fps,
    resolution: `${editor.timeline.width}x${editor.timeline.height}`,
    mediaCount: editor.mediaAssets.length,
    canGenerate: ToolExecutor.canGenerate,
    timelines: timelineEntries(editor),
    openCount,
  };
}

function withShortIds(editor: Editor, result: ToolResult): ToolResult {
  return shorteningIds(result, currentIdUniverse(editor));
}

async function listProjects(host: AgentHost, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, [], "manage_project action='list'");
  const current = host.currentEditor();
  const currentPath = current?.projectPath ? normalizePathKey(current.projectPath) : undefined;
  const entries: AgentHostProjectEntry[] = await host.listProjects();
  const projects = entries.map((entry) => {
    const isOpen = currentPath !== undefined && normalizePathKey(entry.path) === currentPath;
    return {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      isOpen,
      isActive: isOpen,
      isVisible: isOpen,
      isAccessible: entry.isAccessible,
    };
  });
  const payload: Record<string, unknown> = { openCount: current ? 1 : 0, projects };
  if (current) {
    const where = { name: host.displayName(current), path: current.projectPath ?? "" };
    payload.active = where;
    payload.visible = where;
  }
  return ok(jsonString(payload));
}

async function openProject(host: AgentHost, args: ToolArgs): Promise<ToolResult> {
  const actionPath = "manage_project action='open'";
  validateUnknownKeys(args, ["name", "id", "path"], actionPath);
  const selector = projectSelector(args, actionPath);
  if (!selector) throw new ToolError(`${actionPath} needs a name, an id from action='list', or a path.`);
  const path = await resolveProjectPath(host, selector);
  let editor: Editor;
  try {
    editor = await host.openProject(path);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    // The package is probed by the host; a missing one reads as "No project at …".
    throw new ToolError(openFailureMessage(path, e));
  }
  return withShortIds(editor, ok(jsonString(projectSnapshot(host, editor, "active", 1))));
}

function openFailureMessage(path: string, e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return /no such file|not found|missing project\.json|os error 2|os error 3/i.test(text) ? `No project at ${path}.` : text;
}

async function createProject(host: AgentHost, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, ["name", "fps", "aspectRatio", "quality"], "manage_project action='create'");
  if ("name" in args && typeof args.name !== "string") throw new ToolError("manage_project action='create': 'name' must be a string.");
  const name = typeof args.name === "string" ? args.name : defaultProjectName;
  const settingsArgs = Object.fromEntries(Object.entries(args).filter(([k]) => ["fps", "aspectRatio", "quality"].includes(k)));
  const settings = Object.keys(settingsArgs).length === 0 ? undefined : validateProjectSettings(settingsArgs);
  const resolved = settings?.resolve(makeTimeline());
  const editor = await host.createProject(name);
  if (resolved) editor.perform("Set Project Settings (Agent)", () => applyResolvedProjectSettings(editor, resolved));
  return withShortIds(editor, ok(jsonString(projectSnapshot(host, editor, "created", 1))));
}

async function closeProject(host: AgentHost, args: ToolArgs): Promise<ToolResult> {
  const actionPath = "manage_project action='close'";
  validateUnknownKeys(args, ["name", "id", "path"], actionPath);
  const selector = projectSelector(args, actionPath);
  const current = host.currentEditor();
  let target: Editor;
  if (selector) {
    const path = await resolveProjectPath(host, selector);
    if (!current?.projectPath || normalizePathKey(current.projectPath) !== normalizePathKey(path)) {
      throw new ToolError(`Project at ${path} isn't open.`);
    }
    target = current;
  } else if (current) {
    target = current;
  } else {
    throw new ToolError("No project is open.");
  }
  const name = host.displayName(target);
  try {
    await host.closeProject(target);
  } catch (e) {
    throw new ToolError(`Couldn't save '${name}' — project left open. ${e instanceof Error ? e.message : String(e)}`);
  }
  const payload: Record<string, unknown> = { status: "closed", name, openCount: host.currentEditor() ? 1 : 0 };
  const nowActive = host.currentEditor();
  if (nowActive) {
    const where = { name: host.displayName(nowActive), path: nowActive.projectPath ?? "" };
    payload.active = where;
    payload.visible = where;
  }
  return ok(jsonString(payload));
}

export async function manageProject({ executor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const host = requireHost(executor);
  validateUnknownKeys(args, ["action", "name", "id", "path", "fps", "aspectRatio", "quality"], "manage_project");
  const action = argString(args, "action");
  if (action === undefined) throw new ToolError("manage_project requires an 'action'.");
  const actionArgs = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "action"));
  switch (action) {
    case "list":
      return listProjects(host, actionArgs);
    case "open":
      return openProject(host, actionArgs);
    case "create":
      return createProject(host, actionArgs);
    case "close":
      return closeProject(host, actionArgs);
    default:
      throw new ToolError(`Unknown project action '${action}'. Use one of: list, open, create, close.`);
  }
}

