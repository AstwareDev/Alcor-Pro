import { batch, createSignal } from "solid-js";
import type { Editor } from "../editor/editor";
import { builtinPresets } from "./builtin";
import { buildAttributionText, usedAttributionInput, type SavedSound } from "./attribution";
import { defaultCatalogUrl, packState, parseCatalog, type Catalog, type CatalogPack, type PackState } from "./catalog";
import {
  buildSoundSearchUrl, freesoundSecretName, parseSoundSearch, soundFileName, type SoundResult, type SoundSearchPage,
} from "./freesound";
import { MissingKeyError, type LibraryServices } from "./libraryServices";
import {
  installPack, joinPath, listInstalledPacks, resolveInstalledResource, uninstallPack, InstallCancelled, type InstalledPack,
} from "./packInstaller";
import { decodePresetDocument, type Preset } from "./presetFormat";

export { MissingKeyError, freesoundSecretName };

/** A preset together with where it came from (drives the licence badge and the Downloads tab). */
export interface LibraryItem {
  preset: Preset;
  pack?: InstalledPack;
}

export type CatalogStatus =
  | { url: string; state: "loading" }
  | { url: string; state: "ready"; catalog: Catalog }
  | { url: string; state: "error"; message: string };

export interface InstallStatus {
  fraction: number;
  error?: string;
}

const favouritesKey = "library.favourites";
const catalogsKey = "library.catalogs";
const soundsKey = "library.sounds";

function readJson<T>(services: LibraryServices, key: string, fallback: T, check: (v: unknown) => v is T): T {
  try {
    const raw = services.storage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return check(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isSoundArray = (v: unknown): v is SavedSound[] =>
  Array.isArray(v) && v.every((s) => typeof s === "object" && s !== null && typeof (s as SavedSound).id === "number" && typeof (s as SavedSound).path === "string");

export function createLibraryController(services: LibraryServices) {
  const [favourites, setFavourites] = createSignal<ReadonlySet<string>>(new Set(readJson(services, favouritesKey, [], isStringArray)));
  const [customCatalogs, setCustomCatalogs] = createSignal<string[]>(readJson(services, catalogsKey, [], isStringArray));
  const [savedSounds, setSavedSounds] = createSignal<SavedSound[]>(readJson(services, soundsKey, [], isSoundArray));
  const [catalogs, setCatalogs] = createSignal<CatalogStatus[]>([]);
  const [installed, setInstalled] = createSignal<InstalledPack[]>([]);
  const [packItems, setPackItems] = createSignal<LibraryItem[]>([]);
  const [warnings, setWarnings] = createSignal<string[]>([]);
  const [installs, setInstalls] = createSignal<ReadonlyMap<string, InstallStatus>>(new Map());
  const [lutVersion, setLutVersion] = createSignal(0);
  const aborts = new Map<string, AbortController>();
  const loadLut = services.lutLoader(() => setLutVersion((v) => v + 1));

  const catalogUrls = (): string[] => [defaultCatalogUrl, ...customCatalogs()];

  const setInstall = (id: string, status: InstallStatus | undefined): void => {
    const next = new Map(installs());
    if (status) next.set(id, status);
    else next.delete(id);
    setInstalls(next);
  };

  const deps = async () => services.installer(await services.libraryRoot());

  /** Re-reads installed packs and decodes their preset files. */
  async function reloadInstalled(): Promise<void> {
    const list = await listInstalledPacks(await deps());
    const items: LibraryItem[] = [];
    const warn: string[] = [];
    const known = new Set(builtinPresets.map((p) => p.id));
    for (const pack of list) {
      for (const file of pack.pack.files) {
        if (file.path !== "presets.json") continue;
        try {
          const doc = decodePresetDocument(JSON.parse(await services.installer(pack.dir).fs.readText(joinPath(pack.dir, file.path))) as unknown);
          warn.push(...doc.warnings.map((w) => `${pack.pack.name}: ${w}`));
          for (const preset of doc.presets) {
            if (known.has(preset.id)) continue;
            known.add(preset.id);
            items.push({ preset, pack });
          }
        } catch (e) {
          warn.push(`${pack.pack.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    batch(() => {
      setInstalled(list);
      setPackItems(items);
      setWarnings(warn);
    });
  }

  async function refreshCatalogs(): Promise<void> {
    const urls = catalogUrls();
    setCatalogs(urls.map((url) => ({ url, state: "loading" as const })));
    await Promise.all(urls.map(async (url, i) => {
      let status: CatalogStatus;
      try {
        status = { url, state: "ready", catalog: parseCatalog(JSON.parse(await services.fetchText(url)) as unknown, url) };
      } catch (e) {
        status = { url, state: "error", message: e instanceof Error ? e.message : String(e) };
      }
      setCatalogs((all) => all.map((s, j) => (j === i ? status : s)));
    }));
  }

  async function install(pack: CatalogPack, catalogUrl: string): Promise<void> {
    const controller = new AbortController();
    aborts.set(pack.id, controller);
    setInstall(pack.id, { fraction: 0 });
    try {
      await installPack(await deps(), pack, catalogUrl, {
        signal: controller.signal,
        onProgress: (p) => setInstall(pack.id, { fraction: p.totalBytes > 0 ? Math.min(1, p.receivedBytes / p.totalBytes) : 0 }),
      });
      setInstall(pack.id, undefined);
      await reloadInstalled();
    } catch (e) {
      setInstall(pack.id, e instanceof InstallCancelled ? undefined : { fraction: 0, error: e instanceof Error ? e.message : String(e) });
    } finally {
      aborts.delete(pack.id);
    }
  }

  async function uninstall(packId: string): Promise<void> {
    await uninstallPack(await deps(), packId);
    await reloadInstalled();
  }

  const persist = (key: string, value: unknown): void => {
    try {
      services.storage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or unavailable: the in-memory state still works for this session.
    }
  };

  function toggleFavourite(id: string): void {
    const next = new Set(favourites());
    if (!next.delete(id)) next.add(id);
    setFavourites(next);
    persist(favouritesKey, [...next]);
  }

  function addCatalogUrl(raw: string): string | undefined {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      return "Enter a full URL, for example https://example.com/index.json";
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "Catalog URLs must use https.";
    if (catalogUrls().includes(url.toString())) return "That catalog is already added.";
    const next = [...customCatalogs(), url.toString()];
    setCustomCatalogs(next);
    persist(catalogsKey, next);
    void refreshCatalogs();
    return undefined;
  }

  function removeCatalogUrl(url: string): void {
    const next = customCatalogs().filter((u) => u !== url);
    setCustomCatalogs(next);
    persist(catalogsKey, next);
    void refreshCatalogs();
  }

  async function searchSounds(query: string, page: number): Promise<SoundSearchPage> {
    return parseSoundSearch(await services.fetchSoundSearch(buildSoundSearchUrl({ query, page })));
  }

  /** Downloads the preview MP3 (once), records licence + attribution, and imports it into the project. */
  async function addSound(editor: Editor, sound: SoundResult, onProgress?: (fraction: number) => void): Promise<SavedSound> {
    const existing = savedSounds().find((s) => s.id === sound.id);
    const root = joinPath(await services.libraryRoot(), "sounds");
    const path = existing?.path ?? joinPath(root, soundFileName(sound.id));
    if (!existing) {
      const d = services.installer(root);
      await d.fs.mkdir(root);
      await d.download(sound.previewUrl, path, (received) => onProgress?.(received), new AbortController().signal);
    }
    const assetId = await services.importSound(editor, path);
    const saved: SavedSound = {
      id: sound.id, name: sound.name, username: sound.username, pageUrl: sound.pageUrl, licence: sound.licence,
      durationSeconds: sound.durationSeconds, path, savedAt: existing?.savedAt ?? new Date().toISOString(),
      ...(assetId !== undefined ? { assetId } : existing?.assetId !== undefined ? { assetId: existing.assetId } : {}),
    };
    const next = [saved, ...savedSounds().filter((s) => s.id !== sound.id)];
    setSavedSounds(next);
    persist(soundsKey, next);
    return saved;
  }

  function removeSavedSound(id: number): void {
    const next = savedSounds().filter((s) => s.id !== id);
    setSavedSounds(next);
    persist(soundsKey, next);
  }

  /** Credits for what the project uses, or for everything downloaded when `scope` is "all". */
  function attributionText(editor: Editor, scope: "project" | "all"): string {
    const all = { sounds: savedSounds(), packs: installed() };
    if (scope === "all") return buildAttributionText(all);
    const assetIds = new Set(editor.mediaAssets.map((a) => a.id));
    const paths = editor.doc.timelines.flatMap((t) => t.tracks.flatMap((tr) => tr.clips.flatMap((c) =>
      (c.effects ?? []).flatMap((e) => (e.type === "color.lut" && e.params["path"]?.string ? [e.params["path"].string] : [])))));
    return buildAttributionText(usedAttributionInput(all, assetIds, paths));
  }

  return {
    favourites, customCatalogs, savedSounds, catalogs, installed, packItems, warnings, installs, lutVersion, loadLut,
    catalogUrls, reloadInstalled, refreshCatalogs, install, uninstall, toggleFavourite, addCatalogUrl, removeCatalogUrl,
    searchSounds, addSound, removeSavedSound, attributionText,
    cancelInstall: (id: string): void => aborts.get(id)?.abort(),
    resolveResource: (resource: string): string | undefined => resolveInstalledResource(installed(), resource),
    stateOf: (pack: CatalogPack): PackState => packState(installed().find((p) => p.id === pack.id)?.version, pack),
    hasSoundKey: services.hasSoundKey,
    openUrl: services.openUrl,
    copyText: services.copyText,
  };
}

export type LibraryController = ReturnType<typeof createLibraryController>;
