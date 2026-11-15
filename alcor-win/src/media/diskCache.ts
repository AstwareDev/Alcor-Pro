import { joinPath } from "../model";
import { mediaIo } from "./io";

/** `DiskCache(named:)`: a named directory under the app cache dir. */
export async function diskCacheDirectory(name: string): Promise<string> {
  return joinPath(await (await mediaIo()).cacheDir(), name);
}

/** Total size of all files under a directory, recursively; 0 when it does not exist. */
export async function diskCacheBytes(directory: string): Promise<number> {
  const io = await mediaIo();
  let entries;
  try {
    entries = await io.list(directory);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) total += entry.isDir ? await diskCacheBytes(entry.path) : entry.size;
  return total;
}

/** Removes every entry in the directory, keeping the directory itself. */
export async function clearDiskCache(directory: string): Promise<void> {
  const io = await mediaIo();
  let entries;
  try {
    entries = await io.list(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      await io.remove(entry.path);
    } catch {
      // best effort, like `try? removeItem`
    }
  }
}
