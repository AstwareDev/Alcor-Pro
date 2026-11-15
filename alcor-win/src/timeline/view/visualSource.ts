import type { BeatAnalysis } from "../../beats/beatInference";
import { beatStore, onBeatsChanged } from "../../beats/beatState";
import type { MediaAsset } from "../../model";
import { getFilmstrip, getImageThumbnail, isBitmapLive, peekPoster } from "../../media/thumbnails";
import { imageTileMaxPixelSize, timelineThumbnailMaxSize, videoThumbnailTimes } from "../../media/thumbnailMath";
import { getWaveform, peekWaveform } from "../../media/waveform";

// Port of the read side of MediaVisualCache: the clip renderer asks synchronously and gets undefined until the
// asynchronous load finishes; `onChange` then requests a redraw.

/** Whole-source thumbnail strip with uniformly spaced times (`thumbnails(for:)`). */
export interface ClipThumbnails {
  images: readonly (CanvasImageSource | null)[];
  startTime: number;
  spacing: number;
  /** width / height of the first frame */
  aspect: number;
}

export interface ImageTile {
  image: CanvasImageSource;
  aspect: number;
}

export interface TimelineVisualSource {
  thumbnails(asset: MediaAsset): ClipThumbnails | undefined;
  imageTile(asset: MediaAsset): ImageTile | undefined;
  /** dB-normalised peaks (0 = loud, 1 = silence) over the whole source. */
  waveform(asset: MediaAsset): Float32Array | undefined;
  /** Beat analysis for audio assets (hydrated from the disk cache on first ask; never runs detection). */
  beats?(asset: MediaAsset): BeatAnalysis | undefined;
}

interface FilmstripEntry {
  path: string;
  value?: ClipThumbnails;
  loading: boolean;
}

/** Backed by src/media; bitmaps are borrowed from its LRU, so evicted strips are re-requested on the next draw. */
export function makeMediaVisualSource(onChange: () => void): TimelineVisualSource {
  const filmstrips = new Map<string, FilmstripEntry>();
  const failed = new Set<string>();
  const pendingImages = new Set<string>();
  const pendingWaveforms = new Set<string>();
  const hydratedBeats = new Set<string>();
  onBeatsChanged(onChange);

  const loadFilmstrip = (asset: MediaAsset, entry: FilmstripEntry): void => {
    const times = videoThumbnailTimes(asset.duration);
    if (times.length === 0) return;
    const spacing = times.length > 1 ? (times[1] as number) - (times[0] as number) : 2;
    entry.loading = true;
    // Tile midpoints of [-s/2, n*s - s/2) land exactly on the Swift times 0, s, 2s, ...
    getFilmstrip(asset.url, {
      sourceStart: -spacing / 2,
      sourceEnd: times.length * spacing - spacing / 2,
      count: times.length,
      height: timelineThumbnailMaxSize.height,
    })
      .then((bitmaps) => {
        entry.loading = false;
        const first = bitmaps.find((b): b is ImageBitmap => b !== null);
        if (!first) {
          failed.add(asset.url);
          return;
        }
        entry.value = { images: bitmaps, startTime: 0, spacing, aspect: first.width / first.height };
        onChange();
      })
      .catch(() => {
        entry.loading = false;
        failed.add(asset.url);
      });
  };

  return {
    beats(asset) {
      const known = beatStore.analysis(asset.id);
      if (known || hydratedBeats.has(asset.id) || !(asset.type === "audio" || (asset.type === "video" && asset.hasAudio))) return known;
      hydratedBeats.add(asset.id);
      void beatStore.hydrate(asset);
      return undefined;
    },
    thumbnails(asset) {
      if (asset.type !== "video" || failed.has(asset.url)) return undefined;
      let entry = filmstrips.get(asset.id);
      if (!entry || entry.path !== asset.url) {
        entry = { path: asset.url, loading: false };
        filmstrips.set(asset.id, entry);
      }
      const value = entry.value;
      if (value && value.images.every((b) => b === null || isBitmapLive(b as ImageBitmap))) return value;
      entry.value = undefined;
      if (!entry.loading) loadFilmstrip(asset, entry);
      return undefined;
    },
    imageTile(asset) {
      const bitmap = peekPoster(asset.url, imageTileMaxPixelSize);
      if (bitmap && isBitmapLive(bitmap)) return { image: bitmap, aspect: bitmap.width / bitmap.height };
      if (!pendingImages.has(asset.url) && !failed.has(asset.url)) {
        pendingImages.add(asset.url);
        getImageThumbnail(asset.url)
          .then((b) => {
            if (!b) failed.add(asset.url);
            else onChange();
          })
          .catch(() => failed.add(asset.url))
          .finally(() => pendingImages.delete(asset.url));
      }
      return undefined;
    },
    waveform(asset) {
      const peaks = peekWaveform(asset.url);
      if (peaks) return peaks;
      if (!pendingWaveforms.has(asset.url) && !failed.has(asset.url)) {
        pendingWaveforms.add(asset.url);
        getWaveform(asset.url)
          .then((p) => {
            if (!p) failed.add(asset.url);
            else onChange();
          })
          .catch(() => failed.add(asset.url))
          .finally(() => pendingWaveforms.delete(asset.url));
      }
      return undefined;
    },
  };
}
