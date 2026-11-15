// Replaces GenerationBackend.submit / subscribe. The default runner drives the provider contract directly
// (`Provider.submit` + polling `Provider.status`); the integrator can swap in `providers/jobs.ts` with `setJobRunner`.
import { abortError, isAbortError } from "../media/concurrency";
import { catalogEntry, provider } from "./providers/registry";
import type { CatalogEntry, GenerationParams, JobHandle, JobState } from "./providers/types";

export interface JobRunner {
  submit(model: CatalogEntry, params: GenerationParams, signal?: AbortSignal): Promise<JobHandle>;
  /** Reports every state change; resolves with the terminal state. Rejects when the provider stays unreachable. */
  watch(handle: JobHandle, onState: (state: JobState) => void, signal?: AbortSignal): Promise<JobState>;
}

export function serializeJobHandle(handle: JobHandle): string {
  return JSON.stringify(handle);
}

export function parseJobHandle(text: string | undefined): JobHandle | undefined {
  if (!text) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o["providerId"] !== "string" || typeof o["modelId"] !== "string" || typeof o["ref"] !== "string") return undefined;
    return { providerId: o["providerId"] as JobHandle["providerId"], modelId: o["modelId"], ref: o["ref"] };
  } catch {
    return undefined;
  }
}

const pollStartMs = 1500;
const pollMaxMs = 8000;
const maxConsecutiveStatusErrors = 5;

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

export function makePollingJobRunner(pollDelay: (attempt: number) => number = (n) => Math.min(pollMaxMs, pollStartMs * 1.5 ** n)): JobRunner {
  return {
    submit: (model, params, signal) => provider(model.providerId).submit(model, params, signal),
    async watch(handle, onState, signal) {
      const p = provider(handle.providerId);
      let attempt = 0;
      let errors = 0;
      for (;;) {
        let state: JobState;
        try {
          state = await p.status(handle, signal);
          errors = 0;
        } catch (e) {
          if (isAbortError(e)) throw e;
          errors += 1;
          if (errors >= maxConsecutiveStatusErrors) throw e;
          await sleep(pollDelay(attempt++), signal);
          continue;
        }
        onState(state);
        if (state.status === "succeeded" || state.status === "failed") return state;
        await sleep(pollDelay(attempt++), signal);
      }
    },
  };
}

let runner: JobRunner = makePollingJobRunner();

export function setJobRunner(next: JobRunner): void {
  runner = next;
}

export function getJobRunner(): JobRunner {
  return runner;
}

/** Display-only model lookup used when resuming (the handle names the model). */
export function entryForHandle(handle: JobHandle): CatalogEntry | undefined {
  return catalogEntry(handle.modelId);
}
