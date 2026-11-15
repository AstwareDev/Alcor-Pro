// Port of Agent/Skills/Skill.swift. A skill is a folder `<skills dir>/<id>/` with a `SKILL.md` file.
export { skillLimits } from "../tools/definitions/limits";

export interface Skill {
  /** Folder name. */
  id: string;
  name: string;
  description: string;
  /** The SKILL.md file. */
  path: string;
}

// Swift `.whitespaces` (space/tab, not newlines).
const trimInline = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, "");

export function frontmatterContents(name: string, description: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}`;
}

/** Splits a SKILL.md into its frontmatter fields and body. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const fields: Record<string, string> = {};
  const lines = text.split("\n");
  if (trimInline(lines[0] ?? "") !== "---") return { fields, body: text };
  let i = 1;
  while (i < lines.length && trimInline(lines[i]) !== "---") {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon >= 0) {
      const key = trimInline(line.slice(0, colon));
      let value = trimInline(line.slice(colon + 1));
      if (Array.from(value).length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      if (key !== "") fields[key] = value;
    }
    i += 1;
  }
  const body = i + 1 < lines.length ? lines.slice(i + 1).join("\n").trim() : "";
  return { fields, body };
}

export function requiredFields(text: string): { name: string; description: string; body: string } | undefined {
  const parsed = parseFrontmatter(text);
  const name = parsed.fields["name"];
  const description = parsed.fields["description"];
  if (name === undefined || trimInline(name) === "" || description === undefined || trimInline(description) === "") return undefined;
  return { name, description, body: parsed.body };
}

export function replacingFields(
  text: string,
  fields: { name?: string; description?: string; instructions?: string } = {},
): string {
  const lines = text.split("\n");
  let closingIndex = -1;
  if (trimInline(lines[0] ?? "") === "---") {
    closingIndex = lines.findIndex((l, i) => i > 0 && trimInline(l) === "---");
  }
  if (closingIndex < 0) {
    const parsed = parseFrontmatter(text);
    return frontmatterContents(
      fields.name ?? parsed.fields["name"] ?? "New skill",
      fields.description ?? parsed.fields["description"] ?? "Describe when to use this skill.",
      fields.instructions ?? parsed.body,
    );
  }

  const replace = (key: string, value: string): void => {
    let index = -1;
    for (let k = 1; k < closingIndex; k += 1) {
      const colon = lines[k].indexOf(":");
      if (colon >= 0 && trimInline(lines[k].slice(0, colon)) === key) {
        index = k;
        break;
      }
    }
    if (index >= 0) lines[index] = `${key}: ${value}`;
    else {
      lines.splice(closingIndex, 0, `${key}: ${value}`);
      closingIndex += 1;
    }
  };

  if (fields.name !== undefined) replace("name", fields.name);
  if (fields.description !== undefined) replace("description", fields.description);
  if (fields.instructions === undefined) return lines.join("\n");
  return `${lines.slice(0, closingIndex + 1).join("\n")}\n\n${fields.instructions}`;
}
