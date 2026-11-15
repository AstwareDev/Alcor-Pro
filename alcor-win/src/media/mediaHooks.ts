import type { MediaAsset } from "../model";
import type { LottieMeta } from "./mediaTypes";

/*
 * Extension points for Swift features that do not exist in this port yet. Every callback is optional;
 * when unset the library does nothing in its place.
 */
export interface MediaHooks {
  /** `SubtitleFileParser.parseFile`: duration in seconds = latest cue end. Undefined if the file cannot be parsed. */
  parseSubtitleDuration?: (path: string) => Promise<number | undefined>;
  /** `LottieVideoGenerator.inspect` for `.lottie` zip archives (plain `.json` is read directly). */
  inspectLottie?: (path: string) => Promise<LottieMeta | undefined>;
  /** `searchIndex.schedule(asset)` after metadata finalization. */
  scheduleSearchIndex?: (asset: MediaAsset) => void;
  /** `closePreviewTab(id: PreviewTab.mediaAssetTabId(for:))` for every removed asset. */
  closeAssetPreviewTabs?: (assetIds: ReadonlySet<string>) => void;
  /** `refreshPreviewForFinalizedAsset`: rebuild the composition / source preview if the asset is in use. */
  assetFinalized?: (asset: MediaAsset) => void;
  /** `notifyTimelineChanged()` after clips were removed by an asset or folder delete. */
  timelineChanged?: () => void;
  /** Relink side effects: `denoiseFailed/denoiseBaked.remove`, `speakerAssignments.removeValue`. */
  assetRelinked?: (assetId: string) => void;
}

export const mediaHooks: MediaHooks = {};
