import { exportFileAbort, exportFileFinish, exportFileOpen, exportFileWrite } from "../platform/backend";
import {
  ExportCancelledError, ExportError, type ExportJobSpec, type ExportProgress, type ExportReport, type MainToWorker,
  type WorkerToMain,
} from "./exportTypes";

/*
 * Main-thread side of the export engine. The render pipeline (decode, WebGL2 composite, WebCodecs encode, audio mix)
 * runs in `exportWorker.ts`; this module owns the worker, forwards output chunks to the Rust streaming writer, and
 * turns AbortSignal into a cancel that also deletes the `.partial` file.
 */

export interface RunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

/** After a cancel request the worker gets this long to stop on its own before it is terminated. */
const cancelGraceMs = 10_000;

interface Session {
  report: ExportReport;
  buffer?: ArrayBuffer;
}

function runInWorker(
  spec: ExportJobSpec,
  target: "stream" | "buffer",
  options: RunOptions,
  write: (position: number, data: Uint8Array) => Promise<void>,
): Promise<Session> {
  return new Promise<Session>((resolve, reject) => {
    const worker = new Worker(new URL("./exportWorker.ts", import.meta.url), { type: "module" });
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const send = (message: MainToWorker): void => worker.postMessage(message);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      fn();
    };
    const onAbort = (): void => {
      send({ type: "cancel" });
      killTimer = setTimeout(() => finish(() => reject(new ExportCancelledError())), cancelGraceMs);
    };

    worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      const m = event.data;
      switch (m.type) {
        case "progress":
          options.onProgress?.(m.progress);
          break;
        case "write":
          write(m.position, m.data).then(
            () => send({ type: "ack", id: m.id }),
            (e: unknown) => send({ type: "ack", id: m.id, error: e instanceof Error ? e.message : String(e) }),
          );
          break;
        case "done":
          finish(() => resolve(m.buffer ? { report: m.report, buffer: m.buffer } : { report: m.report }));
          break;
        case "error":
          finish(() => reject(m.cancelled ? new ExportCancelledError() : new ExportError(m.message)));
          break;
      }
    };
    worker.onerror = (event) => finish(() => reject(new ExportError(`The export worker crashed: ${event.message}`)));

    if (options.signal?.aborted) {
      finish(() => reject(new ExportCancelledError()));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    send({ type: "start", spec, target });
  });
}

/** Streams the export to `destinationPath` through the Rust writer: `<path>.partial`, then atomic rename. */
export async function exportVideoToFile(spec: ExportJobSpec, destinationPath: string, options: RunOptions = {}): Promise<ExportReport> {
  const handle = await exportFileOpen(destinationPath);
  try {
    const { report } = await runInWorker(spec, "stream", options, (position, data) => exportFileWrite(handle, position, data));
    await exportFileFinish(handle);
    return report;
  } catch (e) {
    await exportFileAbort(handle).catch(() => undefined);
    throw e;
  }
}

/** Exports into memory (dev page, tests, short clips). Not for long timelines. */
export async function exportVideoToBuffer(spec: ExportJobSpec, options: RunOptions = {}): Promise<{ report: ExportReport; buffer: ArrayBuffer }> {
  const { report, buffer } = await runInWorker(spec, "buffer", options, () => Promise.resolve());
  if (!buffer) throw new ExportError("The encoder produced no output.");
  return { report, buffer };
}
