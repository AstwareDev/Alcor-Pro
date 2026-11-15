import LocateFixed from "lucide-solid/icons/locate-fixed";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { Editor } from "../editor/editor";
import { seekToFrame } from "../editor/mutations/core";
import { linkedPartnerIds } from "../editor/mutations/linking";
import { timelineTrackDisplayLabel } from "../editor/mutations/tracks";
import { DropdownMenuButton } from "../ui/DropdownMenuButton";
import { EditorMenuValue } from "../ui/EditorPanel";
import { ExpandableSearch } from "../ui/ExpandableSearch";
import { HoverTooltip } from "../ui/HoverTooltip";
import type { MenuItem } from "../ui/Menu";
import { formatTimecode } from "../util/timeFormatting";
import {
  filterTranscriptRows, transcriptDurationLabel, transcriptRowDurationFrames, TranscriptTimelineIndex,
  type TimelineTranscriptDocument, type TimelineTranscriptRow, type TranscriptIndexSource,
} from "./transcriptBrowserModel";
import "./captions.css";

function trackLabel(editor: Editor, document: TimelineTranscriptDocument): string {
  const index = document.sourceTrackId === undefined ? -1 : editor.timeline.tracks.findIndex((t) => t.id === document.sourceTrackId);
  return index < 0 ? "Transcript" : `Caption ${timelineTrackDisplayLabel(editor, index)}`;
}

/** Port of `TranscriptSourceMenu`: choose between the audio transcript and caption groups already on the timeline. */
export function TranscriptSourceMenu(props: {
  editor: Editor;
  document: TimelineTranscriptDocument | undefined;
  captionSources: readonly TimelineTranscriptDocument[];
  onSelect: (source: TranscriptIndexSource) => void;
}) {
  const items = (): MenuItem[] => [
    { kind: "item", label: "Transcript", checked: props.document?.sourceCaptionGroupId === undefined, onSelect: () => props.onSelect({ kind: "transcript" }) },
    { kind: "divider" },
    ...props.captionSources.map((caption) => ({
      kind: "item" as const,
      label: trackLabel(props.editor, caption),
      checked: props.document?.sourceCaptionGroupId === caption.sourceCaptionGroupId,
      onSelect: () => {
        if (caption.sourceCaptionGroupId !== undefined) props.onSelect({ kind: "captions", groupId: caption.sourceCaptionGroupId });
      },
    })),
  ];
  return (
    <DropdownMenuButton items={items} class="cap-source-menu">
      <EditorMenuValue text={props.document ? trackLabel(props.editor, props.document) : "Transcript"} expanded />
    </DropdownMenuButton>
  );
}

function selectRow(editor: Editor, row: TimelineTranscriptRow): void {
  editor.ui.selectedGap = null;
  editor.ui.selectedTimelineRange = null;
  editor.ui.selectedTimelineMarkerIds = new Set();
  editor.ui.selectedClipIds = new Set([row.clipId, ...linkedPartnerIds(editor, row.clipId)]);
  seekToFrame(editor, row.startFrame);
}

/** Port of `TranscriptBrowser`: searchable list of transcript rows; click selects the clip and seeks. */
export function TranscriptBrowser(props: {
  editor: Editor;
  document: TimelineTranscriptDocument;
  captionSources: readonly TimelineTranscriptDocument[];
  onSelectSource: (source: TranscriptIndexSource) => void;
}) {
  const editor = props.editor;
  const [query, setQuery] = createSignal("");
  let list: HTMLDivElement | undefined;

  const rows = createMemo(() => filterTranscriptRows(props.document.rows, query()));
  const timelineIndex = createMemo(() => new TranscriptTimelineIndex(props.document.rows));
  const currentRowId = createMemo(() => timelineIndex().currentRow(editor.ui.currentFrame)?.id);

  const jumpToPlayhead = (): void => {
    const id = currentRowId();
    if (id === undefined) return;
    setQuery("");
    queueMicrotask(() => list?.querySelector(`[data-row-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };
  createEffect(on(() => props.document, () => list?.scrollTo({ top: 0 })));

  return (
    <div class="cap-transcript">
      <div class="cap-transcript-controls">
        <span class="cap-transcript-title">Transcript</span>
        <span class="cap-footer-spacer" />
        <Show when={props.captionSources.length > 0}>
          <TranscriptSourceMenu editor={editor} document={props.document} captionSources={props.captionSources} onSelect={props.onSelectSource} />
        </Show>
        <ExpandableSearch value={query()} onInput={setQuery} placeholder="Search transcript" label="Search transcript" />
        <HoverTooltip text="Jump to Playhead">
          <button
            type="button"
            class="cap-jump hover-highlight"
            disabled={currentRowId() === undefined}
            aria-label="Jump to Playhead"
            onClick={jumpToPlayhead}
          >
            <LocateFixed size={13} />
          </button>
        </HoverTooltip>
      </div>
      <div class="cap-transcript-divider" />
      <div class="cap-transcript-list" ref={list}>
        <Show
          when={rows().length > 0}
          fallback={<p class="cap-transcript-empty">{`No matches for “${query().trim()}”`}</p>}
        >
          <For each={rows()}>
            {(row) => {
              const duration = (): string => transcriptDurationLabel(transcriptRowDurationFrames(row), props.document.fps) ?? "";
              return (
                <button
                  type="button"
                  class="cap-row hover-highlight"
                  classList={{ active: editor.ui.selectedClipIds.has(row.clipId), current: currentRowId() === row.id }}
                  data-row-id={row.id}
                  onClick={() => selectRow(editor, row)}
                >
                  <span class="cap-row-time">{formatTimecode(row.startFrame, props.document.fps)}</span>
                  <span class="cap-row-duration">{duration()}</span>
                  <span class="cap-row-text">{row.text}</span>
                </button>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}
