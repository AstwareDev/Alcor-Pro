import {
  gradeCurveEncoded, gradeCurveFromJson, gradeCurveIsIdentity, hueCurvesEncoded, hueCurvesFromJson,
  hueCurvesIsIdentity, hueCurvesNeutralY, makeCurvePoint, makeEffect, makeEffectParam, makeGradeCurve, makeHueCurves,
  makeStaticEffect, type Clip, type CurvePoint, type Effect, type GradeCurve, type HueCurves,
} from "../../model";
import { mutateClips } from "../../editor/mutations/clipMutations";
import { inspectorServices } from "../../inspector/services";
import { swiftRound } from "../../util/math";
import { colorFrameIO, scopeGridEdge } from "./colorFrames";
import { measureScopes, scopesGap, scopesReadout, type Scopes } from "./colorScopes";
import { jsonString } from "./jsonFormat";
import { mutationResult, timelineSnapshot } from "./mutationDelta";
import { ToolError, decodeToolArgs, isRecord, validateUnknownKeys, type DecodeField } from "./toolArgs";
import type { ToolArgs, ToolContext } from "./toolRegistry";
import type { ToolBlock, ToolResult } from "./toolResult";

// Port of ToolExecutor+Color.swift: apply_color, inspect_color and the grade <-> color.* effect translation.

const clamp3 = (v: number): number => swiftRound(v * 1000) / 1000;
const isColorEffect = (e: Effect): boolean => e.type.startsWith("color.");

// MARK: - Input decoding (Swift Decodable: unknown keys inside nested objects are ignored)

interface HueTargetInput {
  targetHue: number;
  hueShift?: number;
  satScale?: number;
  lumShift?: number;
}

interface ApplyColorInput {
  clipIds: string[];
  reset?: boolean;
  exposure?: number; contrast?: number; saturation?: number; vibrance?: number; temperature?: number; tint?: number;
  highlights?: number; shadows?: number; blacks?: number; whites?: number;
  shadowsHue?: number; shadowsAmount?: number; shadowsLum?: number;
  midsHue?: number; midsAmount?: number; midsGamma?: number;
  highsHue?: number; highsAmount?: number; highsGain?: number;
  masterCurve?: number[][]; redCurve?: number[][]; greenCurve?: number[][]; blueCurve?: number[][];
  hueCurves?: { targets?: HueTargetInput[] };
  lut?: { path?: string; strength?: number };
}

const knobKeys = [
  "exposure", "contrast", "saturation", "vibrance", "temperature", "tint", "highlights", "shadows", "blacks", "whites",
  "shadowsHue", "shadowsAmount", "shadowsLum", "midsHue", "midsAmount", "midsGamma", "highsHue", "highsAmount", "highsGain",
] as const;
const curveKeys = ["masterCurve", "redCurve", "greenCurve", "blueCurve"] as const;

function mismatch(path: string, type: string): ToolError {
  return new ToolError(`${path}: expected ${type}, got something else`);
}

function nested(value: unknown, path: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw mismatch(path, "Dictionary<String, Any>");
  return value;
}

function optDouble(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") throw mismatch(path, "Double");
  return value;
}

function decodePoints(value: unknown, path: string): number[][] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw mismatch(path, "Array<Any>");
  return value.map((row, i) => {
    if (!Array.isArray(row)) throw mismatch(`${path}[${i}]`, "Array<Any>");
    return row.map((v, j) => {
      if (typeof v !== "number") throw mismatch(`${path}[${i}][${j}]`, "Double");
      return v;
    });
  });
}

function decodeHueTargets(hue: Record<string, unknown>): ApplyColorInput["hueCurves"] {
  const targetsRaw = hue.targets;
  if (targetsRaw === undefined || targetsRaw === null) return {};
  if (!Array.isArray(targetsRaw)) throw mismatch("apply_color.hueCurves.targets", "Array<Any>");
  return {
    targets: targetsRaw.map((t, i) => {
      const path = `apply_color.hueCurves.targets[${i}]`;
      const entry = nested(t, path);
      if (!entry) throw mismatch(path, "Dictionary<String, Any>");
      const targetHue = optDouble(entry.targetHue, `${path}.targetHue`);
      if (targetHue === undefined) throw new ToolError(`${path}: missing required field 'targetHue'`);
      const out: HueTargetInput = { targetHue };
      for (const k of ["hueShift", "satScale", "lumShift"] as const) {
        const v = optDouble(entry[k], `${path}.${k}`);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }),
  };
}

function decodeApplyColor(args: ToolArgs): ApplyColorInput {
  const fields: Record<string, DecodeField> = {
    clipIds: { spec: { array: "string" }, required: true },
    reset: { spec: "bool" },
    hueCurves: { spec: "any" },
    lut: { spec: "any" },
  };
  for (const k of knobKeys) fields[k] = { spec: "double" };
  for (const k of curveKeys) fields[k] = { spec: "any" };
  const raw = decodeToolArgs<Record<string, unknown>>(args, "apply_color", fields);
  const input: ApplyColorInput = { clipIds: raw.clipIds as string[] };
  if (raw.reset !== undefined) input.reset = raw.reset as boolean;
  for (const k of knobKeys) if (raw[k] !== undefined) input[k] = raw[k] as number;
  for (const k of curveKeys) {
    const pts = decodePoints(raw[k], `apply_color.${k}`);
    if (pts) input[k] = pts;
  }
  const hue = nested(raw.hueCurves, "apply_color.hueCurves");
  if (hue) input.hueCurves = decodeHueTargets(hue);
  const lut = nested(raw.lut, "apply_color.lut");
  if (lut) {
    input.lut = {};
    const p = lut.path;
    if (p !== undefined && p !== null) {
      if (typeof p !== "string") throw mismatch("apply_color.lut.path", "String");
      input.lut.path = p;
    }
    const s = optDouble(lut.strength, "apply_color.lut.strength");
    if (s !== undefined) input.lut.strength = s;
  }
  return input;
}

function hasAnyParam(i: ApplyColorInput): boolean {
  return knobKeys.some((k) => i[k] !== undefined) || curveKeys.some((k) => i[k] !== undefined) ||
    (i.hueCurves?.targets?.length ?? 0) > 0 || i.lut !== undefined;
}

// MARK: - Grade state

interface GradeState {
  exposure?: number; temperature?: number; tint?: number; contrast?: number;
  highlights?: number; shadows?: number; blacks?: number; whites?: number;
  shadowsHue?: number; shadowsAmount?: number; shadowsLum?: number;
  midsHue?: number; midsAmount?: number; midsGamma?: number;
  highsHue?: number; highsAmount?: number; highsGain?: number;
  vibrance?: number; saturation?: number;
  curve?: GradeCurve;
  hueCurves?: HueCurves;
  lutPath?: string;
  lutIntensity?: number;
}

/** Writes only defined values so a state never carries explicit `undefined`s. */
function set<K extends keyof GradeState>(s: GradeState, key: K, value: GradeState[K] | undefined): void {
  if (value !== undefined) s[key] = value as GradeState[K];
}

function hueAmount(x: number, y: number): [number | undefined, number | undefined] {
  const amt = Math.sqrt(x * x + y * y);
  if (!(amt > 1e-6)) return [undefined, undefined];
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return [deg, amt];
}

function xy(hue: number | undefined, amount: number | undefined): [number, number] {
  const a = ((hue ?? 0) * Math.PI) / 180;
  const r = amount ?? 0;
  return [r * Math.cos(a), r * Math.sin(a)];
}

function gradeFromEffects(effects: readonly Effect[] | undefined): GradeState {
  const s: GradeState = {};
  if (!effects) return s;
  for (const e of effects) {
    const v = (k: string): number | undefined => e.params[k]?.value;
    const str = (k: string): string | undefined => e.params[k]?.string;
    switch (e.type) {
      case "color.exposure": set(s, "exposure", v("ev")); break;
      case "color.temperature": set(s, "temperature", v("temperature")); set(s, "tint", v("tint")); break;
      case "color.contrast": set(s, "contrast", v("amount")); break;
      case "color.highlightsShadows": set(s, "highlights", v("highlights")); set(s, "shadows", v("shadows")); break;
      case "color.blacksWhites": set(s, "blacks", v("blacks")); set(s, "whites", v("whites")); break;
      case "color.vibrance": set(s, "vibrance", v("amount")); break;
      case "color.saturation": set(s, "saturation", v("amount")); break;
      case "color.curves": {
        const json = str("curve");
        set(s, "curve", json === undefined ? undefined : gradeCurveFromJson(json));
        break;
      }
      case "color.hueCurves": {
        const json = str("curves");
        set(s, "hueCurves", json === undefined ? undefined : hueCurvesFromJson(json));
        break;
      }
      case "color.lut": set(s, "lutPath", str("path")); set(s, "lutIntensity", v("intensity")); break;
      case "color.wheels": {
        const [sh, sa] = hueAmount(v("lift_x") ?? 0, v("lift_y") ?? 0);
        set(s, "shadowsHue", sh); set(s, "shadowsAmount", sa); set(s, "shadowsLum", v("lift_m"));
        const [mh, ma] = hueAmount(v("gamma_x") ?? 0, v("gamma_y") ?? 0);
        set(s, "midsHue", mh); set(s, "midsAmount", ma); set(s, "midsGamma", v("gamma_m"));
        const [hh, ha] = hueAmount(v("gain_x") ?? 0, v("gain_y") ?? 0);
        set(s, "highsHue", hh); set(s, "highsAmount", ha); set(s, "highsGain", v("gain_m"));
        break;
      }
      default: break;
    }
  }
  return s;
}

function dv(d: Record<string, unknown>, k: string): number | undefined {
  const v = d[k];
  return typeof v === "number" ? v : undefined;
}

function pointsOf(raw: unknown): CurvePoint[] {
  if (!Array.isArray(raw) || !raw.every((row) => Array.isArray(row))) return [];
  return (raw as unknown[][]).flatMap((row) => {
    const x = row[0];
    const y = row[1];
    return row.length >= 2 && typeof x === "number" && typeof y === "number" ? [makeCurvePoint(x, y)] : [];
  });
}

/** A pasted `color` object — the shape colorObject emits. */
function gradeFromColorDict(d: Record<string, unknown>): GradeState {
  const s: GradeState = {};
  for (const k of knobKeys) set(s, k, dv(d, k));
  const master = pointsOf(d.masterCurve);
  const red = pointsOf(d.redCurve);
  const green = pointsOf(d.greenCurve);
  const blue = pointsOf(d.blueCurve);
  if (!(master.length === 0 && red.length === 0 && green.length === 0 && blue.length === 0)) {
    s.curve = makeGradeCurve({ master, red, green, blue });
  }
  const raw = d.hueCurvesRaw;
  if (isRecord(raw)) {
    const hc = makeHueCurves({ hueVsHue: pointsOf(raw.hueVsHue), hueVsSat: pointsOf(raw.hueVsSat), hueVsLum: pointsOf(raw.hueVsLum) });
    if (!hueCurvesIsIdentity(hc)) s.hueCurves = hc;
  }
  const lut = d.lut;
  if (isRecord(lut)) {
    if (typeof lut.path === "string") s.lutPath = lut.path;
    set(s, "lutIntensity", dv(lut, "strength"));
  }
  return s;
}

/** Compiles semantic hue targets into the three hue curves (a localized bump per touched channel). */
function compileHueCurves(targets: readonly HueTargetInput[]): HueCurves {
  const band = 0.06; // ~22° selectivity
  const wrap01 = (v: number): number => {
    const m = v % 1;
    return m < 0 ? m + 1 : m;
  };
  const bump = (pts: CurvePoint[], center: number, y: number): void => {
    pts.push(makeCurvePoint(wrap01(center), y));
    pts.push(makeCurvePoint(wrap01(center - band), hueCurvesNeutralY));
    pts.push(makeCurvePoint(wrap01(center + band), hueCurvesNeutralY));
  };
  // Sort by x; on a collision keep the more extreme (non-neutral) point.
  const finalize = (pts: CurvePoint[]): CurvePoint[] => {
    const byX = new Map<number, CurvePoint>();
    const ordered = [...pts].sort((a, b) => Math.abs(a.y - hueCurvesNeutralY) - Math.abs(b.y - hueCurvesNeutralY));
    for (const p of ordered) byX.set(clamp3(p.x), makeCurvePoint(clamp3(p.x), clamp3(p.y)));
    return [...byX.values()].sort((a, b) => a.x - b.x);
  };
  const hue: CurvePoint[] = [];
  const sat: CurvePoint[] = [];
  const lum: CurvePoint[] = [];
  for (const t of targets) {
    const center = wrap01(t.targetHue / 360);
    if (t.hueShift !== undefined && Math.abs(t.hueShift) > 1e-6) bump(hue, center, hueCurvesNeutralY + Math.max(-30, Math.min(30, t.hueShift)) / 60);
    if (t.satScale !== undefined && Math.abs(t.satScale - 1) > 1e-6) bump(sat, center, hueCurvesNeutralY + (Math.max(0, Math.min(2, t.satScale)) - 1) / 2);
    if (t.lumShift !== undefined && Math.abs(t.lumShift) > 1e-6) bump(lum, center, hueCurvesNeutralY + Math.max(-0.5, Math.min(0.5, t.lumShift)));
  }
  return makeHueCurves({ hueVsHue: finalize(hue), hueVsSat: finalize(sat), hueVsLum: finalize(lum) });
}

function applyInput(s: GradeState, i: ApplyColorInput, lutDestPath: string | undefined): void {
  for (const k of knobKeys) set(s, k, i[k]);
  const points = (arr: number[][] | undefined): CurvePoint[] | undefined =>
    arr?.flatMap((p) => (p.length >= 2 ? [makeCurvePoint(clamp3(p[0] as number), clamp3(p[1] as number))] : []));
  if (curveKeys.some((k) => i[k] !== undefined)) {
    const c = s.curve ?? makeGradeCurve();
    const master = points(i.masterCurve);
    const red = points(i.redCurve);
    const green = points(i.greenCurve);
    const blue = points(i.blueCurve);
    if (master) c.master = master;
    if (red) c.red = red;
    if (green) c.green = green;
    if (blue) c.blue = blue;
    s.curve = c;
  }
  const targets = i.hueCurves?.targets;
  if (targets && targets.length > 0) s.hueCurves = compileHueCurves(targets);
  const strength = i.lut?.strength;
  if (lutDestPath !== undefined) {
    s.lutPath = lutDestPath;
    s.lutIntensity = strength === undefined ? 1 : clamp3(Math.min(1, Math.max(0, strength)));
  } else if (strength !== undefined) {
    s.lutIntensity = clamp3(Math.min(1, Math.max(0, strength))); // re-blend the existing LUT
  }
}

/** Emits effects in canonical order so an agent grade renders identically to the UI's. */
function buildStack(s: GradeState): Effect[] {
  const stack: Effect[] = [];
  if (s.exposure !== undefined) stack.push(makeStaticEffect("color.exposure", { ev: clamp3(s.exposure) }));
  if (s.contrast !== undefined) stack.push(makeStaticEffect("color.contrast", { amount: clamp3(s.contrast) }));
  if (s.highlights !== undefined || s.shadows !== undefined) {
    stack.push(makeStaticEffect("color.highlightsShadows", { highlights: clamp3(s.highlights ?? 0), shadows: clamp3(s.shadows ?? 0) }));
  }
  if (s.blacks !== undefined || s.whites !== undefined) {
    stack.push(makeStaticEffect("color.blacksWhites", { blacks: clamp3(s.blacks ?? 0), whites: clamp3(s.whites ?? 0) }));
  }
  if (s.temperature !== undefined || s.tint !== undefined) {
    stack.push(makeStaticEffect("color.temperature", { temperature: clamp3(s.temperature ?? 6500), tint: clamp3(s.tint ?? 0) }));
  }
  if (s.vibrance !== undefined) stack.push(makeStaticEffect("color.vibrance", { amount: clamp3(s.vibrance) }));
  if (s.saturation !== undefined) stack.push(makeStaticEffect("color.saturation", { amount: clamp3(s.saturation) }));
  const wheelFields = [s.shadowsHue, s.shadowsAmount, s.shadowsLum, s.midsHue, s.midsAmount, s.midsGamma, s.highsHue, s.highsAmount, s.highsGain];
  if (wheelFields.some((v) => v !== undefined)) {
    const [lx, ly] = xy(s.shadowsHue, s.shadowsAmount);
    const [gx, gy] = xy(s.midsHue, s.midsAmount);
    const [hx, hy] = xy(s.highsHue, s.highsAmount);
    stack.push(makeStaticEffect("color.wheels", {
      lift_x: clamp3(lx), lift_y: clamp3(ly), lift_m: clamp3(s.shadowsLum ?? 0),
      gamma_x: clamp3(gx), gamma_y: clamp3(gy), gamma_m: clamp3(s.midsGamma ?? 1),
      gain_x: clamp3(hx), gain_y: clamp3(hy), gain_m: clamp3(s.highsGain ?? 1),
    }));
  }
  if (s.curve && !gradeCurveIsIdentity(s.curve)) {
    stack.push(makeEffect({ type: "color.curves", params: { curve: makeEffectParam({ string: gradeCurveEncoded(s.curve) }) } }));
  }
  if (s.hueCurves && !hueCurvesIsIdentity(s.hueCurves)) {
    stack.push(makeEffect({ type: "color.hueCurves", params: { curves: makeEffectParam({ string: hueCurvesEncoded(s.hueCurves) }) } }));
  }
  if (s.lutPath !== undefined) {
    stack.push(makeEffect({
      type: "color.lut",
      params: { path: makeEffectParam({ string: s.lutPath }), intensity: makeEffectParam({ value: clamp3(s.lutIntensity ?? 1) }) },
    }));
  }
  return stack;
}

// ApplyColorInput.allowedKeys minus clipIds/reset/hueCurves, plus hueCurvesRaw.
const colorObjectAllowedKeys: readonly string[] = [...knobKeys, ...curveKeys, "lut", "hueCurvesRaw"];

/**
 * The clip's grade in apply_color vocabulary; undefined when ungraded. Round-trips via apply_color's `color`
 * parameter (hue curves come back raw — they compile one-way).
 */
export function colorObject(effects: readonly Effect[] | undefined): Record<string, unknown> | undefined {
  if (!effects || !effects.some(isColorEffect)) return undefined;
  const s = gradeFromEffects(effects);
  const out: Record<string, unknown> = {};
  // Wheels store every zone; neutral values aren't part of the grade's meaning.
  const neutral: Record<string, number> = { shadowsLum: 0, midsGamma: 1, highsGain: 1, shadowsAmount: 0, midsAmount: 0, highsAmount: 0 };
  for (const k of knobKeys) {
    const v = s[k];
    if (v === undefined || v === neutral[k]) continue;
    out[k] = v;
  }
  for (const zone of ["shadows", "mids", "highs"]) if (out[`${zone}Amount`] === undefined) delete out[`${zone}Hue`];
  const pts = (p: readonly CurvePoint[]): number[][] | undefined => (p.length === 0 ? undefined : p.map((q) => [q.x, q.y]));
  if (s.curve) {
    const named: [string, readonly CurvePoint[]][] = [
      ["masterCurve", s.curve.master], ["redCurve", s.curve.red], ["greenCurve", s.curve.green], ["blueCurve", s.curve.blue],
    ];
    for (const [k, p] of named) {
      const v = pts(p);
      if (v) out[k] = v;
    }
  }
  if (s.hueCurves) {
    const raw: Record<string, number[][]> = {};
    const hv = pts(s.hueCurves.hueVsHue);
    const sv = pts(s.hueCurves.hueVsSat);
    const lv = pts(s.hueCurves.hueVsLum);
    if (hv) raw.hueVsHue = hv;
    if (sv) raw.hueVsSat = sv;
    if (lv) raw.hueVsLum = lv;
    if (Object.keys(raw).length > 0) out.hueCurvesRaw = raw;
  }
  if (s.lutPath !== undefined) out.lut = { path: s.lutPath, strength: s.lutIntensity ?? 1 };
  return Object.keys(out).length === 0 ? undefined : out;
}

// MARK: - apply_color

function requireGradable(clip: Clip, id: string, tool: string): void {
  if (clip.mediaType !== "video" && clip.mediaType !== "image") {
    throw new ToolError(`Clip ${id} is a ${clip.mediaType} clip; ${tool} needs a video or image clip.`);
  }
}

async function storeLut(path: string): Promise<string> {
  const store = inspectorServices.storeLut;
  if (!store) throw new ToolError("LUT storage is not available.");
  try {
    return await store(path);
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : "Invalid LUT.");
  }
}

export async function applyColor({ editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const colorRaw = args.color;
  const colorDict = isRecord(colorRaw) ? colorRaw : undefined;
  const knobArgs = { ...args };
  delete knobArgs.color;
  const input = decodeApplyColor(knobArgs);
  if (input.clipIds.length === 0) throw new ToolError("clipIds is empty.");
  if (colorDict) {
    if (hasAnyParam(input) || input.reset === true) {
      throw new ToolError("'color' pastes a complete grade — don't combine it with individual knobs or reset.");
    }
    validateUnknownKeys(colorDict, colorObjectAllowedKeys, "apply_color.color");
  } else if (!(hasAnyParam(input) || input.reset === true)) {
    throw new ToolError("No grade parameters provided.");
  }
  for (const id of input.clipIds) {
    const clip = editor.clipFor(id);
    if (!clip) throw new ToolError(`Clip not found: ${id}`);
    requireGradable(clip, id, "apply_color");
  }
  // LUT file I/O up front so it can throw before mutating.
  const lutPath = input.lut?.path;
  const lutDestPath = lutPath !== undefined && lutPath !== "" ? await storeLut(lutPath) : undefined;
  let pastedStack: Effect[] | undefined;
  if (colorDict) {
    const pasted = gradeFromColorDict(colorDict);
    if (pasted.lutPath !== undefined && pasted.lutPath !== "") pasted.lutPath = await storeLut(pasted.lutPath);
    if (pasted.lutIntensity !== undefined) pasted.lutIntensity = Math.min(1, Math.max(0, pasted.lutIntensity));
    pastedStack = buildStack(pasted);
  }
  const reset = input.reset ?? false;
  const since = timelineSnapshot(editor);
  const actionName = input.clipIds.length === 1 ? "Color Grade (Agent)" : `Color Grade ×${input.clipIds.length} (Agent)`;
  mutateClips(editor, new Set(input.clipIds), actionName, (clip) => {
    const current = clip.effects ?? [];
    const nonColor = current.filter((e) => !isColorEffect(e));
    let color: Effect[];
    if (pastedStack) {
      color = structuredClone(pastedStack);
    } else {
      const disabledColor = reset ? new Set<string>() : new Set(current.filter((e) => isColorEffect(e) && !e.enabled).map((e) => e.type));
      const state = gradeFromEffects(reset ? undefined : current);
      applyInput(state, input, lutDestPath);
      color = buildStack(state);
      for (const e of color) if (disabledColor.has(e.type)) e.enabled = false;
    }
    const stack = [...nonColor, ...color];
    if (stack.length === 0) delete clip.effects;
    else clip.effects = stack;
  });
  return mutationResult(editor, since, { touched: input.clipIds });
}

// MARK: - inspect_color

/** Timeline frame to sample: the clip-relative offset clamped into the clip, defaulting to its midpoint. */
function sampleFrame(clip: Clip, atFrame: number | undefined): number {
  const offset = atFrame !== undefined
    ? Math.max(0, Math.min(clip.durationFrames - 1, atFrame - clip.startFrame))
    : Math.trunc(clip.durationFrames / 2);
  return clip.startFrame + offset;
}

const inspectRenderEdge = 512;

export async function inspectColor({ executor, editor }: ToolContext, args: ToolArgs): Promise<ToolResult> {
  const input = decodeToolArgs<{ clipId?: string; mediaRef?: string; atFrame?: number; reference?: string }>(args, "inspect_color", {
    clipId: { spec: "string" },
    mediaRef: { spec: "string" },
    atFrame: { spec: "int" },
    reference: { spec: "string" },
  });

  const blocks: ToolBlock[] = [];
  let scopes: Scopes;
  let subjectKey: string;
  if (input.clipId !== undefined) {
    const clipId = input.clipId;
    const clip = editor.clipFor(clipId);
    if (!clip) throw new ToolError(`Clip not found: ${clipId}`);
    requireGradable(clip, clipId, "inspect_color");
    executor.asset(clip.mediaRef, editor, "Clip source"); // validates the asset exists
    const render = executor.host?.renderTimelineFrame;
    const jpeg = render ? await render.call(executor.host, editor, sampleFrame(clip, input.atFrame), inspectRenderEdge) : null;
    if (jpeg === null) throw new ToolError(`Could not decode a frame for clip ${clipId}.`);
    const grid = await colorFrameIO.gridFromJpeg(jpeg, scopeGridEdge);
    const measured = grid && measureScopes(grid, scopeGridEdge);
    if (!measured) throw new ToolError("Could not measure the clip frame.");
    scopes = measured;
    subjectKey = "clip";
    blocks.push({ kind: "image", base64: jpeg, mediaType: "image/jpeg" });
  } else if (input.mediaRef !== undefined) {
    const raw = await rawAsset(executor, editor, input.mediaRef, "Media");
    scopes = raw.scopes;
    subjectKey = "media";
    blocks.push(raw.image);
  } else {
    throw new ToolError("Provide either clipId (measures the graded clip) or mediaRef (measures the raw asset).");
  }

  const payload: Record<string, unknown> = { [subjectKey]: scopesReadout(scopes) };
  if (input.reference !== undefined) {
    const ref = await rawAsset(executor, editor, input.reference, "Reference");
    blocks.push(ref.image);
    payload.reference = scopesReadout(ref.scopes);
    payload.gap = scopesGap(scopes, ref.scopes);
  }
  blocks.push({ kind: "text", text: jsonString(payload) });
  return { content: blocks, isError: false };
}

/** A raw media asset's frame (no effects). Swift samples the midpoint; the poster decoder returns the first frame. */
async function rawAsset(
  executor: ToolContext["executor"], editor: ToolContext["editor"], mediaRef: string, label: string,
): Promise<{ scopes: Scopes; image: ToolBlock }> {
  const media = executor.asset(mediaRef, editor, label);
  if (media.type !== "video" && media.type !== "image") {
    throw new ToolError(`${label} ${mediaRef} is a ${media.type} asset; inspect_color needs a video or image asset.`);
  }
  if (media.url === "") throw new ToolError(`Could not resolve a URL for ${mediaRef}.`);
  const frame = await colorFrameIO.rawAssetFrame(media, scopeGridEdge);
  const scopes = frame && measureScopes(frame.rgba, scopeGridEdge);
  if (!frame || !scopes) throw new ToolError(`Could not measure ${mediaRef}.`);
  return { scopes, image: { kind: "image", base64: frame.jpegBase64, mediaType: "image/jpeg" } };
}
