import { describe, expect, it } from "vitest";
import { replacingFields, requiredFields } from "./skill";
import { newSkillTemplate, suggestedID } from "./skillStore";

describe("Skill frontmatter", () => {
  it("requiresNonemptyNameAndDescription", () => {
    const valid = "---\nname: Editing\ndescription: Edit clips.\n---\n\nInstructions";
    const missingName = "---\ndescription: Edit clips.\n---\n\nInstructions";
    const emptyDescription = "---\nname: Editing\ndescription:   \n---\n\nInstructions";
    expect(requiredFields(valid)).toBeDefined();
    expect(requiredFields(missingName)).toBeUndefined();
    expect(requiredFields(emptyDescription)).toBeUndefined();
  });

  it("replacingOnlyNameKeepsTheDraftInstructions", () => {
    const draft = "---\nname: New skill\ndescription: Edit clips.\n---\n\n## Workflow\n1. First step.";
    expect(replacingFields(draft, { name: "Editing" })).toBe("---\nname: Editing\ndescription: Edit clips.\n---\n\n## Workflow\n1. First step.");
  });

  it("replacingFieldsPreservesUnchangedFrontmatter", () => {
    const draft = "---\nname: Editing\ndescription: Edit clips.\nsource: local\n---\n\nOld instructions";
    const updated = replacingFields(draft, { description: "Tighten interview edits.", instructions: "## Workflow\nRemove pauses." });
    expect(updated).toBe("---\nname: Editing\ndescription: Tighten interview edits.\nsource: local\n---\n\n## Workflow\nRemove pauses.");
  });

  it("suggestedSkillIDIsStableAndFilesystemSafe", () => {
    expect(suggestedID("  Interview Cleanup & Pacing  ")).toBe("interview-cleanup-pacing");
    expect(suggestedID("///")).toBe("new-skill");
  });

  it("newSkillTemplateIsValidBeforeItIsSaved", () => {
    const parsed = requiredFields(newSkillTemplate);
    expect(parsed?.name).toBe("New skill");
    expect(parsed?.description).not.toBe("");
  });
});
