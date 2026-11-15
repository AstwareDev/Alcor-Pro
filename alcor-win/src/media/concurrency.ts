export function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** Lets the event loop (input, paint) run between chunks of work. */
export function yieldToUi(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sched?.yield) return sched.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Port of AsyncSemaphore: FIFO waiters, cancellable while queued. */
export class AsyncSemaphore {
  private available: number;
  private readonly waiters: { resolve: () => void; reject: (e: unknown) => void; cleanup: () => void }[] = [];

  constructor(value: number) {
    this.available = value;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(abortError());
      };
      const waiter = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  signal(): void {
    const next = this.waiters.shift();
    if (next) {
      next.cleanup();
      next.resolve();
    } else {
      this.available += 1;
    }
  }

  /** Runs `work` holding one permit; rejects with AbortError if cancelled while queued. */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.wait(signal);
    try {
      return await work();
    } finally {
      this.signal();
    }
  }
}

interface Flight<V> {
  promise: Promise<V>;
  controller: AbortController;
  waiters: number;
}

/**
 * De-duplicates concurrent identical requests. The shared work is aborted only when every
 * caller has aborted; an aborted caller rejects immediately without affecting the others.
 */
export class InflightMap<V> {
  private readonly flights = new Map<string, Flight<V>>();

  get size(): number {
    return this.flights.size;
  }

  run(key: string, factory: (signal: AbortSignal) => Promise<V>, signal?: AbortSignal): Promise<V> {
    if (signal?.aborted) return Promise.reject(abortError());
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight<V> = { controller, waiters: 0, promise: undefined as unknown as Promise<V> };
      created.promise = factory(controller.signal).finally(() => {
        if (this.flights.get(key) === created) this.flights.delete(key);
      });
      created.promise.catch(() => undefined);
      this.flights.set(key, created);
      flight = created;
    }
    const f = flight;
    f.waiters += 1;
    return new Promise<V>((resolve, reject) => {
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        f.waiters -= 1;
      };
      const onAbort = () => {
        const wasSettled = settled;
        release();
        if (wasSettled) return;
        if (f.waiters === 0) {
          f.controller.abort();
          if (this.flights.get(key) === f) this.flights.delete(key);
        }
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      f.promise.then(
        (v) => {
          if (settled) return;
          release();
          resolve(v);
        },
        (e) => {
          if (settled) return;
          release();
          reject(e);
        },
      );
    });
  }
}
