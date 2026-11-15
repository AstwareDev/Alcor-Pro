import { describe, expect, it } from "vitest";
import { isAbortError } from "./concurrency";
import { makeProjectPackageCoordinator } from "./projectPackageCoordinator";

describe("ProjectPackageCoordinator", () => {
  it("runs a mutation immediately when no save is in progress", async () => {
    const c = makeProjectPackageCoordinator();
    await expect(c.performMutation(() => 42)).resolves.toBe(42);
  });

  it("defers a mutation until the save finishes successfully", async () => {
    const c = makeProjectPackageCoordinator();
    const log: string[] = [];
    c.saveStarted();
    const p = c.performMutation(() => {
      log.push("mutation");
      return "done";
    });
    await Promise.resolve();
    expect(log).toEqual([]);
    log.push("save finished");
    c.saveFinished(true);
    await expect(p).resolves.toBe("done");
    expect(log).toEqual(["save finished", "mutation"]);
  });

  it("cancels deferred mutations when the save fails", async () => {
    const c = makeProjectPackageCoordinator();
    c.saveStarted();
    const p = c.performMutation(() => 1);
    c.saveFinished(false);
    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it("waits for the last of overlapping saves", async () => {
    const c = makeProjectPackageCoordinator();
    c.saveStarted();
    c.saveStarted();
    let ran = false;
    const p = c.performMutation(() => {
      ran = true;
    });
    c.saveFinished(true);
    expect(ran).toBe(false);
    c.saveFinished(true);
    await p;
    expect(ran).toBe(true);
  });

  it("an aborted deferred mutation never runs", async () => {
    const c = makeProjectPackageCoordinator();
    c.saveStarted();
    const ac = new AbortController();
    let ran = false;
    const p = c.performMutation(() => {
      ran = true;
    }, ac.signal);
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
    c.saveFinished(true);
    expect(ran).toBe(false);
  });

  it("waitUntilIdle resolves after saves and mutations end; closing refuses new mutations", async () => {
    const c = makeProjectPackageCoordinator();
    c.saveStarted();
    c.beginMutation();
    let idle = false;
    const w = c.waitUntilIdle().then(() => {
      idle = true;
    });
    c.saveFinished(true);
    await Promise.resolve();
    expect(idle).toBe(false);
    c.endMutation();
    await w;
    expect(idle).toBe(true);

    await c.beginClosing();
    expect(() => c.beginMutation()).toThrow();
    c.cancelClosing();
    expect(() => c.beginMutation()).not.toThrow();
  });

  it("ignores unbalanced end/finish calls", () => {
    const c = makeProjectPackageCoordinator();
    c.endMutation();
    c.saveFinished(true);
    expect(() => c.beginMutation()).not.toThrow();
  });
});
