// Port of MediaTab+IndexStatus.swift: model download button, download progress, and indexing progress in the media panel.
import { Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { siglipModel } from "../ml/modelCatalog";
import { modelTotalBytes } from "../ml/modelStore";
import { searchIndexFor } from "./searchService";
import "./searchIndexStatus.css";

const sizeLabel = `${Math.round(modelTotalBytes(siglipModel) / 1_000_000)} MB`;

export function SearchIndexStatus(props: { editor: Editor }) {
  const index = () => searchIndexFor(props.editor);
  const model = () => index().model;
  const hasIndexable = () => props.editor.mediaAssets.some((a) => a.type === "video" || a.type === "image");
  const kind = () => model().state().kind;

  return (
    <Show when={model().enabled()}>
      <Show when={kind() === "notInstalled" && hasIndexable()}>
        <button
          type="button"
          class="si-status si-button"
          title={`Downloads a ${sizeLabel} on-device model so you can search media visually.`}
          onClick={() => void model().download()}
        >
          Smart search
        </button>
      </Show>
      <Show when={kind() === "downloading"}>
        <span class="si-status" title="Downloading the on-device model that powers visual search.">
          Downloading {Math.round(model().downloadProgress() * 100)}%
        </span>
      </Show>
      <Show when={kind() === "preparing"}>
        <span class="si-status" title="Getting the search model ready.">Preparing…</span>
      </Show>
      <Show when={kind() === "ready" && index().indexingActive}>
        <span class="si-status" title="Analyzing media so you can search it.">
          Indexing {Math.min(index().batchCompleted + 1, index().batchTotal)}/{index().batchTotal}
        </span>
      </Show>
      <Show when={kind() === "failed"}>
        <button
          type="button"
          class="si-status si-button"
          title="Visual search model download failed. Check your connection and try again."
          onClick={() => void model().download()}
        >
          Retry
        </button>
      </Show>
    </Show>
  );
}
