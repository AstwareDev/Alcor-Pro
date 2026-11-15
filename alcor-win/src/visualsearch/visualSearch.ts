// Port of Search/Query/VisualSearch.swift: text-to-image ranking over cached frame embeddings.
import type { AssetIndex } from "./embeddingStore";

export interface VisualHit {
  assetID: string;
  time: number;
  shotStart: number;
  shotEnd: number;
  score: number;
}

/** `SearchIndexConfig.visualMatchCosineFloor`: hits scoring below this never surface. */
export const visualMatchCosineFloor = 0.05;

export function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] as number) ** 2;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / norm;
  return out;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface SearchOptions {
  limit?: number;
  relativeCutoff?: number;
  minScore?: number;
}

/** Top hits across assets, best frame per shot. Vectors are unit length, so the score is a plain dot product. */
export function searchIndexes(
  query: Float32Array,
  indexes: readonly { assetID: string; index: AssetIndex }[],
  { limit = 20, relativeCutoff = 0.85, minScore }: SearchOptions = {},
): VisualHit[] {
  let hits: VisualHit[] = [];
  for (const { assetID, index } of indexes) {
    const { dim, count } = index.header;
    if (dim !== query.length || count === 0) continue;
    const bestPerShot = new Map<number, { row: number; score: number }>();
    for (let i = 0; i < count; i++) {
      let score = 0;
      const base = i * dim;
      for (let d = 0; d < dim; d++) score += (index.vectors[base + d] as number) * (query[d] as number);
      const shot = (index.rows[i] as { shotStart: number }).shotStart;
      const existing = bestPerShot.get(shot);
      if (existing && existing.score >= score) continue;
      bestPerShot.set(shot, { row: i, score });
    }
    for (const best of bestPerShot.values()) {
      const row = index.rows[best.row] as AssetIndex["rows"][number];
      hits.push({ assetID, time: row.time, shotStart: row.shotStart, shotEnd: row.shotEnd, score: best.score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  if (minScore !== undefined) hits = hits.filter((h) => h.score >= minScore);
  const top = hits[0]?.score;
  if (top === undefined || !(top > 0)) return [];
  const floor = top * relativeCutoff;
  return hits.slice(0, limit).filter((h) => h.score >= floor);
}
