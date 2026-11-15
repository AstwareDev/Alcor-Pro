// SigLIP text tokenizer: the google/siglip SentencePiece Unigram model (read from the pinned `tokenizer.json`), with the
// reference preprocessing (underscores and ASCII punctuation dropped, lowercase, whitespace collapsed). Sequences end in
// `</s>` and are padded with `</s>` to the context length with no attention mask (port of Search/Models/TextTokenizer.swift).

export interface UnigramVocab {
  /** [piece, log-probability] in id order. */
  vocab: readonly (readonly [string, number])[];
  unkId: number;
}

const eosId = 1;
const unkPenalty = 10;
const bytePiece = /^<0x[0-9A-F]{2}>$/;
const space = "\u2581";

export class SiglipTokenizer {
  private readonly ids = new Map<string, number>();
  private readonly scores: number[] = [];
  private readonly maxPiece: number;
  private readonly unkId: number;
  private readonly unkScore: number;

  constructor(model: UnigramVocab, readonly contextLength: number) {
    this.unkId = model.unkId;
    let min = 0;
    let longest = 1;
    model.vocab.forEach(([piece, score], id) => {
      this.scores.push(score);
      if (id <= eosId || id === model.unkId || bytePiece.test(piece)) return;
      this.ids.set(piece, id);
      min = Math.min(min, score);
      longest = Math.max(longest, Array.from(piece).length);
    });
    this.maxPiece = longest;
    this.unkScore = min - unkPenalty;
  }

  static fromJSON(json: string, contextLength: number): SiglipTokenizer {
    const parsed = JSON.parse(json) as { model?: { type?: string; vocab?: [string, number][]; unk_id?: number } };
    const model = parsed.model;
    if (model?.type !== "Unigram" || !model.vocab) throw new Error("tokenizer.json is not a Unigram model.");
    return new SiglipTokenizer({ vocab: model.vocab, unkId: model.unk_id ?? 2 }, contextLength);
  }

  /** Reference text canonicalisation, then SentencePiece NFKC. */
  static normalize(text: string): string {
    const canonical = text
      .replace(/_/g, " ")
      .replace(/[!-/:-@[-`{-~]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    return canonical.normalize("NFKC");
  }

  /** Best segmentation (Viterbi) of the normalised text, without the end token. */
  pieces(text: string): number[] {
    const normalized = SiglipTokenizer.normalize(text);
    if (normalized === "") return [];
    const chars = Array.from(space + normalized.replace(/ /g, space));
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    const piece = new Int32Array(n + 1);
    best[0] = 0;
    for (let end = 1; end <= n; end++) {
      for (let len = 1; len <= Math.min(this.maxPiece, end); len++) {
        const start = end - len;
        const prev = best[start] as number;
        if (prev === -Infinity) continue;
        const id = this.ids.get(chars.slice(start, end).join(""));
        const score = id === undefined ? (len === 1 ? this.unkScore : undefined) : this.scores[id];
        if (score === undefined) continue;
        if (prev + score > (best[end] as number)) {
          best[end] = prev + score;
          from[end] = start;
          piece[end] = id ?? this.unkId;
        }
      }
    }
    const out: number[] = [];
    for (let at = n; at > 0; at = from[at] as number) out.push(piece[at] as number);
    return out.reverse();
  }

  /** `contextLength` ids: pieces (truncated to leave room for `</s>`), `</s>`, then `</s>` padding. */
  tokenize(text: string): Int32Array {
    const ids = this.pieces(text).slice(0, this.contextLength - 1);
    const out = new Int32Array(this.contextLength).fill(eosId);
    out.set(ids, 0);
    return out;
  }
}
