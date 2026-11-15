/** `DiskCache.sizeMtimeTag`: busts when the underlying file is replaced. Missing file -> "0_0". */
export function sizeMtimeTag(stat: { size: number; modifiedMs: number } | null): string {
  if (!stat) return "0_0";
  return `${stat.size}_${Math.trunc(stat.modifiedMs / 1000)}`;
}

/** `MediaVisualCache.diskCacheKey`: first 16 bytes of SHA-256("path|size|mtimeSeconds") as hex; keyed on path + size + mtime. */
export async function diskCacheKey(path: string, stat: { size: number; modifiedMs: number }): Promise<string> {
  const seed = `${path}|${stat.size}|${stat.modifiedMs / 1000}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  let hex = "";
  for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex;
}
