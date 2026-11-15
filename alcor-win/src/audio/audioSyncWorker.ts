import { seededCorrelateSync, type CorrelationResult, type SeededCorrelateParams } from "./audioSyncCorrelator";

/* Dedicated correlation worker: the exact lag search is seconds of arithmetic, so it stays off the UI thread. */

interface WorkerScope {
  postMessage(message: CorrelationResult | null): void;
  onmessage: ((event: MessageEvent<SeededCorrelateParams>) => void) | null;
}

const scope = self as unknown as WorkerScope;
scope.onmessage = (event) => {
  scope.postMessage(seededCorrelateSync(event.data));
};
