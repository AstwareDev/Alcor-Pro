import { newId } from "../util/id";
import { pathKey } from "../project/projectPaths";
import type { PalmierProjectExportReport } from "./palmierProjectExporter";

/* Port of ExportQueue.swift + the state surface of ExportService (phase, progress, cancel, commit). */

export type ExportJobSource = "manual" | "agent";

export type ExportJobStatus = "queued" | "preparing" | "rendering" | "canceling" | "completed" | "failed" | "canceled";

export const exportStatusIsRunning = (s: ExportJobStatus): boolean => s === "preparing" || s === "rendering" || s === "canceling";
export const exportStatusIsFinished = (s: ExportJobStatus): boolean => s === "completed" || s === "failed" || s === "canceled";
export const exportStatusIsPending = (s: ExportJobStatus): boolean => s === "queued" || exportStatusIsRunning(s);

export interface ExportJob {
  readonly id: string;
  readonly projectID: string;
  readonly filename: string;
  readonly source: ExportJobSource;
  readonly outputPath: string;
  /** Epoch ms. */
  readonly createdAt: number;
  status: ExportJobStatus;
  progress: number;
  /** Seconds remaining, when known. */
  etaSeconds?: number;
  error?: string;
  warnings: string[];
  /** Set by a finished palmier-package export. */
  palmierReport?: PalmierProjectExportReport;
}

export interface ExportQueueSubmission {
  jobID: string;
  started: boolean;
  queuePosition: number;
}

export class ExportQueueError extends Error {
  constructor(readonly filename: string) {
    super(`An export to ${filename} is already waiting or in progress.`);
    this.name = "ExportQueueError";
  }
}

export type ExportPhase = "preparing" | "exporting";

/** Per-job handle given to the running operation (ExportService). */
export class ExportService {
  progress = 0;
  etaSeconds: number | undefined;
  error: string | undefined;
  warnings: string[] = [];
  palmierReport: PalmierProjectExportReport | undefined;
  wasCancelled = false;
  private committed = false;
  onPhaseChange: ((phase: ExportPhase) => void) | undefined;
  onProgressChange: ((progress: number, etaSeconds: number | undefined) => void) | undefined;
  private readonly controller = new AbortController();

  get didCommitOutput(): boolean {
    return this.committed;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** False once the output is committed (cancel can no longer undo it). */
  cancel(): boolean {
    if (this.committed) return false;
    this.wasCancelled = true;
    this.controller.abort();
    return true;
  }

  setPhase(phase: ExportPhase): void {
    this.onPhaseChange?.(phase);
  }

  setProgress(value: number, etaSeconds?: number): void {
    this.progress = value;
    this.etaSeconds = etaSeconds;
    this.onProgressChange?.(value, etaSeconds);
  }

  /** The finished file is in place at its destination. */
  commit(): void {
    this.committed = true;
  }

  fail(message: string): void {
    this.error = message;
  }
}

export type ExportOperation = (service: ExportService) => Promise<void>;

export interface EnqueueRequest {
  outputPath: string;
  projectID: string;
  source: ExportJobSource;
  warnings?: string[];
  operation: ExportOperation;
}

function lastPathComponent(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

export class ExportQueue {
  private all: ExportJob[] = [];
  private readonly operations = new Map<string, ExportOperation>();
  private activeID: string | undefined;
  private activeService: ExportService | undefined;
  private activeCancelRequested = false;
  private readonly listeners = new Set<() => void>();
  /** Called once per job after it reaches a finished state. */
  onJobFinished: ((job: ExportJob) => void) | undefined;

  get jobs(): readonly ExportJob[] {
    return this.all;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get hasActivity(): boolean {
    return this.all.some((j) => exportStatusIsPending(j.status));
  }

  get isExportActive(): boolean {
    return this.activeID !== undefined;
  }

  job(id: string): ExportJob | undefined {
    return this.all.find((j) => j.id === id);
  }

  jobsFor(projectID: string): ExportJob[] {
    return this.all.filter((j) => j.projectID === projectID);
  }

  isDestinationReserved(path: string): boolean {
    const key = pathKey(path);
    return this.all.some((j) => exportStatusIsPending(j.status) && pathKey(j.outputPath) === key);
  }

  enqueue(request: EnqueueRequest): ExportQueueSubmission {
    if (this.isDestinationReserved(request.outputPath)) throw new ExportQueueError(lastPathComponent(request.outputPath));
    const id = newId();
    this.all = [
      ...this.all,
      {
        id,
        projectID: request.projectID,
        filename: lastPathComponent(request.outputPath),
        source: request.source,
        outputPath: request.outputPath,
        createdAt: Date.now(),
        status: "queued",
        progress: 0,
        warnings: request.warnings ?? [],
      },
    ];
    this.operations.set(id, request.operation);
    this.startNext();
    const waiting = this.all.filter((j) => j.status === "queued");
    const index = waiting.findIndex((j) => j.id === id);
    this.notify();
    return { jobID: id, started: this.activeID === id, queuePosition: index < 0 ? 0 : index + 1 };
  }

  /** False when the job is unknown, already finished, or its output is committed. */
  cancel(id: string): boolean {
    const job = this.job(id);
    if (!job) return false;
    switch (job.status) {
      case "queued":
        this.operations.delete(id);
        this.patch(id, { status: "canceled" });
        return true;
      case "preparing":
      case "rendering":
        if (this.activeService && !this.activeService.cancel()) return false;
        this.activeCancelRequested = true;
        this.patch(id, { status: "canceling" });
        return true;
      case "canceling":
        return true;
      default:
        return false;
    }
  }

  remove(id: string): void {
    const job = this.job(id);
    if (!job || !exportStatusIsFinished(job.status)) return;
    this.all = this.all.filter((j) => j.id !== id);
    this.notify();
  }

  clearFinished(projectID: string): void {
    this.all = this.all.filter((j) => !(j.projectID === projectID && exportStatusIsFinished(j.status)));
    this.notify();
  }

  private startNext(): void {
    if (this.activeID !== undefined) return;
    const next = this.all.find((j) => j.status === "queued" && this.operations.has(j.id));
    if (!next) return;
    this.activeID = next.id;
    this.activeCancelRequested = false;
    this.all = this.all.map((j) => (j.id === next.id ? { ...j, status: "preparing" } : j));
    queueMicrotask(() => void this.run(next.id));
  }

  private async run(id: string): Promise<void> {
    const operation = this.operations.get(id);
    if (this.activeID !== id || !operation) return;
    const service = new ExportService();
    this.activeService = service;
    if (this.activeCancelRequested) {
      this.finish(id, "canceled", service);
      return;
    }
    service.onPhaseChange = (phase) => this.updatePhase(phase, id);
    service.onProgressChange = (progress, eta) => this.updateProgress(progress, eta, id);

    try {
      await operation(service);
    } catch (e) {
      if (service.wasCancelled || (e instanceof DOMException && e.name === "AbortError")) service.wasCancelled = true;
      else service.fail(e instanceof Error ? e.message : String(e));
    }

    let status: ExportJobStatus;
    if (service.didCommitOutput) status = "completed";
    else if (service.wasCancelled || this.job(id)?.status === "canceling") status = "canceled";
    else if (service.error !== undefined) status = "failed";
    else {
      service.fail("Export produced no output.");
      status = "failed";
    }
    this.finish(id, status, service);
  }

  private finish(id: string, status: ExportJobStatus, service: ExportService): void {
    if (this.job(id)) {
      this.patch(id, {
        status,
        progress: status === "completed" ? 1 : service.progress,
        etaSeconds: undefined,
        ...(service.error !== undefined ? { error: service.error } : {}),
        ...(service.warnings.length > 0 ? { warnings: service.warnings } : {}),
        ...(service.palmierReport !== undefined ? { palmierReport: service.palmierReport } : {}),
      });
    }
    this.operations.delete(id);
    this.activeID = undefined;
    this.activeService = undefined;
    this.activeCancelRequested = false;
    const finished = this.job(id);
    if (finished) this.onJobFinished?.(finished);
    this.startNext();
    this.notify();
  }

  private updatePhase(phase: ExportPhase, id: string): void {
    const job = this.job(id);
    if (!job || job.status === "canceling") return;
    this.patch(id, { status: phase === "preparing" ? "preparing" : "rendering" });
  }

  private updateProgress(progress: number, etaSeconds: number | undefined, id: string): void {
    const job = this.job(id);
    if (!job || !exportStatusIsPending(job.status)) return;
    this.patch(id, { progress: Math.min(1, Math.max(0, progress)), etaSeconds });
  }

  private patch(id: string, changes: Partial<ExportJob>): void {
    this.all = this.all.map((j) => (j.id === id ? { ...j, ...changes } : j));
    this.notify();
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** The app-wide queue (ExportQueue.shared). */
export const sharedExportQueue = new ExportQueue();

/** Stable per-project key: a project's exports survive reopening the same package. */
export function exportQueueProjectID(projectPath: string | null | undefined): string {
  return projectPath ? `path:${pathKey(projectPath)}` : "untitled";
}
