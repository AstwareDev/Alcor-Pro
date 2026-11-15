import { appPaths } from "../../platform/backend";
import { joinPath, platformSkillFs, type SkillFs } from "./skillFs";
import type { SkillCatalog, SkillCatalogEntry } from "./skillCatalog";
import { replacingFields, requiredFields, type Skill } from "./skill";

// Port of Agent/Skills/SkillStore.swift. The folder of SKILL.md files is the single source of truth.
// Not ported: external-agent copy/reveal/open-folder (Settings UI), analytics.

export interface SkillLedger {
  installed: Record<string, string>;
  suppressed: Set<string>;
}

export type SkillOrigin = "community" | "community_modified" | "local";

export type SkillUpdateResult = { kind: "updated"; skill: Skill } | { kind: "unchanged"; skill: Skill } | { kind: "failed" };

export const newSkillTemplate = `---
name: New skill
description: Describe in one line when the assistant should use this skill.
---

## Workflow
1. First step.
2. Second step.`;

const ledgerVersion = 1;
const ledgerFile = ".installed.json";
const skillFile = "SKILL.md";

export async function sha12(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

export function suggestedID(name: string): string {
  const words = name.toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter((w) => w !== "");
  const candidate = Array.from(words.join("-")).slice(0, 64).join("").replace(/^-+|-+$/g, "");
  return candidate === "" ? "new-skill" : candidate;
}

function isValidSkillId(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\");
}

export function skillOrigin(installedSHA: string | undefined, localSHA: string | undefined): SkillOrigin {
  if (installedSHA === undefined) return "local";
  return localSHA === installedSHA ? "community" : "community_modified";
}

export function shouldAutomaticallyInstall(p: {
  localSHA: string | undefined;
  installedSHA: string | undefined;
  catalogSHA: string;
  isSuppressed: boolean;
}): boolean {
  if (p.isSuppressed) return false;
  if (p.localSHA === undefined) return p.installedSHA === undefined;
  if (p.installedSHA === undefined) return false;
  return p.localSHA === p.installedSHA && p.installedSHA !== p.catalogSHA;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");
}

/** Current `{version, installed, suppressed}` format, or the legacy plain `{id: sha}` map; undefined when neither. */
export function decodeLedger(text: string): SkillLedger | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json === "object" && json !== null && !Array.isArray(json)) {
    const p = json as { version?: unknown; installed?: unknown; suppressed?: unknown };
    if (p.version === ledgerVersion && isStringRecord(p.installed) && Array.isArray(p.suppressed) && p.suppressed.every((s) => typeof s === "string")) {
      return { installed: { ...p.installed }, suppressed: new Set(p.suppressed as string[]) };
    }
  }
  return isStringRecord(json) ? { installed: { ...json }, suppressed: new Set() } : undefined;
}

export function encodeLedger(ledger: SkillLedger): string {
  return JSON.stringify({ version: ledgerVersion, installed: ledger.installed, suppressed: [...ledger.suppressed].sort() });
}

interface ParsedSkill {
  skill: Skill;
  body: string;
  sha: string;
}

async function parseSkill(id: string, path: string, text: string): Promise<ParsedSkill | undefined> {
  const parsed = requiredFields(text);
  if (!parsed) return undefined;
  return { skill: { id, name: parsed.name, description: parsed.description, path }, body: parsed.body, sha: await sha12(text) };
}

export class SkillStore {
  private list: Skill[] = [];
  private bodies = new Map<string, string>();
  private shas = new Map<string, string>();
  private ledger: SkillLedger | undefined;
  private reloadGeneration = 0;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    readonly directory: string,
    private readonly fs: SkillFs,
  ) {}

  get skills(): readonly Skill[] {
    return this.list;
  }

  get installed(): Record<string, string> {
    return this.ledger?.installed ?? {};
  }

  get suppressed(): ReadonlySet<string> {
    return this.ledger?.suppressed ?? new Set();
  }

  body(id: string): string | undefined {
    return this.bodies.get(id);
  }

  contentSHA(id: string): string | undefined {
    return this.shas.get(id);
  }

  origin(id: string): SkillOrigin {
    return skillOrigin(this.ledger?.installed[id], this.shas.get(id));
  }

  /** One-line list of skills; full content loads on demand. */
  get skillIndex(): string {
    return this.list.map((s) => `- ${s.id}: ${s.description}`).join("\n");
  }

  async reloadSkills(): Promise<void> {
    await this.serialize(() => this.reload());
  }

  async rawContents(skill: Skill): Promise<string | undefined> {
    return this.fs.readText(skill.path);
  }

  async createSkill(raw: string, preferredID?: string): Promise<string | undefined> {
    if (!requiredFields(raw)) return undefined;
    return this.serialize(async () => {
      const id = await this.createSkillFile(raw, preferredID);
      await this.reload();
      return id;
    });
  }

  async save(skill: Skill, raw: string): Promise<boolean> {
    if (!(await parseSkill(skill.id, skill.path, raw))) return false;
    return (
      (await this.serialize(async () => {
        await this.fs.writeText(skill.path, raw);
        await this.reload();
        return true;
      })) ?? false
    );
  }

  async update(skill: Skill, fields: { name?: string; description?: string; instructions?: string }): Promise<SkillUpdateResult> {
    const result = await this.serialize(async (): Promise<SkillUpdateResult> => {
      const raw = await this.fs.readText(skill.path);
      if (raw === undefined) throw new Error(`Cannot read ${skill.path}`);
      const updated = replacingFields(raw, fields);
      const changed = updated !== raw;
      if (changed) await this.fs.writeText(skill.path, updated);
      await this.reload();
      const saved = this.list.find((s) => s.id === skill.id);
      if (!saved) return { kind: "failed" };
      return { kind: changed ? "updated" : "unchanged", skill: saved };
    });
    return result ?? { kind: "failed" };
  }

  /** Removes the folder and suppresses the id so the community catalog does not reinstall it. */
  async delete(skill: Skill): Promise<boolean> {
    return (
      (await this.serialize(async () => {
        const original = this.ledger;
        if (!original) return false;
        const next: SkillLedger = { installed: { ...original.installed }, suppressed: new Set(original.suppressed) };
        delete next.installed[skill.id];
        next.suppressed.add(skill.id);
        await this.persistLedger(next);
        this.ledger = next;
        try {
          await this.fs.remove(skill.path.slice(0, skill.path.lastIndexOf("/")));
        } catch (removalError) {
          try {
            await this.persistLedger(original);
            this.ledger = original;
          } catch {
            // the removal failure is the one worth surfacing
          }
          throw removalError;
        }
        await this.reload();
        return true;
      })) ?? false
    );
  }

  // MARK: Catalog install

  /** Reloads, refreshes the catalog, then installs new entries and outdated untouched ones. */
  async syncSkills(catalog: SkillCatalog): Promise<void> {
    await this.reloadSkills();
    if (!this.ledger) return;
    if (!(await catalog.refresh())) return;
    for (const entry of catalog.entries) {
      if (!this.automaticallyInstalls(entry)) continue;
      await this.install(catalog, entry, true);
    }
  }

  async install(catalog: SkillCatalog, entry: SkillCatalogEntry, automatically = false): Promise<boolean> {
    if (!this.ledger) return false;
    const dir = this.skillDirectory(entry.id);
    if (dir === undefined) return false;
    let text: string;
    try {
      text = await catalog.fetchBody(entry.path);
    } catch {
      return false;
    }
    if ((await sha12(text)) !== entry.sha) return false;
    const md = joinPath(dir, skillFile);
    if (!(await parseSkill(entry.id, md, text))) return false;
    const done = await this.serialize(async () => {
      if (automatically) await this.reload();
      const ledger = this.ledger;
      if (!ledger) return false;
      if (automatically && !this.automaticallyInstalls(entry)) return false;
      await this.fs.writeText(md, text);
      await this.reload();
      if (!this.list.some((s) => s.id === entry.id)) {
        await this.fs.remove(dir).catch(() => undefined);
        return false;
      }
      const next: SkillLedger = { installed: { ...ledger.installed, [entry.id]: entry.sha }, suppressed: new Set(ledger.suppressed) };
      next.suppressed.delete(entry.id);
      await this.persistLedger(next);
      this.ledger = next;
      return true;
    });
    return done ?? false;
  }

  /** `<directory>/<id>/` only when `id` is a single safe path component. */
  skillDirectory(id: string): string | undefined {
    return isValidSkillId(id) ? joinPath(this.directory, id) : undefined;
  }

  private automaticallyInstalls(entry: SkillCatalogEntry): boolean {
    const ledger = this.ledger;
    if (!ledger) return false;
    return shouldAutomaticallyInstall({
      localSHA: this.shas.get(entry.id),
      installedSHA: ledger.installed[entry.id],
      catalogSHA: entry.sha,
      isSuppressed: ledger.suppressed.has(entry.id),
    });
  }

  // MARK: Internals

  /** Failures resolve to undefined, like Swift's `serializeMutation`. */
  private serialize<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const task = this.mutations.then(operation);
    this.mutations = task.catch(() => undefined);
    return task.catch(() => undefined);
  }

  private async reload(): Promise<void> {
    this.reloadGeneration += 1;
    const generation = this.reloadGeneration;
    const scan = await this.scan();
    const ledger = await this.loadLedger();
    if (generation !== this.reloadGeneration) return;
    this.list = scan.skills;
    this.bodies = scan.bodies;
    this.shas = scan.shas;
    if (ledger) this.ledger = ledger;
  }

  private async scan(): Promise<{ skills: Skill[]; bodies: Map<string, string>; shas: Map<string, string> }> {
    const skills: Skill[] = [];
    const bodies = new Map<string, string>();
    const shas = new Map<string, string>();
    for (const id of await this.fs.listDirs(this.directory)) {
      const md = joinPath(this.directory, id, skillFile);
      const text = await this.fs.readText(md);
      if (text === undefined) continue;
      const parsed = await parseSkill(id, md, text);
      if (!parsed) continue;
      skills.push(parsed.skill);
      bodies.set(id, parsed.body);
      shas.set(id, parsed.sha);
    }
    skills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { skills, bodies, shas };
  }

  private async loadLedger(): Promise<SkillLedger | undefined> {
    const path = joinPath(this.directory, ledgerFile);
    if (!(await this.fs.exists(path))) return { installed: {}, suppressed: new Set() };
    const text = await this.fs.readText(path);
    return text === undefined ? undefined : decodeLedger(text);
  }

  private async persistLedger(ledger: SkillLedger): Promise<void> {
    await this.fs.writeText(joinPath(this.directory, ledgerFile), encodeLedger(ledger));
  }

  private async createSkillFile(raw: string, preferredID: string | undefined): Promise<string> {
    const validPreferred = preferredID !== undefined && isValidSkillId(preferredID) ? preferredID : undefined;
    const baseID = validPreferred ?? "new-skill";
    let id = baseID;
    if (validPreferred !== undefined) {
      const existing = joinPath(this.directory, id, skillFile);
      if (await this.fs.exists(existing)) {
        if ((await this.fs.readText(existing)) !== raw) throw new Error("File exists");
        return id;
      }
    } else {
      let n = 2;
      while (await this.fs.exists(joinPath(this.directory, id))) {
        id = `${baseID}-${n}`;
        n += 1;
      }
    }
    const dir = joinPath(this.directory, id);
    try {
      await this.fs.writeText(joinPath(dir, skillFile), raw);
    } catch (e) {
      await this.fs.remove(dir).catch(() => undefined);
      throw e;
    }
    return id;
  }
}

let defaultStore: Promise<SkillStore> | undefined;

/** The app's store under `<appData>/skills`, loaded once. */
export function appSkillStore(): Promise<SkillStore> {
  defaultStore ??= appPaths().then(async (paths) => {
    const store = new SkillStore(joinPath(paths.appData.replace(/\\/g, "/"), "skills"), platformSkillFs);
    await store.reloadSkills();
    return store;
  });
  return defaultStore;
}
