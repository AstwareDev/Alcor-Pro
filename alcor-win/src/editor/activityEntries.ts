import type { ClipType, MediaAsset } from "../model";
import { swiftDateToJsDate } from "../model";
import { costForGenerationInput, formatUsd } from "../generation/costEstimator";
import { modelDisplayName } from "../generation/catalog";

export type ProjectActivityKind = "generation" | "failed" | "refund" | "inProgress";

export interface ProjectActivityEntry {
  id: string;
  kind: ProjectActivityKind;
  type: ClipType;
  model: string;
  cost: string;
  /** Epoch ms; undefined for assets saved before creation dates were recorded. */
  at: number | undefined;
}

const maxEntries = 60;

/** Recent generations of the project, newest first (the backend activity list, rebuilt from local manifests). */
export function projectActivityEntries(assets: readonly MediaAsset[]): ProjectActivityEntry[] {
  const out: ProjectActivityEntry[] = [];
  for (const a of assets) {
    const g = a.generationInput;
    if (!g) continue;
    const refunded = g.refundedCredits ?? 0;
    const status = a.generationStatus.kind;
    const kind: ProjectActivityKind =
      status === "failed" ? "failed" : refunded > 0 ? "refund" : status === "none" ? "generation" : "inProgress";
    const cost =
      kind === "refund" ? `${refunded} credits refunded` :
      g.costCredits !== undefined ? `${g.costCredits} credits` :
      formatUsd(costForGenerationInput(g));
    out.push({
      id: a.id, kind, type: a.type, model: modelDisplayName(g.model), cost,
      at: g.createdAt === undefined ? undefined : swiftDateToJsDate(g.createdAt).getTime(),
    });
  }
  out.sort((x, y) => (y.at ?? -Infinity) - (x.at ?? -Infinity));
  return out.slice(0, maxEntries);
}

/** Abbreviated relative time ("now", "5m ago", "2h ago", "3d ago"). */
export function relativeTime(at: number | undefined, now: number): string {
  if (at === undefined) return "";
  const s = Math.max(0, Math.trunc((now - at) / 1000));
  if (s < 45) return "now";
  const m = Math.trunc(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.trunc(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.trunc(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.trunc(d / 30)}mo ago`;
}
