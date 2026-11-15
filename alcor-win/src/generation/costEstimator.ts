// Port of Catalog/CostEstimator.swift. Palmier credits become an optional USD estimate from `CatalogEntry.price`;
// every estimate is undefined when the model carries no price hint (the UI then shows nothing).
import type { GenerationInput } from "../model";
import { catalogEntry } from "./providers/registry";
import type { CatalogEntry, PriceHint } from "./providers/types";
import { audioInputs, type AudioEntry, type ImageEntry, type UpscaleEntry, type VideoEntry } from "./modelConfig";

function resolvedRate(hint: { usd: number; byResolution?: Record<string, number> }, key: string | undefined): number {
  if (key !== undefined && hint.byResolution?.[key] !== undefined) return hint.byResolution[key];
  return hint.usd;
}

function positive(usd: number): number | undefined {
  return Number.isFinite(usd) && usd > 0 ? usd : undefined;
}

export function videoCost(m: VideoEntry, p: { durationSeconds: number; resolution: string | undefined }): number | undefined {
  if (!(p.durationSeconds > 0)) return undefined;
  const price = m.price;
  switch (price?.mode) {
    case "perSecond": return positive(resolvedRate(price, p.resolution) * p.durationSeconds);
    case "flat": return positive(price.usd);
    default: return undefined;
  }
}

export function imageCost(
  m: ImageEntry,
  p: { resolution: string | undefined; numImages?: number },
): number | undefined {
  const price = m.price;
  const count = Math.max(1, p.numImages ?? 1);
  switch (price?.mode) {
    case "perImage": return positive(resolvedRate(price, p.resolution) * count);
    case "flat": return positive(price.usd * count);
    default: return undefined;
  }
}

export function audioCost(
  m: AudioEntry,
  p: { prompt: string; durationSeconds: number | undefined },
): number | undefined {
  const price: PriceHint | undefined = m.price;
  switch (price?.mode) {
    case "perThousandChars": {
      const chars = Array.from(p.prompt).length;
      return chars > 0 ? positive(price.usd * (chars / 1000)) : undefined;
    }
    case "perSecond":
      return p.durationSeconds !== undefined && p.durationSeconds > 0 ? positive(price.usd * p.durationSeconds) : undefined;
    case "flat": return positive(price.usd);
    default: return undefined;
  }
}

export function upscaleCost(m: UpscaleEntry, p: { durationSeconds: number; isImage?: boolean }): number | undefined {
  const d = Math.max(1, p.durationSeconds);
  const price = m.price;
  switch (price?.mode) {
    case "perSecond": return positive(price.usd * (p.isImage ? 1 : d));
    case "perImage":
    case "flat": return positive(price.usd);
    default: return undefined;
  }
}

/** Recompute from a stored `GenerationInput`. Used on rerun. */
export function costForGenerationInput(input: GenerationInput, entry: CatalogEntry | undefined = catalogEntry(input.model)): number | undefined {
  if (!entry) return undefined;
  switch (entry.kind) {
    case "video": return videoCost(entry, { durationSeconds: input.duration, resolution: input.resolution });
    case "image": return imageCost(entry, { resolution: input.resolution, numImages: input.numImages });
    case "audio": {
      const needsDuration = entry.uiCapabilities.durations !== undefined || entry.uiCapabilities.durationRange !== undefined ||
        audioInputs(entry).some((i) => i !== "text");
      return audioCost(entry, { prompt: input.prompt, durationSeconds: needsDuration ? input.duration : undefined });
    }
    case "upscale": return upscaleCost(entry, { durationSeconds: input.duration });
  }
}

export function formatUsd(usd: number | undefined): string {
  if (usd === undefined) return "—";
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function localizedEstimate(usd: number): string {
  return `${formatUsd(usd)} estimated. Actual billing may differ.`;
}

export function localizedGenerateLabel(usd: number | undefined): string {
  return usd === undefined ? "Generate" : `Generate · ${formatUsd(usd)}`;
}
