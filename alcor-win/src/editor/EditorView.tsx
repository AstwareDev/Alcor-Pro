import { Match, Switch, type JSX } from "solid-js";
import { Split, type SplitPane } from "../ui/Split";
import { Layout } from "../model/constants";
import { layoutPreset, panelHidden, setFocusedPanel, type FocusedPanel } from "./workspace";
import type { Editor } from "./editor";
import { TitleBar } from "./TitleBar";
import "./EditorView.css";

export interface EditorPanels {
  media: () => JSX.Element;
  preview: () => JSX.Element;
  inspector: () => JSX.Element;
  timeline: () => JSX.Element;
}

type Initial = SplitPane["initial"];

export function EditorView(props: {
  title: string;
  panels: EditorPanels;
  onExport: () => void;
  onHome?: () => void;
  onOpenSettings?: () => void;
  /** Enables the title bar's Save button (and its unsaved-changes dot) for this editor. */
  editor?: Editor;
}) {
  const leaf = (id: FocusedPanel, initial: Initial, min: number, max?: number): SplitPane => ({
    id,
    initial,
    min,
    max,
    hidden: () => panelHidden(id),
    content: () => (
      <div class="editor-leaf" onPointerDown={() => setFocusedPanel(id)}>
        {props.panels[id]()}
      </div>
    ),
  });
  const group = (
    id: string,
    initial: Initial,
    min: number,
    members: FocusedPanel[],
    content: () => JSX.Element,
  ): SplitPane => ({ id, initial, min, hidden: () => members.every(panelHidden), content });

  const media = (initial: Initial) => leaf("media", initial, Layout.mediaPanelMin);
  const inspector = () => leaf("inspector", Layout.inspectorDefault, Layout.inspectorMin);
  const preview = () => leaf("preview", "fill", Layout.previewMinWidth);
  const timeline = (initial: Initial) => leaf("timeline", initial, Layout.timelineMinHeight);

  const defaultLayout = () => (
    <Split
      vertical
      storageKey="editor.default.preset"
      panes={[
        group("upper", "fill", Layout.previewMinHeight, ["media", "preview", "inspector"], () => (
          <Split storageKey="editor.default.h" panes={[media(Layout.mediaPanelDefault), preview(), inspector()]} />
        )),
        timeline((h) => h * Layout.timelineDefaultHeightFraction),
      ]}
    />
  );

  const mediaLayout = () => (
    <Split
      storageKey="editor.media.preset"
      panes={[
        media((w) => w * 0.3),
        group("right", "fill", 400, ["preview", "inspector", "timeline"], () => (
          <Split
            vertical
            storageKey="editor.media.right"
            panes={[
              group("top", "fill", Layout.previewMinHeight, ["preview", "inspector"], () => (
                <Split storageKey="editor.media.top" panes={[preview(), inspector()]} />
              )),
              timeline((h) => h * 0.45),
            ]}
          />
        )),
      ]}
    />
  );

  const verticalLayout = () => (
    <Split
      storageKey="editor.vertical.preset"
      panes={[
        group("left", (w) => w * 0.5, 400, ["media", "inspector", "timeline"], () => (
          <Split
            vertical
            storageKey="editor.vertical.left"
            panes={[
              group("top", "fill", 200, ["media", "inspector"], () => (
                <Split
                  storageKey="editor.vertical.top"
                  panes={[{ ...media(0), initial: "fill" }, inspector()]}
                />
              )),
              timeline((h) => h * 0.45),
            ]}
          />
        )),
        preview(),
      ]}
    />
  );

  return (
    <div class="editor">
      <TitleBar title={props.title} editor={props.editor} onExport={props.onExport} onHome={props.onHome} onOpenSettings={props.onOpenSettings} />
      <div class="editor-body">
        <Switch>
          <Match when={layoutPreset() === "default"}>{defaultLayout()}</Match>
          <Match when={layoutPreset() === "media"}>{mediaLayout()}</Match>
          <Match when={layoutPreset() === "vertical"}>{verticalLayout()}</Match>
        </Switch>
      </div>
    </div>
  );
}
