import { BufferTarget, StreamTarget, type StreamTargetChunk, type Target } from "mediabunny";
import { ExportCancelledError, ExportError, type MainToWorker, type WorkerToMain } from "./exportTypes";
import { runExportPipeline } from "./exportPipeline";

/* Dedicated export worker: decode, composite (WebGL2 on OffscreenCanvas) and encode off the UI thread. */

interface WorkerScope {
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const controller = new AbortController();
const pendingAcks = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
let nextWriteId = 0;
let started = false;

function streamTarget(): Target {
  const writable = new WritableStream<StreamTargetChunk>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        const id = ++nextWriteId;
        pendingAcks.set(id, { resolve, reject });
        // Copy: the muxer may keep a reference to the chunk it hands over.
        const data = chunk.data.slice();
        scope.postMessage({ type: "write", id, position: chunk.position, data }, [data.buffer]);
      });
    },
  });
  return new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 });
}

async function start(message: Extract<MainToWorker, { type: "start" }>): Promise<void> {
  try {
    const streaming = message.target === "stream";
    const target = streaming ? streamTarget() : new BufferTarget();
    const report = await runExportPipeline(message.spec, target, {
      signal: controller.signal,
      streaming,
      onProgress: (progress) => scope.postMessage({ type: "progress", progress }),
    });
    if (target instanceof BufferTarget) {
      const buffer = target.buffer;
      if (!buffer) throw new ExportError("The encoder produced no output.");
      scope.postMessage({ type: "done", report, buffer }, [buffer]);
    } else {
      scope.postMessage({ type: "done", report });
    }
  } catch (e) {
    const cancelled = e instanceof ExportCancelledError || controller.signal.aborted;
    scope.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e), cancelled });
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  switch (message.type) {
    case "start":
      if (started) return;
      started = true;
      void start(message);
      break;
    case "cancel":
      controller.abort();
      for (const [id, p] of pendingAcks) {
        pendingAcks.delete(id);
        p.reject(new ExportCancelledError());
      }
      break;
    case "ack": {
      const p = pendingAcks.get(message.id);
      if (!p) break;
      pendingAcks.delete(message.id);
      if (message.error !== undefined) p.reject(new ExportError(message.error));
      else p.resolve();
      break;
    }
  }
};
