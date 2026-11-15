import { open } from "@tauri-apps/plugin-dialog";
import { parseCubeLUT, type CubeLUT } from "../preview/effects/lutLoader";
import { fsReadText } from "./backend";

const cache = new Map<string, CubeLUT | null>();
const pending = new Set<string>();

/** Synchronous lookup for the compositor; a miss starts an async load and calls `onLoaded` when it lands. */
export function lutLoader(onLoaded: () => void): (path: string) => CubeLUT | undefined {
  return (path) => {
    const hit = cache.get(path);
    if (hit !== undefined) return hit ?? undefined;
    if (!pending.has(path)) {
      pending.add(path);
      fsReadText(path)
        .then((text) => cache.set(path, parseCubeLUT(text) ?? null))
        .catch(() => cache.set(path, null))
        .finally(() => {
          pending.delete(path);
          onLoaded();
        });
    }
    return undefined;
  };
}

export async function chooseLutFile(): Promise<string | undefined> {
  const picked = await open({ multiple: false, filters: [{ name: "LUT", extensions: ["cube"] }] });
  return typeof picked === "string" ? picked : undefined;
}
