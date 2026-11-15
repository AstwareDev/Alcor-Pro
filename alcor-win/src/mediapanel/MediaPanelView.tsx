import Folder from "lucide-solid/icons/folder";
import { createEffect, createSignal, For, Show, type JSX } from "solid-js";
import type { Editor } from "../editor/editor";
import { MediaTab } from "./MediaTab";
import type { MediaPanelServices } from "./services";
import type { ThumbnailProvider } from "./thumbnailProvider";
import "./mediaPanel.css";

export interface MediaPanelExtraTab {
  id: string;
  icon: JSX.Element;
  label: string;
  render: () => JSX.Element;
}

const mediaTabId = "media";

/** Left tab rail + the active tab. Only the Media tab is built in; other tabs are supplied by the integrator. */
export function MediaPanelView(props: {
  editor: Editor;
  extraTabs?: readonly MediaPanelExtraTab[];
  onGenerate?: () => void;
  generationPanel?: () => JSX.Element;
  thumbnailProvider?: ThumbnailProvider;
  services?: MediaPanelServices;
}) {
  const [active, setActive] = createSignal<string>(mediaTabId);
  // "Swap Media" arms a clip and needs the library in front (showMediaPanelMediaTab).
  createEffect(() => {
    if (props.editor.ui.pendingSwapClipId !== null) setActive(mediaTabId);
  });
  const extra = () => props.extraTabs ?? [];
  const activeExtra = () => extra().find((t) => t.id === active());
  return (
    <div class="media-panel">
      <div class="mp-rail" role="tablist" aria-orientation="vertical">
        <button
          type="button"
          role="tab"
          class="mp-rail-button hover-highlight"
          classList={{ active: active() === mediaTabId }}
          aria-selected={active() === mediaTabId}
          title="Media"
          aria-label="Media"
          onClick={() => setActive(mediaTabId)}
        >
          <Folder size={14} />
        </button>
        <For each={extra()}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              class="mp-rail-button hover-highlight"
              classList={{ active: active() === tab.id }}
              aria-selected={active() === tab.id}
              title={tab.label}
              aria-label={tab.label}
              onClick={() => setActive(tab.id)}
            >
              {tab.icon}
            </button>
          )}
        </For>
      </div>
      <div class="mp-content">
        <div class="mp-tab-host" style={{ display: active() === mediaTabId ? "flex" : "none" }}>
          <MediaTab
            editor={props.editor}
            onGenerate={props.onGenerate}
            generationPanel={props.generationPanel}
            thumbnailProvider={props.thumbnailProvider}
            services={props.services}
          />
        </div>
        <Show when={activeExtra()}>{(tab) => <div class="mp-tab-host">{tab().render()}</div>}</Show>
      </div>
    </div>
  );
}
