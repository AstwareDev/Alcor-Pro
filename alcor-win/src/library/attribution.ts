import type { InstalledPack } from "./packInstaller";
import { soundCredit, type SoundLicence } from "./freesound";

/** A sound saved from Freesound (persisted so licence and attribution stay attached to the file). */
export interface SavedSound {
  id: number;
  name: string;
  username: string;
  pageUrl: string;
  licence: SoundLicence;
  durationSeconds: number;
  /** Absolute path of the downloaded preview MP3. */
  path: string;
  /** Media asset created when the sound was added to a project (the project may not contain it any more). */
  assetId?: string;
  savedAt: string;
}

export interface AttributionInput {
  sounds: readonly SavedSound[];
  packs: readonly InstalledPack[];
}

/** Credits for a video description: only items that require attribution; CC0 and built-in content need none. */
export function buildAttributionText(input: AttributionInput): string {
  const lines: string[] = [];
  for (const sound of input.sounds) {
    if (sound.licence.requiresAttribution) lines.push(soundCredit(sound));
  }
  for (const { pack } of input.packs) {
    if (!pack.licence.requiresAttribution) continue;
    const credit = pack.attribution.trim() === "" ? `${pack.name} by ${pack.author}` : pack.attribution.trim();
    lines.push(`${credit} (${pack.sourceUrl}), ${pack.licence.name}${pack.licence.url ? ` - ${pack.licence.url}` : ""}`);
  }
  if (lines.length === 0) return "";
  return ["Credits", ...lines.map((l) => `- ${l}`)].join("\n");
}

/** Sounds whose asset is in the project and packs one of whose files is referenced by a LUT path. */
export function usedAttributionInput(
  all: AttributionInput, projectAssetIds: ReadonlySet<string>, usedPaths: readonly string[],
): AttributionInput {
  const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  const paths = usedPaths.map(norm);
  return {
    sounds: all.sounds.filter((s) => s.assetId !== undefined && projectAssetIds.has(s.assetId)),
    packs: all.packs.filter((p) => {
      const dir = `${norm(p.dir)}/`;
      return paths.some((u) => u.startsWith(dir));
    }),
  };
}
