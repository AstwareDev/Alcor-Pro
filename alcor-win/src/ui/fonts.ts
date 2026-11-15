// The only place that talks to the platform font list (window.queryLocalFonts), with a fixed fallback.

export interface FontCatalog {
  /** Bundled/featured families shown first (none are bundled on Windows yet). */
  featured: string[];
  /** Every other family, sorted. */
  all: string[];
}

interface LocalFontData {
  family: string;
}

type QueryLocalFonts = () => Promise<LocalFontData[]>;

export const fallbackFontFamilies: readonly string[] = [
  "Arial", "Arial Black", "Bahnschrift", "Calibri", "Cambria", "Candara", "Cascadia Code", "Comic Sans MS",
  "Consolas", "Constantia", "Corbel", "Courier New", "Ebrima", "Franklin Gothic Medium", "Gabriola", "Georgia",
  "Helvetica", "Impact", "Lucida Console", "Lucida Sans Unicode", "Palatino Linotype", "Segoe Print",
  "Segoe Script", "Segoe UI", "Sitka Text", "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana",
];

let cached: Promise<FontCatalog> | undefined;

/** Installed families via `queryLocalFonts()` when the webview offers it (permission may be denied), else the fixed list. */
export function loadFontCatalog(): Promise<FontCatalog> {
  cached ??= queryFamilies().then((all) => ({ featured: [], all }));
  return cached;
}

async function queryFamilies(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (typeof query === "function") {
    try {
      const fonts = await query.call(window);
      const families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      if (families.length > 0) return families;
    } catch {
      // Permission denied or unsupported: use the fallback list.
    }
  }
  return [...fallbackFontFamilies];
}

/** Test seam: forget the cached catalog. */
export function resetFontCatalogCache(): void {
  cached = undefined;
}
