import { shallowMutable } from "../util/shallowMutable";
import {
  Defaults,
  cropAspectLockFree,
  makeMediaManifest,
  makeTimeline,
  type Clip,
  type ClipLocation,
  type ClipType,
  type CropAspectLock,
  type MediaAsset,
  type MaskTool,
  type MediaManifest,
  type MulticamSource,
  type SpeakerRegistryEntry,
  type Timeline,
  type TimelineMarker,
  type TimelineViewState,
} from "../model";
import { documentHasTransitions, pruneDocumentTransitions } from "../transitions/pruneTransitions";
import { DocumentStore, type Gesture } from "./document";
import type { GapSelection } from "./rippleEngine";

/** Everything undo can restore. Port of the persisted + undoable state of EditorViewModel. */
export interface EditorDocument {
  timelines: Timeline[];
  activeTimelineId: string;
  openTimelineIds: string[];
  mediaManifest: MediaManifest;
  mediaAssets: MediaAsset[];
  speakerRegistry: SpeakerRegistryEntry[];
  multicamGroups: MulticamSource[];
}

export type ToolMode = "pointer" | "razor";

export interface TimelineRangeSelection {
  startFrame: number;
  endFrame: number;
}

/** Snapshot of one copied clip plus its position relative to the copy anchor. */
export interface ClipClipboardEntry {
  clip: Clip;
  trackOffset: number;
  frameOffset: number;
  sourceTrackId: string;
  sourceTrackType: ClipType;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}

/** Transient editor state. Each field is a signal: assign a new value to notify (never mutate in place). */
export interface EditorUIState {
  currentFrame: number;
  isPlaying: boolean;
  isScrubbing: boolean;
  playbackRate: number;
  selectedClipIds: Set<string>;
  isMarqueeSelecting: boolean;
  selectedGap: GapSelection | null;
  selectedTimelineRange: TimelineRangeSelection | null;
  selectedTimelineMarkerIds: Set<string>;
  timelineMarkerPreview: TimelineMarker | null;
  selectedMediaAssetIds: Set<string>;
  selectedFolderIds: Set<string>;
  selectedTimelineIds: Set<string>;
  clipClipboard: ClipClipboardEntry[];
  zoomScale: number;
  timelineScrollOffsetX: number;
  timelineVisibleWidth: number;
  canvasZoom: number;
  canvasOffset: { width: number; height: number };
  toolMode: ToolMode;
  showExportDialog: boolean;
  showGenerationPanel: boolean;
  cropEditingActive: boolean;
  cropAspectLock: CropAspectLock;
  chromaKeySamplingClipId: string | null;
  /** Mask shown in the preview overlay for the selected clip. */
  selectedMaskId: string | null;
  /** Transition selected on the timeline (inspector target); mutually exclusive with clip selection in the UI. */
  selectedTransitionId: string | null;
  maskTool: MaskTool | null;
  pendingSwapClipId: string | null;
  mediaPanelCurrentFolderId: string | null;
  offlineMediaRefs: Set<string>;
  missingMediaRefs: Set<string>;
  rippleTimelineMarkers: boolean;
  toast: Toast | null;
}

function makeUIState(): EditorUIState {
  return {
    currentFrame: 0,
    isPlaying: false,
    isScrubbing: false,
    playbackRate: 1,
    selectedClipIds: new Set(),
    isMarqueeSelecting: false,
    selectedGap: null,
    selectedTimelineRange: null,
    selectedTimelineMarkerIds: new Set(),
    timelineMarkerPreview: null,
    selectedMediaAssetIds: new Set(),
    selectedFolderIds: new Set(),
    selectedTimelineIds: new Set(),
    clipClipboard: [],
    zoomScale: Defaults.pixelsPerFrame,
    timelineScrollOffsetX: 0,
    timelineVisibleWidth: 0,
    canvasZoom: 1,
    canvasOffset: { width: 0, height: 0 },
    toolMode: "pointer",
    showExportDialog: false,
    showGenerationPanel: false,
    cropEditingActive: false,
    cropAspectLock: cropAspectLockFree,
    chromaKeySamplingClipId: null,
    selectedMaskId: null,
    selectedTransitionId: null,
    maskTool: null,
    pendingSwapClipId: null,
    mediaPanelCurrentFolderId: null,
    offlineMediaRefs: new Set(),
    missingMediaRefs: new Set(),
    rippleTimelineMarkers: true,
    toast: null,
  };
}

interface SelectionSnapshot {
  clipIds: Set<string>;
  markerIds: Set<string>;
  assetIds: Set<string>;
  folderIds: Set<string>;
}

export function makeEditorDocument(): EditorDocument {
  const first = makeTimeline();
  return {
    timelines: [first],
    activeTimelineId: first.id,
    openTimelineIds: [first.id],
    mediaManifest: makeMediaManifest(),
    mediaAssets: [],
    speakerRegistry: [],
    multicamGroups: [],
  };
}

/**
 * Port of EditorViewModel's core. Feature mutations live in `src/editor/mutations/*` as free functions
 * taking the editor first, mirroring the Swift `extension EditorViewModel` files.
 */
export class Editor {
  readonly store: DocumentStore<EditorDocument>;
  readonly ui: EditorUIState = shallowMutable(makeUIState());
  /** Per-timeline view state that is saved with the project but never undone. */
  readonly liveViewStates: Record<string, TimelineViewState> = {};
  projectPath: string | null = null;
  private toastSequence = 0;
  private locationCache: { timeline: Timeline; index: Map<string, ClipLocation> } | null = null;

  constructor(document: EditorDocument = makeEditorDocument()) {
    this.store = new DocumentStore(document);
    this.store.context = {
      capture: (): SelectionSnapshot => ({
        clipIds: this.ui.selectedClipIds,
        markerIds: this.ui.selectedTimelineMarkerIds,
        assetIds: this.ui.selectedMediaAssetIds,
        folderIds: this.ui.selectedFolderIds,
      }),
      restore: (value) => {
        const selection = value as SelectionSnapshot;
        this.ui.selectedClipIds = selection.clipIds;
        this.ui.selectedTimelineMarkerIds = selection.markerIds;
        this.ui.selectedMediaAssetIds = selection.assetIds;
        this.ui.selectedFolderIds = selection.folderIds;
      },
    };
  }

  get doc(): EditorDocument {
    return this.store.doc;
  }

  get timelines(): Timeline[] {
    return this.doc.timelines;
  }

  get activeTimelineIndex(): number {
    const doc = this.doc;
    const index = doc.timelines.findIndex((t) => t.id === doc.activeTimelineId);
    return index < 0 ? 0 : index;
  }

  /** The active timeline; a mutable draft inside `perform`. */
  get timeline(): Timeline {
    return this.doc.timelines[this.activeTimelineIndex];
  }

  get mediaAssets(): MediaAsset[] {
    return this.doc.mediaAssets;
  }

  mediaAsset(id: string): MediaAsset | undefined {
    return this.doc.mediaAssets.find((a) => a.id === id);
  }

  perform<T>(actionName: string, work: () => T): T {
    if (this.store.isPerforming || !documentHasTransitions(this.store.committed)) return this.store.perform(actionName, work);
    // Any edit may break a cut: drop or shorten transitions the clips no longer support, inside the same undo entry.
    return this.store.perform(actionName, () => {
      const result = work();
      pruneDocumentTransitions(this.store.doc);
      return result;
    });
  }

  withoutRegistration<T>(work: () => T): T {
    return this.store.withoutRegistration(work);
  }

  beginGesture(actionName: string): Gesture {
    return this.store.beginGesture(actionName);
  }

  undo(): string | null {
    const name = this.store.undo();
    if (name !== null) this.pruneSelection();
    return name;
  }

  redo(): string | null {
    const name = this.store.redo();
    if (name !== null) this.pruneSelection();
    return name;
  }

  findClip(id: string): ClipLocation | null {
    const timeline = this.timeline;
    if (this.store.isPerforming) return scanForClip(timeline, id);
    if (this.locationCache?.timeline !== timeline) {
      const index = new Map<string, ClipLocation>();
      timeline.tracks.forEach((track, trackIndex) =>
        track.clips.forEach((clip, clipIndex) => index.set(clip.id, { trackIndex, clipIndex })),
      );
      this.locationCache = { timeline, index };
    }
    return this.locationCache.index.get(id) ?? null;
  }

  clipFor(id: string): Clip | null {
    const loc = this.findClip(id);
    return loc ? this.timeline.tracks[loc.trackIndex].clips[loc.clipIndex] : null;
  }

  sortClips(trackIndex: number): void {
    this.timeline.tracks[trackIndex].clips.sort((a, b) => a.startFrame - b.startFrame);
  }

  showToast(message: string, kind: Toast["kind"] = "info"): void {
    this.toastSequence += 1;
    this.ui.toast = { id: this.toastSequence, message, kind };
  }

  refuseWithToast(reason: string): void {
    this.showToast(reason, "error");
  }

  private pruneSelection(): void {
    const ids = new Set<string>();
    for (const track of this.timeline.tracks) for (const clip of track.clips) ids.add(clip.id);
    const kept = [...this.ui.selectedClipIds].filter((id) => ids.has(id));
    if (kept.length !== this.ui.selectedClipIds.size) this.ui.selectedClipIds = new Set(kept);
    this.ui.selectedGap = null;
  }
}

function scanForClip(timeline: Timeline, id: string): ClipLocation | null {
  for (let trackIndex = 0; trackIndex < timeline.tracks.length; trackIndex++) {
    const clipIndex = timeline.tracks[trackIndex].clips.findIndex((c) => c.id === id);
    if (clipIndex >= 0) return { trackIndex, clipIndex };
  }
  return null;
}
