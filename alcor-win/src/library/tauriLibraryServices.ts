import { openUrl } from "@tauri-apps/plugin-opener";
import { addMediaAsset } from "../media/mediaLibrary";
import { mediaUrl } from "../media/mediaUrl";
import {
  appPaths, fsExists, fsList, fsMkdir, fsReadText, fsRemove, fsRename, fsWriteText, httpCancel, httpDownload, httpFetch, secretBuiltin, secretHas,
} from "../platform/backend";
import { lutLoader } from "../platform/luts";
import { newId } from "../util/id";
import { freesoundSecretName } from "./freesound";
import { MissingKeyError, type LibraryServices } from "./libraryServices";
import { joinPath, type InstallerDeps } from "./packInstaller";
import { sha256Hex } from "./sha256";

/** Streams a public URL to disk; aborting the signal cancels the Rust-side request. */
async function download(url: string, dest: string, onProgress: (received: number) => void, signal: AbortSignal): Promise<void> {
  const requestId = newId();
  const onAbort = (): void => void httpCancel(requestId);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await httpDownload({ requestId, url }, dest, (p) => onProgress(p.received));
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(mediaUrl(path));
  if (!response.ok) throw new Error(`Could not read ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The user's own Freesound key, or one bundled into this build. */
const hasSoundKey = async (): Promise<boolean> =>
  (await secretHas(freesoundSecretName).catch(() => false)) || (await secretBuiltin(freesoundSecretName).catch(() => false));

export const tauriLibraryServices: LibraryServices = {
  storage: localStorage,
  async libraryRoot() {
    return joinPath((await appPaths()).appData, "library");
  },
  installer(root): InstallerDeps {
    return {
      root,
      fs: {
        mkdir: fsMkdir,
        exists: fsExists,
        readText: fsReadText,
        writeText: fsWriteText,
        rename: fsRename,
        remove: fsRemove,
        list: async (path) => (await fsList(path)).map((e) => ({ name: e.name, isDir: e.isDir })),
      },
      download,
      readBytes,
      sha256Hex,
    };
  },
  async fetchText(url) {
    const response = await httpFetch({ url, timeoutMs: 20_000 });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return response.bodyText;
  },
  async fetchSoundSearch(url) {
    if (!(await hasSoundKey())) throw new MissingKeyError();
    const response = await httpFetch({ url, timeoutMs: 20_000, auth: { secret: freesoundSecretName, query: "token" } });
    if (response.status === 401 || response.status === 403) throw new Error("Freesound rejected the API key.");
    if (response.status < 200 || response.status >= 300) throw new Error(`Freesound returned HTTP ${response.status}.`);
    return JSON.parse(response.bodyText) as unknown;
  },
  hasSoundKey,
  async importSound(editor, path) {
    return (await addMediaAsset(editor, path))?.id;
  },
  openUrl: (url) => openUrl(url),
  async copyText(text) {
    await navigator.clipboard.writeText(text);
  },
  lutLoader,
};
