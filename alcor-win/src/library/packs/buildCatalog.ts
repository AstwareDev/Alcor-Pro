import { catalogFormatName, catalogFormatVersion, type Catalog } from "../catalog";
import { encodePresetDocument } from "../presetFormat";
import { sha256Hex } from "../sha256";
import { packDefinitions, type PackDefinition } from "./packs";

export const presetsFileName = "presets.json";

export interface BuiltCatalog {
  /** Paths relative to the catalog root (`index.json`, `packs/<id>/presets.json`). */
  files: Map<string, string>;
  index: unknown;
}

/** Serialises every pack definition into publishable files plus the index that points at them. */
export async function buildCatalog(definitions: readonly PackDefinition[] = packDefinitions): Promise<BuiltCatalog> {
  const files = new Map<string, string>();
  const packs: unknown[] = [];
  for (const def of definitions) {
    const text = `${JSON.stringify(encodePresetDocument(def.presets), null, 1)}\n`;
    const bytes = new TextEncoder().encode(text);
    const path = `packs/${def.id}/${presetsFileName}`;
    files.set(path, text);
    const entries = [
      { path: presetsFileName, url: path, sha256: await sha256Hex(bytes), size: bytes.byteLength },
      ...def.remoteFiles,
    ];
    packs.push({
      id: def.id,
      name: def.name,
      kind: def.kind,
      version: def.version,
      description: def.description,
      size: entries.reduce((n, f) => n + f.size, 0),
      licence: def.licence,
      attribution: def.attribution,
      author: def.author,
      sourceUrl: def.sourceUrl,
      files: entries,
    });
  }
  const index = { format: catalogFormatName, version: catalogFormatVersion, packs };
  files.set("index.json", `${JSON.stringify(index, null, 1)}\n`);
  return { files, index };
}

export type { Catalog };
