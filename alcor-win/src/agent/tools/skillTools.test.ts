import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memorySkillFs, type MemorySkillFs } from "../skills/skillFs";
import { decodeLedger, SkillStore } from "../skills/skillStore";
import "./metaGroup";
import { inAppAgentTools, mcpServerTools } from "./toolRegistry";
import { ToolHarness } from "./testHarness";
import { useSkillStore } from "./skillTools";
import type { ToolResult } from "./toolResult";

const dir = "/skills";
let fs: MemorySkillFs;
let store: SkillStore;
let restore: () => void;
let harness: ToolHarness;

beforeEach(async () => {
  fs = memorySkillFs();
  store = new SkillStore(dir, fs);
  await store.reloadSkills();
  restore = useSkillStore(async () => store);
  harness = new ToolHarness();
});
afterEach(() => restore());

async function call(
  action: string,
  p: { id?: string; name?: string; description?: string; instructions?: string } = {},
  source: "agent" | "mcp" = "agent",
): Promise<ToolResult> {
  const args: Record<string, unknown> = { action };
  if (p.id !== undefined) args.id = p.id;
  if (p.name !== undefined) args.name = p.name;
  const description = p.description ?? (action === "create" ? "Use this skill." : undefined);
  if (description !== undefined) args.description = description;
  const instructions = p.instructions ?? (action === "create" ? "Follow the workflow." : undefined);
  if (instructions !== undefined) args.instructions = instructions;
  return harness.executor.execute("manage_skills", args, source);
}

const json = (r: ToolResult): Record<string, unknown> => {
  expect(r.isError, ToolHarness.textOf(r)).toBe(false);
  return JSON.parse(ToolHarness.textOf(r)) as Record<string, unknown>;
};

describe("In-app skill tools", () => {
  it("schemasAreExposedOnlyToTheInAppAgent", () => {
    const inApp = new Set(inAppAgentTools().map((t) => t.definition.name));
    const mcp = new Set(mcpServerTools().map((t) => t.definition.name));
    expect(inApp.has("manage_skills")).toBe(true);
    expect(inApp.has("read_skill")).toBe(true);
    expect(mcp.has("manage_skills")).toBe(false);
    const tool = inAppAgentTools().find((t) => t.definition.name === "manage_skills");
    const props = (tool?.definition.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.action.enum).toEqual(["create", "update", "remove"]);
    expect(Object.keys(props).sort()).toEqual(["action", "description", "id", "instructions", "name"]);
  });

  it("createUpdateAndRemoveSkill", async () => {
    const initial = "## Workflow\nRemove pauses, then remove filler words.";
    const created = json(await call("create", { name: "Interview Cleanup", description: "Tighten spoken interviews.", instructions: initial }));
    expect(created.status).toBe("created");
    expect((created.skill as { id: string }).id).toBe("interview-cleanup");
    expect(store.body("interview-cleanup")).toBe(initial);

    const repeated = json(await call("create", { name: "Interview Cleanup", description: "Tighten spoken interviews.", instructions: initial }));
    expect(repeated.status).toBe("unchanged");
    expect(store.skills.length).toBe(1);

    const updated = json(
      await call("update", { id: "interview-cleanup", description: "Tighten interviews while preserving intent.", instructions: "## Workflow\nRemove pauses conservatively." }),
    );
    expect(updated.status).toBe("updated");
    expect(updated.changed).toEqual(["description", "instructions"]);
    expect(store.body("interview-cleanup")).toBe("## Workflow\nRemove pauses conservatively.");

    const unchanged = json(await call("update", { id: "interview-cleanup", description: "Tighten interviews while preserving intent." }));
    expect(unchanged.status).toBe("unchanged");

    const read = await harness.runRaw("read_skill", { id: "interview-cleanup" });
    expect(ToolHarness.textOf(read)).toBe("## Workflow\nRemove pauses conservatively.");

    expect(json(await call("remove", { id: "interview-cleanup" })).status).toBe("removed");
    expect(store.skills).toEqual([]);
  });

  it("removingLocalSkillSuppressesMatchingCatalogID", async () => {
    expect((await call("create", { name: "Catalog Collision" })).isError).toBe(false);
    expect((await call("remove", { id: "catalog-collision" })).isError).toBe(false);
    const ledger = decodeLedger(fs.files.get(`${dir}/.installed.json`) ?? "");
    expect(ledger?.suppressed.has("catalog-collision")).toBe(true);
  });

  it("ledgerWriteFailureLeavesSkillIntact", async () => {
    expect((await call("create", { name: "Protected Skill" })).isError).toBe(false);
    fs.blockedWrites.add(`${dir}/.installed.json`);
    expect((await call("remove", { id: "protected-skill" })).isError).toBe(true);
    expect(fs.files.has(`${dir}/protected-skill/SKILL.md`)).toBe(true);
  });

  it("folderRemovalFailureRestoresLedger", async () => {
    const missing = { id: "missing", name: "Missing", description: "Missing fixture.", path: `${dir}/missing/SKILL.md` };
    expect(await store.delete(missing)).toBe(false);
    const ledger = decodeLedger(fs.files.get(`${dir}/.installed.json`) ?? "");
    expect(ledger).toEqual({ installed: {}, suppressed: new Set() });
  });

  it("rejectsInvalidUpdatesAndMCPCalls", async () => {
    const invalid = await call("update", { id: "missing" });
    expect(invalid.isError).toBe(true);
    expect(ToolHarness.textOf(invalid)).toContain("at least one");

    const mcp = await call("create", { name: "Private Workflow" }, "mcp");
    expect(mcp.isError).toBe(true);
    expect(ToolHarness.textOf(mcp)).toContain("Unknown tool");
    expect(store.skills).toEqual([]);
  });

  it("validates text fields and unknown skills", async () => {
    expect(ToolHarness.textOf(await call("create", { name: "Two\nLines" }))).toBe("manage_skills.name: expected one line");
    expect(ToolHarness.textOf(await call("create", { name: "A".repeat(121) }))).toBe("manage_skills.name: maximum length is 120 characters");
    expect(ToolHarness.textOf(await call("explode"))).toBe("Unknown skill action 'explode'. Expected one of: create, update, remove.");
    expect(ToolHarness.textOf(await call("remove", { id: "nope" }))).toBe("Unknown skill: nope");
    expect(ToolHarness.textOf(await harness.runRaw("read_skill", { id: "nope" }))).toBe("Unknown skill: nope");
    expect(ToolHarness.textOf(await harness.runRaw("read_skill", {}))).toBe("read_skill requires an 'id'.");
  });
});
