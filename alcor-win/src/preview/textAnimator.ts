import { smoothstep } from "../model/keyframe";
import { textAnimationDefaultHighlight, type TextAnimation, type WordTiming } from "../model/textAnimation";
import type { RGBA } from "../model/textStyle";

/** Pure per-frame evaluator for text animation. */
export interface TextClipState {
  opacity: number;
  scale: number;
  /** Vertical offset as a fraction of render height (positive = down). */
  dy: number;
}

export const textClipStateIdentity: Readonly<TextClipState> = { opacity: 1, scale: 1, dy: 0 };

export interface TextWordState {
  opacity: number;
  scale: number;
  dy: number;
  color: RGBA;
  bgColor?: RGBA;
}

function wordState(color: RGBA, p: Partial<Omit<TextWordState, "color">> = {}): TextWordState {
  const s: TextWordState = { opacity: p.opacity ?? 1, scale: p.scale ?? 1, dy: p.dy ?? 0, color };
  if (p.bgColor !== undefined) s.bgColor = p.bgColor;
  return s;
}

/** Whole-clip entrance. Non-entrance presets return identity. */
export function textAnimatorClipEntry(anim: TextAnimation, rel: number): TextClipState {
  const dur = Math.max(1, anim.perWordFrames);
  const t = progress(rel, 0, dur);
  switch (anim.preset) {
    case "popIn": return { opacity: t, scale: 0.6 + 0.4 * t, dy: 0 };
    case "slideUp": return { opacity: t, scale: 1, dy: 0.05 * (1 - t) };
    default: return { ...textClipStateIdentity };
  }
}

/** Per-word state. `base` is the clip's static text color. */
export function textAnimatorWordState(
  anim: TextAnimation,
  word: WordTiming,
  nextWord: WordTiming | undefined,
  rel: number,
  base: RGBA,
): TextWordState {
  const highlight = anim.highlight ?? textAnimationDefaultHighlight();
  const hand = Math.max(1, anim.perWordFrames);
  switch (anim.preset) {
    case "wordReveal": {
      const t = progress(rel, word.startFrame, hand);
      return wordState(activeTint(anim, word, rel, base), { opacity: t });
    }
    case "wordSlide": {
      const t = progress(rel, word.startFrame, hand);
      return wordState(activeTint(anim, word, rel, base), { opacity: t, dy: 0.5 * (1 - t) });
    }
    case "highlightPop": {
      const on = heldHighlightAmount(rel, word, nextWord, Math.min(hand, 4));
      return wordState(lerp(base, highlight, on));
    }
    case "highlightBlock": {
      const on = heldHighlightAmount(rel, word, nextWord, Math.min(hand, 4));
      return wordState(base, { bgColor: { ...highlight, a: highlight.a * on } });
    }
    default:
      return wordState(base);
  }
}

/** Tints the active word if a highlight is set. */
function activeTint(anim: TextAnimation, word: WordTiming, rel: number, base: RGBA): RGBA {
  const hl = anim.highlight;
  if (!hl) return base;
  return lerp(base, hl, activeRamp(rel, word, Math.max(1, anim.perWordFrames)));
}

function heldHighlightAmount(rel: number, word: WordTiming, nextWord: WordTiming | undefined, ramp: number): number {
  if (rel < word.startFrame) return 0;
  const inDuration = rampDuration(word, ramp);
  const rampIn = inDuration !== undefined
    ? smoothstep(Math.min(1, (rel - word.startFrame) / inDuration))
    : 1;
  if (!nextWord || rel < nextWord.startFrame) return rampIn;
  const outDuration = rampDuration(nextWord, ramp);
  if (outDuration === undefined) return 0;
  const rampOut = smoothstep(1 - Math.min(1, (rel - nextWord.startFrame) / outDuration));
  return Math.min(rampIn, rampOut);
}

/** Eased 0→1 ramp across `dur` frames starting at `start`. */
function progress(rel: number, start: number, dur: number): number {
  return smoothstep(linear(rel, start, dur));
}

function linear(rel: number, start: number, dur: number): number {
  if (!(rel > start)) return 0;
  if (!(rel < start + dur)) return 1;
  return (rel - start) / dur;
}

/** 0 outside the active span, with the ramp shortened so fast words reach 1. */
function activeRamp(rel: number, word: WordTiming, ramp: number): number {
  if (!(rel >= word.startFrame && rel < word.endFrame)) return 0;
  const r = rampDuration(word, ramp);
  if (r === undefined) return 1;
  const rampIn = smoothstep(Math.min(1, (rel - word.startFrame) / r));
  const rampOut = smoothstep(Math.min(1, (word.endFrame - rel) / r));
  return Math.min(rampIn, rampOut);
}

function rampDuration(word: WordTiming, maximum: number): number | undefined {
  const span = word.endFrame - word.startFrame;
  if (!Number.isSafeInteger(span) || !(span > 1)) return undefined;
  return Math.min(Math.max(1, maximum), Math.max(1, Math.trunc(span / 2)));
}

function lerp(a: RGBA, b: RGBA, t0: number): RGBA {
  const t = Math.min(1, Math.max(0, t0));
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}
