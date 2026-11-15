import { createSignal, onCleanup, type Accessor } from "solid-js";
import { sharedExportQueue, type ExportJob, type ExportQueue } from "./exportQueue";

/** Reactive snapshot of every job in the queue (new array on each change). */
export function useExportJobs(queue: ExportQueue = sharedExportQueue): Accessor<readonly ExportJob[]> {
  const [jobs, setJobs] = createSignal<readonly ExportJob[]>(queue.jobs);
  onCleanup(queue.subscribe(() => setJobs(queue.jobs)));
  return jobs;
}
