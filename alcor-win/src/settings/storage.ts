/** The subset of `Storage` settings need (localStorage in the app, a map in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

export function defaultStorage(): KeyValueStorage {
  return globalThis.localStorage ?? memoryStorage();
}

const cacheClearedListeners = new Set<() => void>();

/** Features holding in-memory state derived from cache files reset it here. Returns an unsubscribe function. */
export function onCacheCleared(listener: () => void): () => void {
  cacheClearedListeners.add(listener);
  return () => cacheClearedListeners.delete(listener);
}

export function notifyCacheCleared(): void {
  for (const listener of cacheClearedListeners) listener();
}
