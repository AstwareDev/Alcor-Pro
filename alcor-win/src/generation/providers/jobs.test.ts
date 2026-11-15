import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../platform/backend", () => ({ httpFetch: vi.fn(), httpCancel: vi.fn() }));

import { ProviderError, errorFromStatus, retryAfterMs } from "./common";
import { POLL_INITIAL_MS, POLL_MAX_MS, normalizeError, resumeJob, submitJob, watchJob } from "./jobs";
import { registerProvider } from "./registry";
import type { CatalogEntry, JobHandle, JobState, Provider } from "./types";

const handle: JobHandle = { providerId: "fal", modelId: "fal/test", ref: "{}" };

function fake(statuses: (() => Promise<JobState>)[]): { provider: Provider; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  const provider: Provider = {
    id: "fal", displayName: "fake", secretName: "fal", keyUrl: "", catalog: [],
    checkKey: async () => ({ ok: true }),
    submit: async () => handle,
    status: async () => {
      calls.push(Date.now());
      const next = statuses[Math.min(i++, statuses.length - 1)];
      if (!next) throw new Error("no status");
      return next();
    },
  };
  return { provider, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("watchJob", () => {
  it("backs off 1.5s -> 10s and finishes on success", async () => {
    const { provider, calls } = fake([
      ...Array.from({ length: 6 }, () => async (): Promise<JobState> => ({ status: "running" })),
      async () => ({ status: "succeeded", outputs: [{ url: "https://x/y.mp4" }] }),
    ]);
    registerProvider(provider);
    const seen: string[] = [];
    const p = watchJob(handle, (s) => seen.push(s.status));
    await vi.advanceTimersByTimeAsync(120_000);
    const final = await p;
    expect(final).toEqual({ status: "succeeded", outputs: [{ url: "https://x/y.mp4" }] });
    const gaps = calls.slice(1).map((t, i) => t - (calls[i] ?? 0));
    expect(gaps[0]).toBe(POLL_INITIAL_MS);
    expect(gaps[1]).toBe(2250);
    expect(Math.max(...gaps)).toBe(POLL_MAX_MS);
    expect(seen).toEqual(["running", "succeeded"]);
  });

  it("resumes from a persisted handle after a restart", async () => {
    const persisted: JobHandle = JSON.parse(JSON.stringify(handle)) as JobHandle;
    registerProvider(fake([async () => ({ status: "succeeded", outputs: [{ path: "C:\\o.mp3" }] })]).provider);
    const final = await resumeJob(persisted, () => undefined);
    expect(final).toEqual({ status: "succeeded", outputs: [{ path: "C:\\o.mp3" }] });
  });

  it("honours Retry-After on rate limits and keeps going", async () => {
    let n = 0;
    const { provider, calls } = fake([
      async () => { if (n++ === 0) throw new ProviderError("quota", "slow down", 7000); return { status: "succeeded", outputs: [{ url: "u" }] }; },
      async () => ({ status: "succeeded", outputs: [{ url: "u" }] }),
    ]);
    registerProvider(provider);
    const p = watchJob(handle, () => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await p).status).toBe("succeeded");
    expect((calls[1] ?? 0) - (calls[0] ?? 0)).toBe(7000);
  });

  it("fails fast on auth errors with a normalised code", async () => {
    registerProvider(fake([async () => { throw errorFromStatus("fal", 401, "nope"); }]).provider);
    const final = await watchJob(handle, () => undefined);
    expect(final).toMatchObject({ status: "failed", code: "auth" });
  });

  it("gives up after repeated network failures", async () => {
    registerProvider(fake([async () => { throw new ProviderError("network", "offline"); }]).provider);
    const p = watchJob(handle, () => undefined);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(await p).toMatchObject({ status: "failed", code: "network" });
  });

  it("times out per kind", async () => {
    registerProvider(fake([async () => ({ status: "running" })]).provider);
    const p = watchJob(handle, () => undefined);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    const final = await p;
    expect(final).toMatchObject({ status: "failed", code: "provider_error" });
    expect(final.status === "failed" && final.errorMessage).toMatch(/Timed out/);
  });

  it("resolves as cancelled when aborted", async () => {
    registerProvider(fake([async () => ({ status: "running" })]).provider);
    const ctl = new AbortController();
    const p = watchJob(handle, () => undefined, ctl.signal);
    await vi.advanceTimersByTimeAsync(2000);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toMatchObject({ status: "failed", code: "cancelled" });
  });
});

describe("error normalisation", () => {
  it("maps HTTP statuses to codes", () => {
    expect(errorFromStatus("x", 401, "").code).toBe("auth");
    expect(errorFromStatus("x", 403, "").code).toBe("auth");
    expect(errorFromStatus("x", 402, "").code).toBe("quota");
    expect(errorFromStatus("x", 429, "", [["Retry-After", "3"]]).retryAfterMs).toBe(3000);
    expect(errorFromStatus("x", 422, "bad").code).toBe("invalid_input");
    expect(errorFromStatus("x", 502, "").code).toBe("provider_error");
  });

  it("parses Retry-After only when numeric", () => {
    expect(retryAfterMs([["retry-after", "2"]])).toBe(2000);
    expect(retryAfterMs([["retry-after", "Wed, 21 Oct"]])).toBeUndefined();
  });

  it("normalises unknown errors", () => {
    expect(normalizeError(new Error("boom"))).toEqual({ code: "provider_error", message: "boom" });
  });

  it("submitJob rethrows normalised errors", async () => {
    const { provider } = fake([]);
    provider.submit = async () => { throw new ProviderError("no_key", "No fal API key is set."); };
    registerProvider(provider);
    const entry = { providerId: "fal" } as CatalogEntry;
    await expect(submitJob(entry, { kind: "audio", prompt: "", instrumental: false })).rejects.toMatchObject({ code: "no_key" });
  });
});
