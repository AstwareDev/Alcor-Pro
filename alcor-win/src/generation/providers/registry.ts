import { createSignal } from "solid-js";
import type { CatalogEntry, Provider, ProviderId } from "./types";

// Adapters register themselves from `./index.ts` (owned by the provider work); the UI only uses the functions below.
const providers = new Map<ProviderId, Provider>();
const [keyed, setKeyed] = createSignal<ReadonlySet<ProviderId>>(new Set());

export function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}

export function allProviders(): Provider[] {
  return [...providers.values()];
}

export function provider(id: ProviderId): Provider {
  const found = providers.get(id);
  if (!found) throw new Error(`Unknown provider: ${id}`);
  return found;
}

/** Reactive: providers whose API key is stored. Refreshed by Settings and at startup. */
export function providersWithKeys(): ReadonlySet<ProviderId> {
  return keyed();
}

export function setProvidersWithKeys(ids: Iterable<ProviderId>): void {
  setKeyed(new Set(ids));
}

/** Every model, including ones whose provider has no key (the UI shows those as "Add API key"). */
export function fullCatalog(): CatalogEntry[] {
  return allProviders().flatMap((p) => [...p.catalog]);
}

/** Reactive: models usable right now. */
export function availableCatalog(kind?: CatalogEntry["kind"]): CatalogEntry[] {
  const ready = providersWithKeys();
  return fullCatalog().filter((m) => ready.has(m.providerId) && (!kind || m.kind === kind));
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return fullCatalog().find((m) => m.id === id);
}
