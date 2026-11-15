import type { Rect, Size } from "../model/geometry";
import type { WordTiming } from "../model/textAnimation";
import { textLayoutMeasurementText, textLayoutReferenceCanvasHeight, type TextMeasurer } from "../model/textLayout";
import {
  textStyleDrawsGlyphOutline, textStyleGlyphBorderPadding, type RGBA, type TextAlignment, type TextStyle,
} from "../model/textStyle";
import type { TextLayer } from "./frameGraph";
import type { TextWordState } from "./textAnimator";

// MARK: - Tokens and timings (pure parts of TextFrameRenderer)

export interface TextToken {
  /** UTF-16 offset into the display text. */
  start: number;
  length: number;
  text: string;
}

const whitespaceOrNewline = /^[\t\n\v\f\r\u0085\u2028\u2029\p{Zs}]$/u;
const alphanumeric = /[\p{L}\p{M}\p{N}]/u;

/** Whitespace-separated words over UTF-16 units; a surrogate half counts as part of a word. */
export function textWords(content: string): TextToken[] {
  const isSpace = (i: number): boolean => whitespaceOrNewline.test(content.charAt(i));
  const result: TextToken[] = [];
  let i = 0;
  while (i < content.length) {
    while (i < content.length && isSpace(i)) i += 1;
    if (i >= content.length) break;
    const start = i;
    while (i < content.length && !isSpace(i)) i += 1;
    result.push({ start, length: i - start, text: content.slice(start, i) });
  }
  return result;
}

/** One timing per token, aligning transcript spans when token counts differ. */
export function textTokenTimings(tokens: readonly TextToken[], words: readonly WordTiming[] | undefined, duration: number): WordTiming[] {
  if (tokens.length === 0) return [];
  if (!words || words.length === 0) return evenTokenTimings(tokens, duration);
  if (words.length === tokens.length) {
    return tokens.map((token, i) => clampedTiming(words[i] as WordTiming, token.text, duration));
  }
  return alignedTokenTimings(tokens, words, duration) ?? evenTokenTimings(tokens, duration);
}

function evenTokenTimings(tokens: readonly TextToken[], duration0: number): WordTiming[] {
  const duration = Math.max(0, duration0);
  const n = Math.max(1, tokens.length);
  return tokens.map((t, i) => ({
    text: t.text,
    startFrame: Math.trunc((duration * i) / n),
    endFrame: Math.trunc((duration * (i + 1)) / n),
  }));
}

function alignedTokenTimings(tokens: readonly TextToken[], words: readonly WordTiming[], duration: number): WordTiming[] | undefined {
  const result: WordTiming[] = [];
  let tokenIndex = 0;
  let wordIndex = 0;
  while (tokenIndex < tokens.length && wordIndex < words.length) {
    const group = nextAlignedTimingGroup(tokens, words, tokenIndex, wordIndex);
    if (!group) return undefined;
    result.push(...timingsForAlignedGroup(tokens, words, group, duration));
    tokenIndex = group.tokenEnd;
    wordIndex = group.wordEnd;
  }
  if (tokenIndex !== tokens.length || wordIndex !== words.length || result.length !== tokens.length) return undefined;
  return result;
}

interface AlignmentGroup {
  tokenStart: number;
  tokenEnd: number;
  wordStart: number;
  wordEnd: number;
}

function graphemeLength(s: string): number {
  return Array.from(s).length;
}

function nextAlignedTimingGroup(
  tokens: readonly TextToken[], words: readonly WordTiming[], tokenStart: number, wordStart: number,
): AlignmentGroup | undefined {
  let tokenEnd = tokenStart;
  let wordEnd = wordStart;
  let tokenText = "";
  let wordText = "";
  while (tokenEnd < tokens.length || wordEnd < words.length) {
    const appendToken = wordEnd >= words.length
      ? true
      : tokenEnd >= tokens.length ? false : graphemeLength(tokenText) <= graphemeLength(wordText);
    if (appendToken) {
      tokenText += normalizedTimingText((tokens[tokenEnd] as TextToken).text);
      tokenEnd += 1;
    } else {
      wordText += normalizedTimingText((words[wordEnd] as WordTiming).text);
      wordEnd += 1;
    }
    if (tokenText !== "" && tokenText === wordText) return { tokenStart, tokenEnd, wordStart, wordEnd };
  }
  return undefined;
}

function timingsForAlignedGroup(
  tokens: readonly TextToken[], words: readonly WordTiming[], g: AlignmentGroup, duration: number,
): WordTiming[] {
  const tokenCount = g.tokenEnd - g.tokenStart;
  if (tokenCount === g.wordEnd - g.wordStart) {
    const out: WordTiming[] = [];
    for (let k = 0; k < tokenCount; k++) {
      out.push(clampedTiming(words[g.wordStart + k] as WordTiming, (tokens[g.tokenStart + k] as TextToken).text, duration));
    }
    return out;
  }
  const maxFrame = Math.max(0, duration);
  const start = Math.min(Math.max(0, (words[g.wordStart] as WordTiming).startFrame), maxFrame);
  const end = Math.min(Math.max(start, (words[g.wordEnd - 1] as WordTiming).endFrame), maxFrame);
  const span = Math.max(0, end - start);
  const out: WordTiming[] = [];
  for (let offset = 0; offset < tokenCount; offset++) {
    const tokenStart = start + Math.trunc((span * offset) / tokenCount);
    const tokenEnd = offset === tokenCount - 1 ? end : start + Math.trunc((span * (offset + 1)) / tokenCount);
    out.push({ text: (tokens[g.tokenStart + offset] as TextToken).text, startFrame: tokenStart, endFrame: tokenEnd });
  }
  return out;
}

function clampedTiming(timing: WordTiming, text: string, duration: number): WordTiming {
  const maxFrame = Math.max(0, duration);
  const start = Math.min(Math.max(0, timing.startFrame), maxFrame);
  const end = Math.min(Math.max(start, timing.endFrame), maxFrame);
  return { text, startFrame: start, endFrame: end };
}

function normalizedTimingText(text: string): string {
  let out = "";
  for (const ch of text) if (alphanumeric.test(ch)) out += ch.toLowerCase();
  return out;
}

const typewriterHoldFrames = 18;

/** Typewriter reveal: the visible prefix at clip-relative frame `rel`, with the blinking caret. */
export function textTypewriterVisibleText(
  content: string, wordTimings: readonly WordTiming[] | undefined, durationFrames: number, rel: number,
): string {
  const tokens = textWords(content);
  const timings = textTokenTimings(tokens, wordTimings, durationFrames);
  let visLen = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as TextToken;
    const t = timings[i] as WordTiming;
    let revealEnd: number;
    if (i === tokens.length - 1 && t.endFrame > t.startFrame) {
      const desiredHold = Math.min(typewriterHoldFrames, Math.max(1, Math.trunc(durationFrames / 3)));
      const existingHold = Math.max(1, durationFrames - t.endFrame + 1);
      const timingSpan = t.endFrame - t.startFrame;
      const minimumRevealFrames = Math.min(timingSpan - 1, tok.length) + 1;
      const availableHoldFrames = timingSpan - minimumRevealFrames;
      const extraHold = Math.min(Math.max(0, desiredHold - existingHold), availableHoldFrames);
      revealEnd = Math.max(t.startFrame + 1, t.endFrame - extraHold);
    } else {
      revealEnd = t.endFrame;
    }
    if (rel >= revealEnd) {
      visLen = tok.start + tok.length;
    } else if (rel >= t.startFrame) {
      const span = revealEnd - t.startFrame;
      const p = span === 1 ? 1 : (rel - t.startFrame) / (span - 1);
      visLen = tok.start + Math.floor(tok.length * p);
      break;
    } else {
      break;
    }
  }
  let visible = content.slice(0, Math.min(visLen, content.length));
  // Caret blinks (~0.5s) until shortly after the last word finishes.
  const doneAt = timings.length > 0 ? (timings[timings.length - 1] as WordTiming).endFrame : durationFrames;
  if (rel <= doneAt + typewriterHoldFrames && Math.trunc(rel / 15) % 2 === 0) visible += "|";
  return visible;
}

// MARK: - Geometry (top-left origin render pixels)

interface LayoutBoxes {
  text: Rect;
  background: Rect;
}

function boxRect(layer: TextLayer, size: Size): Rect {
  const t = layer.transform;
  const h = Math.max(1, t.height * size.height);
  return {
    x: (t.centerX - t.width / 2) * size.width,
    y: (t.centerY - t.height / 2) * size.height,
    width: Math.max(1, t.width * size.width),
    height: h,
  };
}

function layoutBoxes(style: TextStyle, box: Rect, renderSize: Size): LayoutBoxes {
  if (!style.background.enabled) return { text: box, background: box };
  const scale = renderSize.height / textLayoutReferenceCanvasHeight;
  const dx = Math.max(0, style.background.paddingX * scale);
  const dy = Math.max(0, style.background.paddingY * scale);
  const inset = { x: box.x + dx, y: box.y + dy, width: box.width - 2 * dx, height: box.height - 2 * dy };
  const text = inset.width >= 1 && inset.height >= 1
    ? inset
    : { x: box.x + box.width / 2 - 0.5, y: box.y + box.height / 2 - 0.5, width: 1, height: 1 };
  return { text, background: box };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function outset(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d };
}

function rasterBounds(style: TextStyle, boxes: LayoutBoxes, fontSize: number, renderSize: Size, wordMotion: boolean): Rect {
  const scale = renderSize.height / textLayoutReferenceCanvasHeight;
  let rect = union(boxes.text, boxes.background);
  if (style.background.enabled) {
    const stroke = (Math.max(0, style.background.outlineWidth) * scale) / 2;
    const b = boxes.background;
    rect = union(rect, outset(
      { x: b.x + style.background.offsetX * scale, y: b.y + style.background.offsetY * scale, width: b.width, height: b.height },
      stroke,
    ));
  }
  if (style.border.enabled && style.border.width > 0) rect = outset(rect, textStyleGlyphBorderPadding(style, fontSize));
  if (wordMotion) rect = outset(rect, fontSize);
  if (style.shadow.enabled) {
    const blur = Math.max(0, style.shadow.blur * scale);
    const dx = style.shadow.offsetX * scale;
    const dy = style.shadow.offsetY * scale;
    rect = {
      x: rect.x + Math.min(0, dx) - blur,
      y: rect.y + Math.min(0, dy) - blur,
      width: rect.width + Math.abs(dx) + blur * 2,
      height: rect.height + Math.abs(dy) + blur * 2,
    };
  }
  rect = outset(rect, 2);
  const x0 = Math.floor(rect.x), y0 = Math.floor(rect.y);
  return { x: x0, y: y0, width: Math.ceil(rect.x + rect.width) - x0, height: Math.ceil(rect.y + rect.height) - y0 };
}

// MARK: - Canvas text layout

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function context2d(canvas: AnyCanvas): Ctx2D {
  const ctx = canvas.getContext("2d") as Ctx2D | null;
  if (!ctx) throw new Error("Canvas 2D unavailable");
  return ctx;
}

function cssColor(c: RGBA): string {
  const ch = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${ch(c.r)},${ch(c.g)},${ch(c.b)},${Math.min(1, Math.max(0, c.a))})`;
}

function fontString(style: TextStyle, px: number): string {
  const family = style.fontName.replace(/["\\]/g, "");
  return `${style.isItalic ? "italic " : ""}${style.isBold ? "bold " : ""}${px}px "${family}", Helvetica, Arial, sans-serif`;
}

interface LineMetrics {
  font: string;
  px: number;
  kern: number;
  widthScale: number;
  heightScale: number;
  ascent: number;
  descent: number;
  lineHeight: number;
  spacing: number;
}

interface LaidLine {
  /** UTF-16 range of the line in the laid-out string. */
  start: number;
  end: number;
  text: string;
  /** Width without trailing whitespace. */
  width: number;
}

function lineMetrics(ctx: Ctx2D, style: TextStyle, px: number): LineMetrics {
  const font = fontString(style, px);
  ctx.font = font;
  ctx.letterSpacing = "0px";
  const m = ctx.measureText("Hg");
  const hs = style.heightScale;
  const ascent = (m.fontBoundingBoxAscent || px * 0.8) * hs;
  const descent = (m.fontBoundingBoxDescent || px * 0.2) * hs;
  const unit = Math.max(1, style.fontSize * style.fontScale);
  const spacing = (style.lineSpacing * px) / unit;
  return {
    font,
    px,
    kern: (style.tracking * px) / unit,
    widthScale: style.widthScale,
    heightScale: hs,
    ascent,
    descent,
    lineHeight: ascent + descent,
    spacing: Number.isFinite(spacing) ? spacing : 0,
  };
}

function measureWidth(ctx: Ctx2D, m: LineMetrics, s: string): number {
  if (s === "") return 0;
  return ctx.measureText(s).width * m.widthScale + m.kern * graphemeLength(s);
}

const trailingSpace = /[\t\u0085\p{Zs}]+$/u;
const breakChar = /[\t\u0085\p{Zs}]/u;

/** Word-wrapped lines (NSLineBreakMode.byWordWrapping); words wider than the box break by character. */
function layoutLines(ctx: Ctx2D, m: LineMetrics, text: string, maxWidth: number): LaidLine[] {
  ctx.font = m.font;
  ctx.letterSpacing = "0px";
  const lines: LaidLine[] = [];
  const pushLine = (start: number, end: number): void => {
    const t = text.slice(start, end);
    lines.push({ start, end, text: t, width: measureWidth(ctx, m, t.replace(trailingSpace, "")) });
  };
  const paragraphs = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;
  let paraStart = 0;
  const runParagraph = (start: number, end: number): void => {
    let lineStart = start;
    let i = start;
    while (i < end) {
      let wordEnd = i;
      while (wordEnd < end && breakChar.test(text.charAt(wordEnd))) wordEnd += 1;
      while (wordEnd < end && !breakChar.test(text.charAt(wordEnd))) wordEnd += 1;
      const candidate = text.slice(lineStart, wordEnd).replace(trailingSpace, "");
      if (measureWidth(ctx, m, candidate) <= maxWidth + 0.01 || i === lineStart) {
        if (i === lineStart && measureWidth(ctx, m, candidate) > maxWidth + 0.01) {
          // Character wrap for a word wider than the line.
          let j = lineStart + 1;
          while (j < wordEnd && measureWidth(ctx, m, text.slice(lineStart, j + 1).replace(trailingSpace, "")) <= maxWidth + 0.01) j += 1;
          if (j >= wordEnd) {
            i = wordEnd;
            continue;
          }
          pushLine(lineStart, j);
          lineStart = j;
          i = j;
          continue;
        }
        i = wordEnd;
        continue;
      }
      pushLine(lineStart, i);
      lineStart = i;
      while (lineStart < end && breakChar.test(text.charAt(lineStart)) && lineStart < i) lineStart += 1;
    }
    pushLine(lineStart, end);
  };
  let match: RegExpExecArray | null;
  while ((match = paragraphs.exec(text)) !== null) {
    runParagraph(paraStart, match.index);
    paraStart = match.index + match[0].length;
  }
  runParagraph(paraStart, text.length);
  return lines;
}

function contentHeight(m: LineMetrics, lineCount: number): number {
  return lineCount * m.lineHeight + Math.max(0, lineCount - 1) * m.spacing;
}

let measureCanvas: AnyCanvas | null = null;

function measureContext(): Ctx2D {
  measureCanvas ??= makeCanvas(1, 1);
  return context2d(measureCanvas);
}

/** Canvas 2D implementation of the model's `TextMeasurer` (bounding size of the wrapped text). */
export const canvasTextMeasurer: TextMeasurer = (text, style, renderSize, maxWidth) => {
  const ctx = measureContext();
  const m = lineMetrics(ctx, style, renderSize);
  const lines = layoutLines(ctx, m, text, maxWidth);
  let width = 0;
  for (const l of lines) width = Math.max(width, l.width);
  return { width, height: contentHeight(m, lines.length) };
};

interface PlacedLine extends LaidLine {
  x: number;
  baseline: number;
}

/** `TextLayout.frame`: lines in a frame vertically centred in `box`, height capped to the box. */
function frameLines(
  ctx: Ctx2D, m: LineMetrics, content: string, box: Rect, alignment: TextAlignment, sizingContent?: string,
): PlacedLine[] {
  const sizingLines = layoutLines(ctx, m, textLayoutMeasurementText(sizingContent ?? content), box.width);
  const frameHeight = Math.min(box.height, Math.ceil(contentHeight(m, sizingLines.length)));
  const top = box.y + box.height / 2 - frameHeight / 2;
  const lines = layoutLines(ctx, m, content, box.width);
  const placed: PlacedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as LaidLine;
    const lineTop = i * (m.lineHeight + m.spacing);
    if (lineTop + m.lineHeight > frameHeight + 0.5) break;
    const x = alignment === "left"
      ? box.x
      : alignment === "right" ? box.x + box.width - line.width : box.x + (box.width - line.width) / 2;
    placed.push({ ...line, x, baseline: top + lineTop + m.ascent });
  }
  return placed;
}

function drawLineGlyphs(ctx: Ctx2D, m: LineMetrics, text: string, x: number, baseline: number, mode: "fill" | "stroke"): void {
  ctx.save();
  ctx.translate(x, baseline);
  ctx.scale(m.widthScale, m.heightScale);
  ctx.letterSpacing = `${m.kern / (m.widthScale || 1)}px`;
  if (mode === "fill") ctx.fillText(text, 0, 0);
  else ctx.strokeText(text, 0, 0);
  ctx.restore();
}

function decorationThickness(m: LineMetrics): number {
  return Math.max(1, m.px / 14);
}

function drawDecorations(ctx: Ctx2D, style: TextStyle, m: LineMetrics, x: number, baseline: number, width: number, color: RGBA): void {
  if (!(width > 0)) return;
  const th = decorationThickness(m);
  ctx.fillStyle = cssColor(color);
  if (style.isUnderlined) ctx.fillRect(x, baseline + m.descent * 0.35, width, th);
  if (style.isStruckThrough) ctx.fillRect(x, baseline - m.ascent * 0.32 - th / 2, width, th);
  if (style.isOverlined) ctx.fillRect(x, baseline - m.ascent, width, th);
}

function strokeWidths(style: TextStyle, px: number): { undercoat: number; hollow: number } {
  const unit = Math.max(1, style.fontSize * style.fontScale);
  const bw = Math.max(0, style.border.width);
  return { undercoat: (px * 2 * bw) / unit, hollow: (px * bw) / unit };
}

/** Outlined text draws undercoat then fill as one group so the shadow applies once. */
function drawTextGlyphs(ctx: Ctx2D, style: TextStyle, m: LineMetrics, lines: readonly PlacedLine[]): void {
  const widths = strokeWidths(style, m.px);
  const outline = textStyleDrawsGlyphOutline(style);
  ctx.font = m.font;
  if (outline) {
    ctx.save();
    ctx.lineJoin = "round";
    ctx.strokeStyle = cssColor(style.border.color);
    ctx.lineWidth = widths.undercoat / Math.sqrt(m.widthScale * m.heightScale || 1);
    for (const l of lines) drawLineGlyphs(ctx, m, l.text, l.x, l.baseline, "stroke");
    ctx.restore();
  }
  ctx.fillStyle = cssColor(style.color);
  for (const l of lines) drawLineGlyphs(ctx, m, l.text, l.x, l.baseline, "fill");
  if (!outline && style.border.enabled && style.border.width > 0) {
    ctx.save();
    ctx.strokeStyle = cssColor(style.border.color);
    ctx.lineWidth = widths.hollow / Math.sqrt(m.widthScale * m.heightScale || 1);
    for (const l of lines) drawLineGlyphs(ctx, m, l.text, l.x, l.baseline, "stroke");
    ctx.restore();
  }
  for (const l of lines) drawDecorations(ctx, style, m, l.x, l.baseline, l.width, style.color);
}

function roundedRectPath(ctx: Ctx2D, r: Rect, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, radius);
}

function drawBox(ctx: Ctx2D, style: TextStyle, box: Rect, renderSize: Size): void {
  if (!style.background.enabled) return;
  const scale = renderSize.height / textLayoutReferenceCanvasHeight;
  const bg = style.background;
  const rect = { x: box.x + bg.offsetX * scale, y: box.y + bg.offsetY * scale, width: box.width, height: box.height };
  const radius = Math.min(Math.max(0, bg.cornerRadius * scale), Math.min(rect.width, rect.height) / 2);
  if (bg.color.a > 0) {
    roundedRectPath(ctx, rect, radius);
    ctx.fillStyle = cssColor(bg.color);
    ctx.fill();
  }
  if (bg.outlineWidth > 0 && bg.outlineColor.a > 0) {
    roundedRectPath(ctx, rect, radius);
    ctx.strokeStyle = cssColor(bg.outlineColor);
    ctx.lineWidth = bg.outlineWidth * scale;
    ctx.stroke();
  }
}

function applyShadow(ctx: Ctx2D, style: TextStyle, renderSize: Size): void {
  if (!style.shadow.enabled) return;
  const scale = renderSize.height / textLayoutReferenceCanvasHeight;
  ctx.shadowOffsetX = style.shadow.offsetX * scale;
  ctx.shadowOffsetY = style.shadow.offsetY * scale;
  ctx.shadowBlur = Math.max(0, style.shadow.blur * scale);
  ctx.shadowColor = cssColor(style.shadow.color);
}

// MARK: - Renderer

export interface TextRaster {
  source: AnyCanvas;
  /** Raster rectangle in render pixels (top-left origin). */
  rect: Rect;
  /** Text box in render pixels: entrance animations scale around its centre. */
  box: Rect;
  /** Identifies the pixels; changes whenever they do. */
  version: string;
}

interface CacheEntry {
  canvas: AnyCanvas;
  key: string;
}

const cacheLimit = 48;

/** Text clip → Canvas 2D raster, cached by everything that affects pixels (TextFrameRenderer). */
export class TextRenderer {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly spare: AnyCanvas[] = [];
  private scratch: AnyCanvas | null = null;
  /** Test seam: count of actual rasterizations (cache misses). */
  rasterizeCount = 0;

  raster(layer: TextLayer, renderSize: Size): TextRaster | null {
    if (!(renderSize.width >= 1 && renderSize.height >= 1)) return null;
    const t = layer.text;
    const style = t.style;
    const box = boxRect(layer, renderSize);
    const boxes = layoutBoxes(style, box, renderSize);
    const fontSize = style.fontSize * (renderSize.height / textLayoutReferenceCanvasHeight);
    const rect = rasterBounds(style, boxes, fontSize, renderSize, t.wordMotion);
    if (!(rect.width >= 1 && rect.height >= 1)) return null;
    const state = t.mode === "perWord"
      ? JSON.stringify(t.wordStates)
      : t.mode === "typewriter" ? t.typewriterVisible : "";
    const q = (v: number): number => Math.round(v * 64);
    const key = JSON.stringify([
      t.content, style, t.mode, t.mode === "perWord" ? [t.tokens.length, layer.clip.wordTimings, layer.clip.durationFrames] : 0,
      q(boxes.text.x - rect.x), q(boxes.text.y - rect.y), q(boxes.text.width), q(boxes.text.height),
      q(boxes.background.x - rect.x), q(boxes.background.y - rect.y), q(boxes.background.width), q(boxes.background.height),
      rect.width, rect.height, renderSize.width, renderSize.height, state,
    ]);
    let entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cache.set(key, entry);
    } else {
      entry = { canvas: this.canvas(rect.width, rect.height), key };
      this.rasterizeCount += 1;
      this.draw(entry.canvas, layer, renderSize, boxes, rect, fontSize);
      this.cache.set(key, entry);
      this.evict();
    }
    return { source: entry.canvas, rect, box, version: key };
  }

  dispose(): void {
    this.cache.clear();
    this.spare.length = 0;
    this.scratch = null;
  }

  private canvas(width: number, height: number): AnyCanvas {
    const c = this.spare.pop() ?? makeCanvas(width, height);
    c.width = width;
    c.height = height;
    return c;
  }

  private evict(): void {
    while (this.cache.size > cacheLimit) {
      const oldest = this.cache.keys().next().value as string;
      const entry = this.cache.get(oldest);
      this.cache.delete(oldest);
      if (entry && this.spare.length < 8) this.spare.push(entry.canvas);
    }
  }

  private scratchContext(width: number, height: number): Ctx2D {
    this.scratch ??= makeCanvas(width, height);
    if (this.scratch.width !== width || this.scratch.height !== height) {
      this.scratch.width = width;
      this.scratch.height = height;
    }
    const ctx = context2d(this.scratch);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return ctx;
  }

  private draw(canvas: AnyCanvas, layer: TextLayer, renderSize: Size, boxes: LayoutBoxes, rect: Rect, fontSize: number): void {
    const t = layer.text;
    const style = t.style;
    const ctx = context2d(canvas);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.translate(-rect.x, -rect.y);
    drawBox(ctx, style, boxes.background, renderSize);

    // Glyphs draw into a scratch layer so the context shadow applies once to the assembled block.
    const glyphs = this.scratchContext(rect.width, rect.height);
    glyphs.translate(-rect.x, -rect.y);
    const m = lineMetrics(glyphs, style, fontSize);
    if (t.mode === "perWord") {
      const lines = frameLines(glyphs, m, t.content, boxes.text, style.alignment);
      drawWords(glyphs, style, m, lines, t.tokens, t.wordStates, fontSize);
    } else if (t.mode === "typewriter") {
      if (t.typewriterVisible !== "") {
        // Left-anchor so the text reveals rightward in place rather than re-centering as it grows.
        const lines = frameLines(glyphs, m, t.typewriterVisible, boxes.text, "left", t.content);
        drawTextGlyphs(glyphs, style, m, lines);
      }
    } else {
      drawTextGlyphs(glyphs, style, m, frameLines(glyphs, m, t.content, boxes.text, style.alignment));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    applyShadow(ctx, style, renderSize);
    ctx.drawImage(this.scratch as AnyCanvas, 0, 0);
    ctx.shadowColor = "rgba(0,0,0,0)";
  }
}

interface WordPlacement {
  state: TextWordState;
  penX: number;
  baseline: number;
  width: number;
  text: string;
}

/** Backgrounds, then undercoats, then fills, so no word's outline paints over a neighbour's fill. */
function drawWords(
  ctx: Ctx2D, style: TextStyle, m: LineMetrics, lines: readonly PlacedLine[], tokens: readonly TextToken[],
  states: readonly TextWordState[], fontSize: number,
): void {
  const placements: WordPlacement[] = [];
  ctx.font = m.font;
  ctx.letterSpacing = "0px";
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti] as TextToken;
    const st = states[ti];
    if (!st || !(st.opacity > 0)) continue;
    const line = lines.find((l) => tok.start >= l.start && tok.start < l.end);
    if (!line) continue;
    const startOff = measureWidth(ctx, m, line.text.slice(0, tok.start - line.start));
    const endOff = measureWidth(ctx, m, line.text.slice(0, tok.start + tok.length - line.start));
    placements.push({ state: st, penX: line.x + startOff, baseline: line.baseline, width: endOff - startOff, text: tok.text });
  }
  if (placements.length === 0) return;

  const withState = (p: WordPlacement, draw: () => void): void => {
    ctx.save();
    ctx.globalAlpha = p.state.opacity;
    const cx = p.penX + p.width / 2, cy = p.baseline - fontSize * 0.35;
    ctx.translate(0, p.state.dy * fontSize);
    ctx.translate(cx, cy);
    ctx.scale(p.state.scale, p.state.scale);
    ctx.translate(-cx, -cy);
    draw();
    ctx.restore();
  };

  for (const p of placements) {
    const bg = p.state.bgColor;
    if (!bg || !(bg.a > 0.001)) continue;
    withState(p, () => {
      const padX = fontSize * 0.18, padY = fontSize * 0.1;
      roundedRectPath(ctx, {
        x: p.penX - padX, y: p.baseline - m.ascent - padY, width: p.width + padX * 2, height: m.ascent + m.descent + padY * 2,
      }, fontSize * 0.12);
      ctx.fillStyle = cssColor(bg);
      ctx.fill();
    });
  }
  const widths = strokeWidths(style, m.px);
  const outline = textStyleDrawsGlyphOutline(style);
  if (outline) {
    for (const p of placements) {
      withState(p, () => {
        ctx.lineJoin = "round";
        ctx.strokeStyle = cssColor(style.border.color);
        ctx.lineWidth = widths.undercoat / Math.sqrt(m.widthScale * m.heightScale || 1);
        drawLineGlyphs(ctx, m, p.text, p.penX, p.baseline, "stroke");
      });
    }
  }
  for (const p of placements) {
    withState(p, () => {
      ctx.fillStyle = cssColor(p.state.color);
      drawLineGlyphs(ctx, m, p.text, p.penX, p.baseline, "fill");
      if (!outline && style.border.enabled && style.border.width > 0) {
        ctx.strokeStyle = cssColor(style.border.color);
        ctx.lineWidth = widths.hollow / Math.sqrt(m.widthScale * m.heightScale || 1);
        drawLineGlyphs(ctx, m, p.text, p.penX, p.baseline, "stroke");
      }
      if (style.isOverlined) drawDecorations(ctx, { ...style, isUnderlined: false, isStruckThrough: false }, m, p.penX, p.baseline, p.width, p.state.color);
    });
  }
}
