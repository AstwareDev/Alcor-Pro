// Whisper multilingual tokenizer, decode side only: token ids -> bytes -> words (openai/whisper tokenizer.py).

export const whisperTokens = {
  eot: 50257,
  sot: 50258,
  transcribe: 50359,
  noSpeech: 50362,
  noTimestamps: 50363,
  timestampBegin: 50364,
} as const;

/** Ids below this are ordinary text tokens; everything above is a special or timestamp token. */
export const whisperTextTokenLimit = whisperTokens.eot;

/** GPT-2 byte-level BPE: printable stand-in characters back to raw bytes. */
function byteDecoder(): Map<string, number> {
  const keep: number[] = [];
  for (let b = 33; b <= 126; b++) keep.push(b);
  for (let b = 161; b <= 172; b++) keep.push(b);
  for (let b = 174; b <= 255; b++) keep.push(b);
  const map = new Map<string, number>();
  for (const b of keep) map.set(String.fromCodePoint(b), b);
  let extra = 0;
  for (let b = 0; b < 256; b++) if (!keep.includes(b)) map.set(String.fromCodePoint(256 + extra++), b);
  return map;
}

/** Id -> token bytes for the text tokens of `vocab.json` (token string -> id). */
export function tokenBytesFromVocab(vocab: Readonly<Record<string, number>>): Uint8Array[] {
  const chars = byteDecoder();
  const out: Uint8Array[] = new Array<Uint8Array>(whisperTextTokenLimit).fill(new Uint8Array(0));
  for (const [token, id] of Object.entries(vocab)) {
    if (id >= whisperTextTokenLimit) continue;
    const bytes = new Uint8Array([...token].map((c) => chars.get(c) ?? 63));
    out[id] = bytes;
  }
  return out;
}

export interface TokenWord {
  /** Trimmed text, punctuation attached to the word it belongs to. */
  text: string;
  /** Number of tokens in the word (word boundaries for the aligner). */
  tokens: number;
}

/** Languages written without spaces: each character is a word. */
const unspacedLanguages = new Set(["zh", "ja", "th", "lo", "my", "yue"]);

const strictDecoder = new TextDecoder("utf-8", { fatal: true });
const looseDecoder = new TextDecoder("utf-8");

/** Groups tokens so every group is valid UTF-8 (a character may be split over several byte tokens). */
function splitOnUnicode(ids: readonly number[], bytes: readonly Uint8Array[]): { text: string; tokens: number }[] {
  const groups: { text: string; tokens: number }[] = [];
  let pending: number[] = [];
  let count = 0;
  const flush = (): void => {
    if (count === 0) return;
    groups.push({ text: looseDecoder.decode(new Uint8Array(pending)), tokens: count });
    pending = [];
    count = 0;
  };
  for (const id of ids) {
    pending.push(...((bytes[id] as Uint8Array | undefined) ?? []));
    count += 1;
    let valid = true;
    try {
      strictDecoder.decode(new Uint8Array(pending));
    } catch {
      valid = false;
    }
    if (valid || count >= 4) flush();
  }
  flush();
  return groups;
}

/** Splits decoded text tokens into words: at a leading space, or per character for unspaced languages. */
export function splitWords(ids: readonly number[], bytes: readonly Uint8Array[], language: string | undefined): TokenWord[] {
  const groups = splitOnUnicode(ids, bytes);
  const unspaced = language !== undefined && unspacedLanguages.has(language);
  const words: { text: string; tokens: number }[] = [];
  for (const g of groups) {
    const last = words[words.length - 1];
    if (last === undefined || unspaced || g.text.startsWith(" ")) words.push({ text: g.text, tokens: g.tokens });
    else {
      last.text += g.text;
      last.tokens += g.tokens;
    }
  }
  return words.map((w) => ({ text: w.text.trim(), tokens: w.tokens }));
}

/** Stops degenerate loops: true when the tail of `ids` is one short pattern repeated many times. */
export function isRepeating(ids: readonly number[], maxPattern = 6, repeats = 5): boolean {
  for (let p = 1; p <= maxPattern; p++) {
    const need = p * repeats;
    if (ids.length < need) break;
    let same = true;
    for (let i = ids.length - need + p; i < ids.length && same; i++) same = ids[i] === ids[i - p];
    if (same) return true;
  }
  return false;
}
