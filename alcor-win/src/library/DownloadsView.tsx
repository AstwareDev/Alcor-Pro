import ExternalLink from "lucide-solid/icons/external-link";
import X from "lucide-solid/icons/x";
import { createSignal, For, onMount, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { CapsuleButton } from "../ui/CapsuleButton";
import { SegmentedControl } from "../ui/SegmentedControl";
import { defaultCatalogUrl, formatBytes, type CatalogPack } from "./catalog";
import type { LibraryController } from "./libraryController";

function PackRow(props: { pack: CatalogPack; catalogUrl: string; controller: LibraryController }) {
  const c = props.controller;
  const state = () => c.stateOf(props.pack);
  const progress = () => c.installs().get(props.pack.id);
  const installedVersion = () => c.installed().find((p) => p.id === props.pack.id)?.version;
  const licence = () => props.pack.licence;
  return (
    <div class="lib-pack">
      <div class="lib-pack-head">
        <span class="lib-pack-name">{props.pack.name}</span>
        <span class="lib-pack-kind">{props.pack.kind}</span>
        <span class="lib-pack-size">{formatBytes(props.pack.size)}</span>
      </div>
      <Show when={props.pack.description}><div class="lib-pack-desc">{props.pack.description}</div></Show>
      <div class="lib-pack-meta">
        v{props.pack.version} · by {props.pack.author} ·{" "}
        <a class="lib-link" href={licence().url ?? props.pack.sourceUrl} onClick={(e) => { e.preventDefault(); void c.openUrl(licence().url ?? props.pack.sourceUrl); }}>
          {licence().name}
        </a>
        <Show when={licence().requiresAttribution}> · attribution required</Show>
        {" "}
        <button type="button" class="lib-link" aria-label={`Open the source of ${props.pack.name}`} onClick={() => void c.openUrl(props.pack.sourceUrl)}>
          source <ExternalLink size={10} />
        </button>
      </div>
      <Show when={progress()}>
        {(p) => (
          <Show
            when={p().error === undefined}
            fallback={<div class="lib-note error" role="alert">{p().error}</div>}
          >
            <div class="lib-progress" role="progressbar" aria-valuenow={Math.round(p().fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${Math.round(p().fraction * 100)}%` }} />
            </div>
          </Show>
        )}
      </Show>
      <div class="lib-pack-actions">
        <Show when={progress() && progress()?.error === undefined}>
          <CapsuleButton onClick={() => c.cancelInstall(props.pack.id)}><X size={11} /> Cancel</CapsuleButton>
        </Show>
        <Show when={!progress() || progress()?.error !== undefined}>
          <Show when={state() === "notInstalled"}>
            <CapsuleButton variant="prominent" onClick={() => void c.install(props.pack, props.catalogUrl)}>Download</CapsuleButton>
          </Show>
          <Show when={state() === "updateAvailable"}>
            <CapsuleButton variant="prominent" onClick={() => void c.install(props.pack, props.catalogUrl)}>Update from v{installedVersion()}</CapsuleButton>
          </Show>
          <Show when={state() !== "notInstalled"}>
            <span class="lib-installed">Installed</span>
            <CapsuleButton onClick={() => void c.uninstall(props.pack.id)}>Remove</CapsuleButton>
          </Show>
        </Show>
      </div>
    </div>
  );
}

/** Pack catalogs (default + custom), installed state, the Library settings and the Attribution export. */
export function DownloadsView(props: { editor: Editor; controller: LibraryController }) {
  const c = props.controller;
  const [newUrl, setNewUrl] = createSignal("");
  const [urlError, setUrlError] = createSignal<string | undefined>();
  const [scope, setScope] = createSignal<"project" | "all">("project");
  const [copied, setCopied] = createSignal(false);
  onMount(() => { if (c.catalogs().length === 0) void c.refreshCatalogs(); });
  const credits = (): string => c.attributionText(props.editor, scope());

  return (
    <div class="lib-downloads">
      <For each={c.catalogs()}>
        {(status) => (
          <section class="lib-section">
            <div class="lib-section-head">
              <span class="lib-section-title" title={status.url}>{status.url === defaultCatalogUrl ? "Alcor Pro library" : status.url}</span>
              <Show when={status.state !== "loading"}>
                <button type="button" class="lib-link" onClick={() => void c.refreshCatalogs()}>Refresh</button>
              </Show>
            </div>
            <Show when={status.state === "loading"}><div class="lib-empty">Loading catalog...</div></Show>
            <Show when={status.state === "error"}>
              <div class="lib-note">
                Catalog unavailable{status.state === "error" ? ` (${status.message})` : ""}. The built-in presets keep working; check your connection or add another catalog below.
              </div>
            </Show>
            <Show when={status.state === "ready" ? status : undefined}>
              {(ready) => (
                <>
                  <For each={ready().catalog.packs} fallback={<div class="lib-empty">This catalog has no packs.</div>}>
                    {(pack) => <PackRow pack={pack} catalogUrl={ready().url} controller={c} />}
                  </For>
                  <For each={ready().catalog.warnings}>{(w) => <div class="lib-warning">{w}</div>}</For>
                </>
              )}
            </Show>
          </section>
        )}
      </For>

      <Show when={c.installed().length > 0}>
        <section class="lib-section">
          <div class="lib-section-head"><span class="lib-section-title">Installed</span></div>
          <For each={c.installed()}>
            {(p) => (
              <div class="lib-installed-row">
                <span>{p.pack.name} <span class="lib-pack-kind">v{p.version}</span></span>
                <button type="button" class="lib-link" onClick={() => void c.uninstall(p.id)}>Uninstall</button>
              </div>
            )}
          </For>
          <For each={c.warnings()}>{(w) => <div class="lib-warning">{w}</div>}</For>
        </section>
      </Show>

      <section class="lib-section">
        <div class="lib-section-head"><span class="lib-section-title">Library settings</span></div>
        <div class="lib-pack-desc">Add your own catalog (an index.json in the same format) to download community or private packs.</div>
        <For each={c.customCatalogs()}>
          {(url) => (
            <div class="lib-installed-row">
              <span class="lib-url" title={url}>{url}</span>
              <button type="button" class="lib-link" onClick={() => c.removeCatalogUrl(url)}>Remove</button>
            </div>
          )}
        </For>
        <div class="lib-sound-search">
          <input
            class="lib-input"
            placeholder="https://example.com/library/index.json"
            aria-label="Catalog URL"
            value={newUrl()}
            onInput={(e) => { setNewUrl(e.currentTarget.value); setUrlError(undefined); }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const error = c.addCatalogUrl(newUrl());
              setUrlError(error);
              if (!error) setNewUrl("");
            }}
          />
          <CapsuleButton
            disabled={newUrl().trim() === ""}
            onClick={() => {
              const error = c.addCatalogUrl(newUrl());
              setUrlError(error);
              if (!error) setNewUrl("");
            }}
          >
            Add
          </CapsuleButton>
        </div>
        <Show when={urlError()}>{(m) => <div class="lib-note error" role="alert">{m()}</div>}</Show>
      </section>

      <section class="lib-section">
        <div class="lib-section-head"><span class="lib-section-title">Attribution</span></div>
        <div class="lib-pack-desc">Paste these credits into your video description. Items under CC0 and the built-in presets need none.</div>
        <SegmentedControl
          options={[{ value: "project", label: "Used in project" }, { value: "all", label: "All downloads" }] as const}
          value={scope()}
          onChange={setScope}
          label="Attribution scope"
          small
        />
        <textarea class="lib-credits" readOnly rows={5} aria-label="Attribution text" value={credits() === "" ? "No credits needed for the items in scope." : credits()} />
        <CapsuleButton
          disabled={credits() === ""}
          onClick={() => void c.copyText(credits()).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
        >
          {copied() ? "Copied" : "Copy credits"}
        </CapsuleButton>
      </section>
    </div>
  );
}
