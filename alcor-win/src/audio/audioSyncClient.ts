import { seededCorrelate, type CorrelationResult, type SeededCorrelateParams } from "./audioSyncCorrelator";

/**
 * `AudioSyncCorrelator.seededCorrelate` on a worker thread. Aborting terminates the worker and resolves null
 * (the Swift correlator returns nil when cancelled); callers re-check the signal afterwards.
 */
export function seededCorrelateInWorker(params: SeededCorrelateParams, signal?: AbortSignal): Promise<CorrelationResult | null> {
  if (typeof Worker === "undefined") return seededCorrelate(params, signal);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const worker = new Worker(new URL("./audioSyncWorker.ts", import.meta.url), { type: "module" });
    const finish = (fn: () => void): void => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      fn();
    };
    const onAbort = (): void => finish(() => resolve(null));
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<CorrelationResult | null>) => finish(() => resolve(event.data));
    worker.onerror = (event) => finish(() => reject(new Error(event.message || "Audio sync worker failed.")));
    worker.postMessage(params);
  });
}
