import { appPaths, fsCopy, fsList, fsMkdir, fsRemove, fsRename, fsStat, fsWriteBytes } from "../platform/backend";
import { mediaUrl } from "./mediaUrl";
import type { MediaIo } from "./io";

async function fetchBytes(path: string, range?: string): Promise<Uint8Array> {
  const res = await fetch(mediaUrl(path), range ? { headers: { Range: range } } : undefined);
  if (!res.ok && res.status !== 206) throw new Error(`read ${path}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

let paths: ReturnType<typeof appPaths> | undefined;
const getPaths = () => (paths ??= appPaths());

export const backendMediaIo: MediaIo = {
  stat: fsStat,
  list: fsList,
  writeBytes: fsWriteBytes,
  async readHead(path, length) {
    const bytes = await fetchBytes(path, `bytes=0-${Math.max(0, length - 1)}`);
    return bytes.length > length ? bytes.subarray(0, length) : bytes;
  },
  readAll: (path) => fetchBytes(path),
  copy: fsCopy,
  rename: fsRename,
  mkdir: fsMkdir,
  remove: fsRemove,
  cacheDir: async () => (await getPaths()).cache,
  tempDir: async () => (await getPaths()).temp,
};
