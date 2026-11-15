import { secretDelete, secretListPresent, secretSet } from "../platform/backend";
import "../generation/providers";
import { allProviders, setProvidersWithKeys } from "../generation/providers/registry";
import type { Provider } from "../generation/providers/types";

/** Fills `providersWithKeys()` from the credential store. Call once at startup and after any key change. */
export async function refreshProviderKeys(): Promise<void> {
  const providers = allProviders();
  const present = new Set(await secretListPresent(providers.map((p) => p.secretName)));
  setProvidersWithKeys(providers.filter((p) => present.has(p.secretName)).map((p) => p.id));
}

/** Writes through to the credential store; the value is never read back into the webview. */
export async function saveProviderKey(provider: Provider, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("Enter an API key.");
  await secretSet(provider.secretName, trimmed);
  await refreshProviderKeys();
}

export async function removeProviderKey(provider: Provider): Promise<void> {
  await secretDelete(provider.secretName);
  await refreshProviderKeys();
}

export async function testProviderKey(provider: Provider): Promise<{ ok: true } | { ok: false; message: string }> {
  return provider.checkKey();
}
