// Freesound search (https://freesound.org/docs/api/resources_apiv2.html#search-resources).
// Auth: API token in the `token` query parameter or `Authorization: Token <key>` (https://freesound.org/docs/api/authentication.html);
// the Rust side injects the stored key (secret name "freesound", host freesound.org).
// `/sounds/<id>/download/` requires OAuth2, so this module only uses the `previews` URLs, which the token already
// grants: `preview-hq-mp3` (~128 kbps MP3), https://freesound.org/docs/api/resources_apiv2.html#sound-instance
// Filtering: `filter=name:value`, multi-word values in double quotes, `OR` groups in parentheses and numeric ranges
// `duration:[0 TO 30]` (https://freesound.org/docs/api/resources_apiv2.html#search-resources).

export const freesoundSecretName = "freesound";
export const freesoundSearchUrl = "https://freesound.org/apiv2/search/";
export const freesoundKeyUrl = "https://freesound.org/apiv2/apply";

export interface SoundLicence {
  /** Display name, e.g. "CC0 1.0" or "CC BY 4.0". */
  name: string;
  url: string;
  requiresAttribution: boolean;
  /** False for NonCommercial / Sampling+ / unknown licences: these are never offered. */
  allowed: boolean;
}

export interface SoundResult {
  id: number;
  name: string;
  username: string;
  licence: SoundLicence;
  durationSeconds: number;
  previewUrl: string;
  pageUrl: string;
  tags: string[];
}

export interface SoundSearchPage {
  count: number;
  hasNext: boolean;
  results: SoundResult[];
  /** Results dropped because their licence is not usable in videos. */
  excluded: number;
}

export interface SoundSearchOptions {
  query: string;
  page?: number;
  pageSize?: number;
  /** Longest sound in seconds; default 60. */
  maxDurationSeconds?: number;
}

const resultFields = "id,name,username,license,duration,previews,url,tags";

/** Search URL without the token (the HTTP layer appends it). Only CC0 and CC BY sounds are requested. */
export function buildSoundSearchUrl(o: SoundSearchOptions): string {
  const max = o.maxDurationSeconds ?? 60;
  const filter = `license:("Creative Commons 0" OR "Attribution") duration:[0 TO ${max}]`;
  const params = new URLSearchParams({
    query: o.query.trim(),
    filter,
    fields: resultFields,
    page_size: String(Math.min(150, Math.max(1, o.pageSize ?? 24))),
    page: String(Math.max(1, o.page ?? 1)),
    sort: "score",
  });
  return `${freesoundSearchUrl}?${params.toString()}`;
}

/** Maps Freesound's license value (documented as a name; license URLs are accepted too) to a usable licence. */
export function classifySoundLicence(raw: unknown): SoundLicence {
  const text = typeof raw === "string" ? raw.trim() : "";
  const lower = text.toLowerCase();
  const url = (fallback: string): string => (/^https?:\/\//.test(text) ? text : fallback);
  if (lower === "creative commons 0" || lower.includes("publicdomain/zero") || lower === "cc0") {
    return { name: "CC0 1.0", url: url("https://creativecommons.org/publicdomain/zero/1.0/"), requiresAttribution: false, allowed: true };
  }
  if (lower.includes("/by-nc") || lower.includes("noncommercial") || lower.includes("sampling")) {
    return { name: text || "Non-commercial", url: url("https://creativecommons.org/licenses/by-nc/4.0/"), requiresAttribution: true, allowed: false };
  }
  if (lower === "attribution" || /creativecommons\.org\/licenses\/by\/[\d.]+/.test(lower)) {
    const version = /by\/([\d.]+)/.exec(lower)?.[1] ?? "4.0";
    return { name: `CC BY ${version}`, url: url(`https://creativecommons.org/licenses/by/${version}/`), requiresAttribution: true, allowed: true };
  }
  return { name: text || "Unknown", url: url(""), requiresAttribution: true, allowed: false };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Parses a search response. Entries without an id, a name or a high-quality MP3 preview are skipped. */
export function parseSoundSearch(json: unknown): SoundSearchPage {
  const root = asRecord(json);
  if (!root || !Array.isArray(root["results"])) throw new Error("Unexpected response from Freesound.");
  const results: SoundResult[] = [];
  let excluded = 0;
  for (const item of root["results"]) {
    const o = asRecord(item);
    const previews = asRecord(o?.["previews"]);
    const previewUrl = previews?.["preview-hq-mp3"];
    if (!o || typeof o["id"] !== "number" || typeof o["name"] !== "string" || typeof previewUrl !== "string") continue;
    const licence = classifySoundLicence(o["license"]);
    if (!licence.allowed) {
      excluded += 1;
      continue;
    }
    results.push({
      id: o["id"],
      name: o["name"],
      username: typeof o["username"] === "string" ? o["username"] : "unknown",
      licence,
      durationSeconds: typeof o["duration"] === "number" ? o["duration"] : 0,
      previewUrl,
      pageUrl: typeof o["url"] === "string" ? o["url"] : `https://freesound.org/s/${o["id"]}/`,
      tags: Array.isArray(o["tags"]) ? o["tags"].filter((t): t is string => typeof t === "string") : [],
    });
  }
  return {
    count: typeof root["count"] === "number" ? root["count"] : results.length,
    hasNext: typeof root["next"] === "string",
    results,
    excluded,
  };
}

/** Credit line for the Attribution export. */
export function soundCredit(s: Pick<SoundResult, "name" | "username" | "pageUrl" | "licence">): string {
  const credit = `"${s.name}" by ${s.username} (${s.pageUrl}) via Freesound, ${s.licence.name}`;
  return s.licence.url ? `${credit} - ${s.licence.url}` : credit;
}

export function soundFileName(id: number): string {
  return `freesound-${id}.mp3`;
}
