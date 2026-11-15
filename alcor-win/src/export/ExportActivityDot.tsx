import { Show } from "solid-js";
import { exportStatusIsPending } from "./exportQueue";
import "./ExportDialog.css";
import { useExportJobs } from "./useExportJobs";

/** Pulsing dot (AppTheme.Export.activityDotSize) shown while any export is queued or running. */
export function ExportActivityDot() {
  const jobs = useExportJobs();
  return (
    <Show when={jobs().some((j) => exportStatusIsPending(j.status))}>
      <span class="export-activity-dot" aria-label="Export in progress" />
    </Show>
  );
}
