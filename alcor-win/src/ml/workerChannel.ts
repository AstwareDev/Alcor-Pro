// Request/reply channel to a dedicated ML worker. Messages carry an `id`; the worker may also post `progress` events
// for a request before its final reply. Aborting terminates the worker (the owner recreates it on the next use).

export interface WorkerEnvelope<R> {
  id: number;
  reply?: R;
  progress?: number;
  error?: string;
}

export class WorkerChannel<Req, Rep> {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: Rep) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }>();
  private dead: Error | undefined;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (e: MessageEvent<WorkerEnvelope<Rep>>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.progress !== undefined) {
        p.onProgress?.(m.progress);
        return;
      }
      this.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.reply as Rep);
    };
    worker.onerror = (e) => this.fail(new Error(e.message || "ML worker failed."));
  }

  private fail(error: Error): void {
    this.dead = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  get alive(): boolean {
    return this.dead === undefined;
  }

  request(message: Req, transfer: Transferable[] = [], onProgress?: (p: number) => void): Promise<Rep> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    return new Promise<Rep>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...(onProgress ? { onProgress } : {}) });
      this.worker.postMessage({ id, message }, transfer);
    });
  }

  terminate(): void {
    this.worker.terminate();
    this.fail(new DOMException("worker terminated", "AbortError"));
  }
}

/** Worker-side helper: wires `handler` to the envelope protocol. */
export interface WorkerScope<Req, Rep> {
  onmessage: ((e: MessageEvent<{ id: number; message: Req }>) => void) | null;
  postMessage(message: WorkerEnvelope<Rep>, transfer?: Transferable[]): void;
}

export function serveWorker<Req, Rep>(
  scope: WorkerScope<Req, Rep>,
  handler: (message: Req, progress: (p: number) => void) => Promise<{ reply: Rep; transfer?: Transferable[] }>,
): void {
  scope.onmessage = (e) => {
    const { id, message } = e.data;
    handler(message, (p) => scope.postMessage({ id, progress: p }))
      .then(({ reply, transfer }) => scope.postMessage({ id, reply }, transfer ?? []))
      .catch((err: unknown) => scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) }));
  };
}
