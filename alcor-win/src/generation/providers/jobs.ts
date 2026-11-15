import { ProviderError, sleepSignal, type ErrorCode } from "./common";
import { catalogEntry, provider } from "./registry";
import type { CatalogEntry, GenerationParams, JobHandle, JobState, ModelKind } from "./types";

export type { ErrorCode } from "./common";

export interface JobError {
  code: ErrorCode;
  message: string;
}

export const POLL_INITIAL_MS = 1500;
export const POLL_MAX_MS = 10_000;
const POLL_FACTOR = 1.5;
/** Consecutive transient failures (network / 5xx / rate limit) tolerated before a job is failed. */
const MAX_TRANSIENT = 6;

export const JOB_TIMEOUT_MS: Record<ModelKind, number> = {
  image: 10 * 60_000,
  audio: 15 * 60_000,
  video: 30 * 60_000,
  upscale: 60 * 60_000,
};

/** Normalises anything thrown by an adapter. Messages come from adapters and never contain keys. */
export function normalizeError(e: unknown): JobError {
  if (e instanceof ProviderError) return { code: e.code, message: e.message };
  if (e instanceof Error && e.name === "AbortError") return { code: "cancelled", message: "Cancelled." };
  return { code: "provider_error", message: e instanceof Error ? e.message : "Unknown error." };
}

const failed = (e: JobError): JobState => ({ status: "failed", errorMessage: e.message, code: e.code });

export async function submitJob(entry: CatalogEntry, params: GenerationParams, signal?: AbortSignal): Promise<JobHandle> {
  try {
    return await provider(entry.providerId).submit(entry, params, signal);
  } catch (e) {
    const err = normalizeError(e);
    throw new ProviderError(err.code, err.message);
  }
}

const isTransient = (e: unknown): boolean =>
  e instanceof ProviderError && (e.code === "network" || e.code === "provider_error" || (e.code === "quota" && e.retryAfterMs !== undefined));

/**
 * Polls until the job reaches a terminal state, reporting every state through `onState`. Never rejects: failures,
 * timeouts and cancellation resolve as `{ status: "failed", code }`. Works from a persisted handle alone.
 */
export async function watchJob(handle: JobHandle, onState: (s: JobState) => void, signal?: AbortSignal): Promise<JobState> {
  const kind = catalogEntry(handle.modelId)?.kind ?? "video";
  const deadline = Date.now() + JOB_TIMEOUT_MS[kind];
  let delay = POLL_INITIAL_MS;
  let transient = 0;
  let last: JobState | undefined;
  const finish = (s: JobState): JobState => {
    onState(s);
    return s;
  };
  try {
    const p = provider(handle.providerId);
    for (;;) {
      if (signal?.aborted) return finish(failed({ code: "cancelled", message: "Cancelled." }));
      let wait = delay;
      try {
        const state = await p.status(handle, signal);
        transient = 0;
        if (state.status === "succeeded" || state.status === "failed") return finish(state);
        if (!last || last.status !== state.status || last.progress !== state.progress) onState(state);
        last = state;
      } catch (e) {
        if (!isTransient(e) || ++transient > MAX_TRANSIENT) return finish(failed(normalizeError(e)));
        if (e instanceof ProviderError && e.retryAfterMs !== undefined) wait = Math.max(wait, e.retryAfterMs);
      }
      if (Date.now() + wait > deadline) {
        return finish(failed({ code: "provider_error", message: `Timed out after ${Math.round(JOB_TIMEOUT_MS[kind] / 60_000)} minutes waiting for the provider.` }));
      }
      await sleepSignal(wait, signal);
      delay = Math.min(POLL_MAX_MS, Math.round(delay * POLL_FACTOR));
    }
  } catch (e) {
    return finish(failed(normalizeError(e)));
  }
}

/** Resumes polling a handle persisted by an earlier session (identical to `watchJob`, named for call-site clarity). */
export const resumeJob = watchJob;

/** Best-effort provider-side cancel; never throws. */
export async function cancelJob(handle: JobHandle): Promise<void> {
  try {
    await provider(handle.providerId).cancel?.(handle);
  } catch {
    // Cancellation is advisory; the local watcher is aborted separately.
  }
}
