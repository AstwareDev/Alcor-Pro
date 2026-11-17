// Word timestamps from cross-attention (openai/whisper timing.py find_alignment): normalise the alignment heads,
// median filter, average, then dynamic time warping of tokens onto 20 ms encoder frames.

/** Seconds per encoder frame. */
export const whisperFrameSeconds = 0.02;

const filterWidth = 7;

/** In-place median filter along the last axis of a [rows][cols] matrix with reflect padding. */
export function medianFilterRows(m: Float32Array, rows: number, cols: number, width = filterWidth): void {
  const pad = width >> 1;
  if (cols <= pad) return;
  const src = new Float32Array(cols + 2 * pad);
  const win = new Float32Array(width);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let i = 0; i < pad; i++) src[i] = m[base + pad - i] as number;
    for (let i = 0; i < cols; i++) src[pad + i] = m[base + i] as number;
    for (let i = 0; i < pad; i++) src[pad + cols + i] = m[base + cols - 2 - i] as number;
    for (let c = 0; c < cols; c++) {
      for (let k = 0; k < width; k++) win[k] = src[c + k] as number;
      win.sort();
      m[base + c] = win[pad] as number;
    }
  }
}

/** Standardises each column over the token axis, as `(w - mean) / std` of the reference (population std). */
export function standardizeColumns(m: Float32Array, rows: number, cols: number): void {
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    for (let r = 0; r < rows; r++) sum += m[r * cols + c] as number;
    const mean = sum / rows;
    let sq = 0;
    for (let r = 0; r < rows; r++) sq += ((m[r * cols + c] as number) - mean) ** 2;
    const std = Math.max(Math.sqrt(sq / rows), 1e-6);
    for (let r = 0; r < rows; r++) m[r * cols + c] = ((m[r * cols + c] as number) - mean) / std;
  }
}

/** Monotonic path through a [rows][cols] cost matrix (reference `dtw_cpu`): the matched (row, col) pairs. */
export function dynamicTimeWarp(cost: Float32Array, rows: number, cols: number): { rows: Int32Array; cols: Int32Array } {
  const w = cols + 1;
  const acc = new Float32Array((rows + 1) * w).fill(Infinity);
  const trace = new Int8Array((rows + 1) * w).fill(-1);
  acc[0] = 0;
  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= cols; j++) {
      const diag = acc[(i - 1) * w + j - 1] as number;
      const up = acc[(i - 1) * w + j] as number;
      const left = acc[i * w + j - 1] as number;
      let best = diag;
      let t = 0;
      if (up < best) {
        best = up;
        t = 1;
      }
      if (left < best) {
        best = left;
        t = 2;
      }
      acc[i * w + j] = (cost[(i - 1) * cols + j - 1] as number) + best;
      trace[i * w + j] = t;
    }
  }
  for (let j = 0; j <= cols; j++) trace[j] = 2;
  for (let i = 0; i <= rows; i++) trace[i * w] = 1;
  const outRows: number[] = [];
  const outCols: number[] = [];
  let i = rows;
  let j = cols;
  while (i > 0 || j > 0) {
    outRows.push(i - 1);
    outCols.push(j - 1);
    const t = trace[i * w + j];
    if (t === 0) {
      i -= 1;
      j -= 1;
    } else if (t === 1) i -= 1;
    else j -= 1;
  }
  return { rows: Int32Array.from(outRows.reverse()), cols: Int32Array.from(outCols.reverse()) };
}

/**
 * `heads`: one [rows][cols] attention matrix per alignment head, where row r is the decoder position that predicts
 * text token r (row 0 = the last prompt token, row n = the last text token) and cols are encoder frames.
 * Returns the start time in seconds of each row: row r begins token r, row n begins the end of text.
 */
export function rowStartTimes(heads: readonly Float32Array[], rows: number, cols: number): Float32Array {
  const mean = new Float32Array(rows * cols);
  for (const head of heads) {
    const m = head.slice();
    standardizeColumns(m, rows, cols);
    medianFilterRows(m, rows, cols);
    for (let i = 0; i < m.length; i++) mean[i] = (mean[i] as number) + (m[i] as number) / heads.length;
  }
  for (let i = 0; i < mean.length; i++) mean[i] = -(mean[i] as number);
  const path = dynamicTimeWarp(mean, rows, cols);
  const starts = new Float32Array(rows);
  let prev = -1;
  for (let k = 0; k < path.rows.length; k++) {
    const row = path.rows[k] as number;
    if (row !== prev) {
      starts[row] = (path.cols[k] as number) * whisperFrameSeconds;
      prev = row;
    }
  }
  return starts;
}

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

const endsSentence = (text: string): boolean => /[.。!！?？]$/u.test(text);

/**
 * Words from per-row start times. A word spans rows `from` (its first token) to `to` (one past its last token), so it
 * ends where the next row begins (reference `add_word_timestamps`, including its trimming of overlong words next to a
 * sentence end).
 */
export function timedWords(words: readonly { text: string; from: number; to: number }[], starts: Float32Array): TimedWord[] {
  const out: TimedWord[] = words.map((w) => {
    const start = starts[w.from] as number;
    // A word the path crosses in one jump still occupies a frame (zero-length words vanish from word cuts).
    return { text: w.text, start, end: Math.max(starts[w.to] as number, start + whisperFrameSeconds) };
  });
  const durations = out.map((w) => w.end - w.start).filter((d) => d > 0).sort((a, b) => a - b);
  if (durations.length === 0) return out;
  const mid = durations.length >> 1;
  const median = durations.length % 2 === 1 ? (durations[mid] as number) : ((durations[mid - 1] as number) + (durations[mid] as number)) / 2;
  const longest = median * 2;
  for (let i = 1; i < out.length; i++) {
    const w = out[i] as TimedWord;
    if (w.end - w.start <= longest) continue;
    if (endsSentence(w.text)) w.end = w.start + longest;
    else if (endsSentence((out[i - 1] as TimedWord).text)) w.start = w.end - longest;
  }
  return out;
}
