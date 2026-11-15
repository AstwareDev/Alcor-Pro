import { abortError, throwIfAborted } from "./concurrency";

/**
 * Port of ProjectPackageCoordinator: serialises package mutations (copying media into the project) against
 * saves, so a save never observes a half-written package. A mutation requested during a save waits for it.
 */
export interface ProjectPackageCoordinator {
  saveStarted(): void;
  saveFinished(success: boolean): void;
  /** Counts an in-flight mutation so `beginClosing` / `waitUntilIdle` wait for it. Throws when cancelled or closing. */
  beginMutation(signal?: AbortSignal): void;
  endMutation(): void;
  /** Runs now when no save is in progress; otherwise after the save succeeds (rejects with AbortError if it fails). */
  performMutation<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T>;
  beginClosing(): Promise<void>;
  cancelClosing(): void;
  waitUntilIdle(): Promise<void>;
}

interface PendingMutation {
  run: () => void;
  cancel: () => void;
}

export function makeProjectPackageCoordinator(): ProjectPackageCoordinator {
  let savesInProgress = 0;
  let activeMutations = 0;
  let isClosing = false;
  let pending: PendingMutation[] = [];
  let idleWaiters: (() => void)[] = [];

  function resumeIdleWaitersIfNeeded(): void {
    if (savesInProgress !== 0 || activeMutations !== 0) return;
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resume of waiting) resume();
  }

  return {
    saveStarted() {
      savesInProgress += 1;
    },

    saveFinished(success) {
      if (savesInProgress === 0) return;
      savesInProgress -= 1;
      if (savesInProgress !== 0) return;
      const mutations = pending;
      pending = [];
      for (const m of mutations) (success ? m.run : m.cancel)();
      resumeIdleWaitersIfNeeded();
    },

    beginMutation(signal) {
      throwIfAborted(signal);
      if (isClosing) throw abortError();
      activeMutations += 1;
    },

    endMutation() {
      if (activeMutations === 0) return;
      activeMutations -= 1;
      resumeIdleWaitersIfNeeded();
    },

    performMutation<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortError());
      if (savesInProgress === 0) {
        try {
          return Promise.resolve(operation());
        } catch (e) {
          return Promise.reject(e);
        }
      }
      return new Promise<T>((resolve, reject) => {
        const mutation: PendingMutation = {
          run: () => {
            signal?.removeEventListener("abort", onAbort);
            try {
              resolve(operation());
            } catch (e) {
              reject(e);
            }
          },
          cancel: () => {
            signal?.removeEventListener("abort", onAbort);
            reject(abortError());
          },
        };
        const onAbort = () => {
          const i = pending.indexOf(mutation);
          if (i < 0) return;
          pending.splice(i, 1);
          reject(abortError());
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.push(mutation);
      });
    },

    async beginClosing() {
      isClosing = true;
      await this.waitUntilIdle();
    },

    cancelClosing() {
      isClosing = false;
    },

    waitUntilIdle() {
      if (savesInProgress === 0 && activeMutations === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
  };
}
