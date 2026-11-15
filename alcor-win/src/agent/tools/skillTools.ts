import { frontmatterContents, skillLimits, type Skill } from "../skills/skill";
import { appSkillStore, suggestedID, type SkillStore } from "../skills/skillStore";
import { jsonString } from "./jsonFormat";
import { ToolError, argString, validateUnknownKeys } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import { error, ok, type ToolResult } from "./toolResult";

// Port of ToolExecutor+Skills.swift and `readSkill` from ToolExecutor.swift. Not ported: skill analytics.

let storeProvider: () => Promise<SkillStore> = appSkillStore;

/** Swaps the skill store the tools use (tests inject an in-memory one). Returns a function restoring the previous provider. */
export function useSkillStore(provider: () => Promise<SkillStore>): () => void {
  const previous = storeProvider;
  storeProvider = provider;
  return () => {
    storeProvider = previous;
  };
}

export async function readSkill(_context: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const id = argString(args, "id");
  if (id === undefined) return error("read_skill requires an 'id'.");
  const body = (await storeProvider()).body(id);
  if (body === undefined) return error(`Unknown skill: ${id}`);
  return ok(body);
}

export async function manageSkills(_context: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const action = argString(args, "action");
  if (action === undefined) throw new ToolError("manage_skills.action: expected one of: create, update, remove");
  const store = await storeProvider();
  switch (action) {
    case "create":
      return createSkill(store, args);
    case "update":
      return updateSkill(store, args);
    case "remove":
      return removeSkill(store, args);
    default:
      throw new ToolError(`Unknown skill action '${action}'. Expected one of: create, update, remove.`);
  }
}

const newlines = /[\n\r\u000B\u000C\u0085\u2028\u2029]/;

function optionalSkillText(args: ToolArgs, key: string, maximumLength: number, singleLine: boolean): string | undefined {
  const path = "manage_skills";
  if (!(key in args)) return undefined;
  const raw = args[key];
  if (typeof raw !== "string") throw new ToolError(`${path}.${key}: expected string`);
  const value = raw.trim();
  if (value === "") throw new ToolError(`${path}.${key}: expected non-empty string`);
  if (Array.from(value).length > maximumLength) throw new ToolError(`${path}.${key}: maximum length is ${maximumLength} characters`);
  if (singleLine && newlines.test(value)) throw new ToolError(`${path}.${key}: expected one line`);
  return value;
}

function requiredSkillText(args: ToolArgs, key: string, maximumLength: number, singleLine: boolean): string {
  const value = optionalSkillText(args, key, maximumLength, singleLine);
  if (value === undefined) throw new ToolError(`manage_skills.${key}: expected non-empty string`);
  return value;
}

function skillReceipt(status: string, skill: Skill, changed?: string[]): ToolResult {
  const payload: Record<string, unknown> = { status, skill: { id: skill.id, name: skill.name, description: skill.description } };
  if (changed) payload.changed = changed;
  return ok(jsonString(payload));
}

async function createSkill(store: SkillStore, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, ["action", "name", "description", "instructions"], "manage_skills");
  const name = requiredSkillText(args, "name", skillLimits.maximumNameLength, true);
  const description = requiredSkillText(args, "description", skillLimits.maximumDescriptionLength, true);
  const instructions = requiredSkillText(args, "instructions", skillLimits.maximumInstructionsLength, false);
  const id = suggestedID(name);

  const existing = store.skills.find((s) => s.id === id);
  if (existing) {
    if (existing.name !== name || existing.description !== description || store.body(id) !== instructions) {
      throw new ToolError(`A skill with id '${id}' already exists. Use manage_skills with action='update'.`);
    }
    return skillReceipt("unchanged", existing);
  }

  const createdID = await store.createSkill(frontmatterContents(name, description, instructions), id);
  const skill = createdID === undefined ? undefined : store.skills.find((s) => s.id === createdID);
  if (!skill) throw new ToolError(`Could not create skill '${name}'.`);
  return skillReceipt("created", skill);
}

async function updateSkill(store: SkillStore, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, ["action", "id", "name", "description", "instructions"], "manage_skills");
  const id = argString(args, "id");
  if (id === undefined) throw new ToolError("manage_skills.id: expected non-empty string for update");
  const name = optionalSkillText(args, "name", skillLimits.maximumNameLength, true);
  const description = optionalSkillText(args, "description", skillLimits.maximumDescriptionLength, true);
  const instructions = optionalSkillText(args, "instructions", skillLimits.maximumInstructionsLength, false);
  if (name === undefined && description === undefined && instructions === undefined) {
    throw new ToolError("manage_skills update requires at least one of: name, description, instructions.");
  }
  const skill = store.skills.find((s) => s.id === id);
  if (!skill) throw new ToolError(`Unknown skill: ${id}`);

  const changed: string[] = [];
  if (name !== undefined && name !== skill.name) changed.push("name");
  if (description !== undefined && description !== skill.description) changed.push("description");
  if (instructions !== undefined && instructions !== store.body(id)) changed.push("instructions");
  if (changed.length === 0) return skillReceipt("unchanged", skill);

  const result = await store.update(skill, { name, description, instructions });
  switch (result.kind) {
    case "updated":
      return skillReceipt("updated", result.skill, changed);
    case "unchanged":
      return skillReceipt("unchanged", result.skill);
    case "failed":
      throw new ToolError(`Could not update skill '${id}'.`);
  }
}

async function removeSkill(store: SkillStore, args: ToolArgs): Promise<ToolResult> {
  validateUnknownKeys(args, ["action", "id"], "manage_skills");
  const id = argString(args, "id");
  if (id === undefined) throw new ToolError("manage_skills.id: expected non-empty string for remove");
  const skill = store.skills.find((s) => s.id === id);
  if (!skill) throw new ToolError(`Unknown skill: ${id}`);
  if (!(await store.delete(skill))) throw new ToolError(`Could not remove skill '${id}'.`);
  return ok(jsonString({ status: "removed", id: skill.id, name: skill.name }));
}

