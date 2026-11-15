import { httpFetch } from "../../platform/backend";
import { joinPath, type SkillFs } from "./skillFs";

// Port of Agent/Skills/SkillCatalog.swift: the community catalog from the palmier-skills repo.

/** `sha` is a 12-char content hash of the SKILL.md and is the version anchor. */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  sha: string;
  path: string;
}

export const defaultCatalogBase = "https://raw.githubusercontent.com/palmier-io/palmier-skills/main";

export type TextFetch = (url: string) => Promise<string>;

export const httpTextFetch: TextFetch = async (url) => {
  const response = await httpFetch({ url });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return response.bodyText;
};

function decodeEntries(text: string): SkillCatalogEntry[] {
  const json: unknown = JSON.parse(text);
  if (!Array.isArray(json)) throw new Error("catalog is not an array");
  return json.map((e: unknown): SkillCatalogEntry => {
    const o = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
    const { id, name, description, sha, path } = o;
    if (typeof id !== "string" || typeof name !== "string" || typeof description !== "string" || typeof sha !== "string" || typeof path !== "string") {
      throw new Error("bad catalog entry");
    }
    return { id, name, description, sha, path };
  });
}

const cacheFile = "skills-catalog.json";

export class SkillCatalog {
  entries: SkillCatalogEntry[] = [];
  isLoading = false;
  lastError: string | undefined;

  constructor(
    private readonly fetchText: TextFetch = httpTextFetch,
    private readonly cache?: { fs: SkillFs; directory: string },
    private readonly base: string = defaultCatalogBase,
  ) {}

  entry(id: string): SkillCatalogEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  bodyURL(path: string): string {
    return `${this.base}/${path}`;
  }

  fetchBody(path: string): Promise<string> {
    return this.fetchText(this.bodyURL(path));
  }

  async loadCache(): Promise<void> {
    if (!this.cache) return;
    const text = await this.cache.fs.readText(joinPath(this.cache.directory, cacheFile));
    if (text === undefined) return;
    try {
      this.entries = decodeEntries(text);
    } catch {
      // a corrupt cache is ignored
    }
  }

  async refresh(): Promise<boolean> {
    if (this.isLoading) return false;
    this.isLoading = true;
    try {
      const text = await this.fetchText(`${this.base}/catalog.json`);
      this.entries = decodeEntries(text);
      this.lastError = undefined;
      if (this.cache) await this.cache.fs.writeText(joinPath(this.cache.directory, cacheFile), text).catch(() => undefined);
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      this.isLoading = false;
    }
  }
}
