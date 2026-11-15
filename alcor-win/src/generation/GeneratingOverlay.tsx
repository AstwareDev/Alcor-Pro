import { Show } from "solid-js";
import { generationProgress } from "./generationState";
import "./generation.css";

/** Port of UI/GeneratingOverlay: label + shimmering progress bar. With an `assetId` the bar follows provider progress. */
export function GeneratingOverlay(props: { label?: string; size?: "thumbnail" | "preview"; assetId?: string }) {
  const progress = () => (props.assetId === undefined ? undefined : generationProgress(props.assetId));
  return (
    <div class="gen-overlay" classList={{ preview: props.size === "preview" }}>
      <span class="gen-overlay-label">{props.label ?? "Generating…"}</span>
      <div class="gen-overlay-bar">
        <div classList={{ auto: progress() === undefined }} style={progress() === undefined ? undefined : { width: `${Math.round((progress() ?? 0) * 100)}%` }} />
      </div>
      <Show when={progress() !== undefined && props.size === "preview"}>
        <span class="gen-overlay-pct">{Math.round((progress() ?? 0) * 100)}%</span>
      </Show>
    </div>
  );
}
