import { describe, expect, it } from "vitest";
import { ExportQueue, ExportQueueError, exportQueueProjectID, type ExportOperation } from "./exportQueue";

async function waitUntil(condition: () => boolean): Promise<boolean> {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return true;
    await Promise.resolve();
  }
  return condition();
}

function enqueue(queue: ExportQueue, name: string, operation: ExportOperation, projectID = "test-project") {
  return queue.enqueue({ outputPath: `C:\\tmp\\export-queue-${name}`, projectID, source: "manual", operation });
}

const never = (): Promise<void> => new Promise(() => {});

describe("Export queue", () => {
  it("runsInFIFOOrder", async () => {
    const queue = new ExportQueue();
    const events: string[] = [];
    const first = enqueue(queue, "first.mov", async (s) => {
      events.push("first-start");
      await Promise.resolve();
      events.push("first-finish");
      s.commit();
    });
    const second = enqueue(queue, "second.mov", async (s) => {
      events.push("second-start");
      events.push("second-finish");
      s.commit();
    });
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.queuePosition).toBe(1);
    expect(await waitUntil(() => !queue.hasActivity)).toBe(true);
    expect(events).toEqual(["first-start", "first-finish", "second-start", "second-finish"]);
  });

  it("cancelingPreparingJobAdvancesQueueWithoutRunningIt", async () => {
    const queue = new ExportQueue();
    let firstRan = false;
    let secondRan = false;
    const first = enqueue(queue, "active.mov", async () => {
      firstRan = true;
      await never();
    });
    const second = enqueue(queue, "next.mov", async () => {
      secondRan = true;
    });
    queue.cancel(first.jobID);
    expect(await waitUntil(() => queue.job(first.jobID)?.status === "canceled" && queue.job(second.jobID)?.status === "failed")).toBe(true);
    expect(firstRan).toBe(false);
    expect(secondRan).toBe(true);
    expect(queue.job(second.jobID)?.error).toBe("Export produced no output.");
  });

  it("cancelingWaitingJobDoesNotRunIt", async () => {
    const queue = new ExportQueue();
    let waitingRan = false;
    const blocker = enqueue(queue, "waiting-blocker.mov", (s) => new Promise<void>((resolve) => s.signal.addEventListener("abort", () => resolve())));
    const waiting = enqueue(queue, "waiting.mov", async () => {
      waitingRan = true;
    });
    queue.cancel(waiting.jobID);
    queue.cancel(blocker.jobID);
    expect(queue.job(waiting.jobID)?.status).toBe("canceled");
    expect(await waitUntil(() => !queue.hasActivity)).toBe(true);
    expect(waitingRan).toBe(false);
  });

  it("cancelingARunningJobAbortsItsSignal", async () => {
    const queue = new ExportQueue();
    const job = enqueue(queue, "running.mp4", async (s) => {
      s.setPhase("exporting");
      await new Promise<void>((resolve) => s.signal.addEventListener("abort", () => resolve()));
    });
    expect(await waitUntil(() => queue.job(job.jobID)?.status === "rendering")).toBe(true);
    expect(queue.cancel(job.jobID)).toBe(true);
    expect(queue.job(job.jobID)?.status).toBe("canceling");
    expect(await waitUntil(() => queue.job(job.jobID)?.status === "canceled")).toBe(true);
  });

  it("scopesHistoryByProject", async () => {
    const queue = new ExportQueue();
    const op: ExportOperation = async (s) => s.commit();
    const first = enqueue(queue, "project-first.xml", op, "project-a");
    const second = enqueue(queue, "project-second.xml", op, "project-b");
    expect(await waitUntil(() => !queue.hasActivity)).toBe(true);
    expect(queue.jobsFor("project-a").map((j) => j.id)).toEqual([first.jobID]);
    expect(queue.jobsFor("project-b").map((j) => j.id)).toEqual([second.jobID]);
    queue.clearFinished("project-a");
    expect(queue.jobsFor("project-a")).toEqual([]);
    expect(queue.jobsFor("project-b").map((j) => j.id)).toEqual([second.jobID]);
    expect(exportQueueProjectID("C:\\p\\a.palmier")).toBe(exportQueueProjectID("c:/p/a.palmier"));
  });

  it("lateProgressAndCancellationKeepCommittedExportCompleted", async () => {
    const queue = new ExportQueue();
    let jobID = "";
    let cancellationAccepted: boolean | undefined;
    let progressUpdate: ((p: number) => void) | undefined;
    jobID = enqueue(queue, "late-cancel.xml", async (s) => {
      progressUpdate = (p) => s.setProgress(p);
      s.commit();
      cancellationAccepted = queue.cancel(jobID);
    }).jobID;
    expect(await waitUntil(() => queue.job(jobID)?.status === "completed")).toBe(true);
    expect(cancellationAccepted).toBe(false);
    progressUpdate?.(0.25);
    expect(queue.job(jobID)?.progress).toBe(1);
  });

  it("rejectsADuplicateDestinationWhilePending", () => {
    const queue = new ExportQueue();
    enqueue(queue, "dup.mp4", never);
    expect(() => enqueue(queue, "dup.mp4", never)).toThrow(ExportQueueError);
    expect(() => queue.enqueue({ outputPath: "c:/TMP/export-queue-DUP.mp4", projectID: "x", source: "manual", operation: never })).toThrow(
      "An export to export-queue-DUP.mp4 is already waiting or in progress.",
    );
  });

  it("reportsFailureAndProgress", async () => {
    const queue = new ExportQueue();
    const job = enqueue(queue, "fail.mp4", async (s) => {
      s.setProgress(0.5, 10);
      throw new Error("encoder exploded");
    });
    expect(await waitUntil(() => queue.job(job.jobID)?.status === "failed")).toBe(true);
    expect(queue.job(job.jobID)?.error).toBe("encoder exploded");
    expect(queue.job(job.jobID)?.progress).toBe(0.5);
  });
});
