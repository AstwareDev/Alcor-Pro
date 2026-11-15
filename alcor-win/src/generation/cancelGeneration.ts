// Best-effort cancel of a running generation from its placeholder asset: asks the provider to stop the job; the service's
// watcher then marks the placeholder failed. Placeholders that have no job yet (still preparing) cannot be cancelled.
import type { MediaAsset } from "../model";
import { parseJobHandle } from "./jobRunner";
import { cancelJob } from "./providers/jobs";

export const canCancelGeneration = (asset: MediaAsset): boolean => parseJobHandle(asset.generationInput?.backendJobId) !== undefined;

export async function cancelGeneration(asset: MediaAsset): Promise<void> {
  const handle = parseJobHandle(asset.generationInput?.backendJobId);
  if (handle) await cancelJob(handle);
}
