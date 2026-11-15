import type { Editor } from "../editor/editor";
import type { CubeLUT } from "../preview/effects/lutLoader";
import type { InstallerDeps } from "./packInstaller";

/** Everything the Library needs from the outside world; the dev page substitutes in-memory fakes. */
export interface LibraryServices {
  storage: Pick<Storage, "getItem" | "setItem">;
  /** `<appData>/library` */
  libraryRoot(): Promise<string>;
  installer(root: string): InstallerDeps;
  /** Plain GET of a public text document (catalogs, preset files). */
  fetchText(url: string): Promise<string>;
  /** Keyed Freesound GET (the Rust side adds the stored token); rejects with `MissingKeyError` when none is stored. */
  fetchSoundSearch(url: string): Promise<unknown>;
  hasSoundKey(): Promise<boolean>;
  /** Imports a downloaded file into the project; resolves with the new asset id. */
  importSound(editor: Editor, path: string): Promise<string | undefined>;
  openUrl(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  lutLoader(onLoaded: () => void): (path: string) => CubeLUT | undefined;
}

export class MissingKeyError extends Error {
  constructor() {
    super("Add a Freesound API key in Settings to search sounds.");
    this.name = "MissingKeyError";
  }
}
