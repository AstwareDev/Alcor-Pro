import { describe, expect, it } from "vitest";
import { buildAttributionText, usedAttributionInput, type SavedSound } from "./attribution";
import { buildSoundSearchUrl, classifySoundLicence, parseSoundSearch, soundCredit } from "./freesound";

// Shape follows https://freesound.org/docs/api/resources_apiv2.html (search response, `previews` keys, `license` names).
const sample = {
  count: 3,
  next: "https://freesound.org/apiv2/search/?query=rain&page=2",
  previous: null,
  results: [
    {
      id: 1234, name: "Rain on roof", username: "someone", license: "Attribution", duration: 12.5, url: "https://freesound.org/people/someone/sounds/1234/",
      tags: ["rain", "roof"], previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/1/1234-hq.mp3", "preview-lq-mp3": "https://cdn.freesound.org/previews/1/1234-lq.mp3" },
    },
    { id: 55, name: "Thunder", username: "zed", license: "Creative Commons 0", duration: 3, previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/55-hq.mp3" } },
    { id: 77, name: "NC sound", username: "nc", license: "Attribution NonCommercial", duration: 2, previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/0/77-hq.mp3" } },
    { id: 88, name: "No preview", username: "x", license: "Attribution", duration: 2, previews: {} },
  ],
};

describe("buildSoundSearchUrl", () => {
  it("requests only CC0 / CC BY, bounded duration, the needed fields and paging", () => {
    const url = new URL(buildSoundSearchUrl({ query: " rain storm ", page: 2, pageSize: 500, maxDurationSeconds: 30 }));
    expect(url.origin + url.pathname).toBe("https://freesound.org/apiv2/search/");
    expect(url.searchParams.get("query")).toBe("rain storm");
    expect(url.searchParams.get("filter")).toBe('license:("Creative Commons 0" OR "Attribution") duration:[0 TO 30]');
    expect(url.searchParams.get("fields")).toBe("id,name,username,license,duration,previews,url,tags");
    expect(url.searchParams.get("page_size")).toBe("150");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("token")).toBe(false);
  });
});

describe("parseSoundSearch", () => {
  it("keeps usable licences with a hq mp3 preview and counts exclusions", () => {
    const page = parseSoundSearch(sample);
    expect(page.count).toBe(3);
    expect(page.hasNext).toBe(true);
    expect(page.excluded).toBe(1);
    expect(page.results.map((r) => r.id)).toEqual([1234, 55]);
    expect(page.results[0]).toMatchObject({
      name: "Rain on roof", username: "someone", durationSeconds: 12.5, previewUrl: "https://cdn.freesound.org/previews/1/1234-hq.mp3",
      licence: { name: "CC BY 4.0", requiresAttribution: true, allowed: true },
    });
    expect(page.results[1]).toMatchObject({ pageUrl: "https://freesound.org/s/55/", licence: { name: "CC0 1.0", requiresAttribution: false } });
  });

  it("throws on an unexpected payload", () => {
    expect(() => parseSoundSearch({ detail: "Invalid token." })).toThrow();
    expect(() => parseSoundSearch(null)).toThrow();
  });
});

describe("classifySoundLicence", () => {
  it("handles names and license URLs, rejecting non-commercial or unknown", () => {
    expect(classifySoundLicence("Creative Commons 0").allowed).toBe(true);
    expect(classifySoundLicence("http://creativecommons.org/publicdomain/zero/1.0/")).toMatchObject({ allowed: true, requiresAttribution: false });
    expect(classifySoundLicence("https://creativecommons.org/licenses/by/3.0/")).toMatchObject({ name: "CC BY 3.0", allowed: true });
    expect(classifySoundLicence("http://creativecommons.org/licenses/by-nc/3.0/").allowed).toBe(false);
    expect(classifySoundLicence("Sampling+").allowed).toBe(false);
    expect(classifySoundLicence(undefined).allowed).toBe(false);
  });
});

describe("attribution export", () => {
  const sound = (over: Partial<SavedSound> = {}): SavedSound => ({
    id: 1234, name: "Rain on roof", username: "someone", pageUrl: "https://freesound.org/s/1234/",
    licence: classifySoundLicence("Attribution"), durationSeconds: 5, path: "C:/lib/sounds/1234.mp3", savedAt: "2026-01-01", ...over,
  });

  it("credits CC BY sounds and attribution packs but not CC0", () => {
    const text = buildAttributionText({
      sounds: [sound(), sound({ id: 2, name: "Thunder", licence: classifySoundLicence("Creative Commons 0") })],
      packs: [{
        id: "slay", version: "1", installedAt: "", dir: "C:/lib/slay",
        pack: { id: "slay", name: "slay LUTs", kind: "luts", version: "1", description: "", size: 1, attribution: "LUTs by slay (slaycamera.com)", author: "slay", sourceUrl: "https://github.com/slaycamera/luts", licence: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", requiresAttribution: true }, files: [] },
      }],
    });
    expect(text).toBe([
      "Credits",
      `- ${soundCredit(sound())}`,
      "- LUTs by slay (slaycamera.com) (https://github.com/slaycamera/luts), CC BY 4.0 - https://creativecommons.org/licenses/by/4.0/",
    ].join("\n"));
    expect(text).not.toContain("Thunder");
  });

  it("is empty when nothing needs a credit", () => {
    expect(buildAttributionText({ sounds: [sound({ licence: classifySoundLicence("Creative Commons 0") })], packs: [] })).toBe("");
  });

  it("narrows to what the project uses", () => {
    const all = { sounds: [sound({ assetId: "A" }), sound({ id: 3, assetId: "B" })], packs: [] };
    expect(usedAttributionInput(all, new Set(["A"]), []).sounds.map((s) => s.id)).toEqual([1234]);
  });
});
