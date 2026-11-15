import { basename, normalizePath } from "../project/projectPaths";
import { swiftRound } from "../util/math";

/** Embedded SMPTE timecode of a source file (`SourceTimecode`). */
export interface SourceTimecode {
  frame: number;
  quanta: number;
  dropFrame: boolean;
  /** Exact seconds per TC frame (1001/30000 for NTSC); undefined falls back to 1/quanta. */
  tick?: { num: number; den: number };
}

export function makeSourceTimecode(p: { frame: number; quanta: number; dropFrame: boolean; tick?: { num: number; den: number } }): SourceTimecode {
  const tc: SourceTimecode = { frame: p.frame, quanta: p.quanta, dropFrame: p.dropFrame };
  if (p.tick !== undefined) tc.tick = p.tick;
  return tc;
}

/** `frames(atFPS:)`: start timecode expressed in `fps`-frame units. */
export function sourceTimecodeFrames(tc: SourceTimecode, fps: number): number {
  if (!(tc.quanta > 0)) return 0;
  return swiftRound((tc.frame / tc.quanta) * fps);
}

/** Rational seconds (with exact NTSC tick if needed) to prevent drift. */
export function sourceTimecodeRationalSeconds(tc: SourceTimecode): { num: number; den: number } {
  if (!(tc.quanta > 0)) return { num: 0, den: 1 };
  if (tc.tick !== undefined && tc.tick.num > 0 && tc.tick.den > 0) return { num: tc.frame * tc.tick.num, den: tc.tick.den };
  return { num: tc.frame, den: tc.quanta };
}

export function sourceTimecodeSeconds(tc: SourceTimecode): number {
  const s = sourceTimecodeRationalSeconds(tc);
  return s.num / s.den;
}

/** C `printf("%.Nf")`: exact decimal expansion, ties to even, negative zero keeps its sign. */
export function formatFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const abs = Math.abs(x);
  const rounded = abs.toFixed(digits);
  if (abs >= 1e21) return sign + rounded;
  const exact = abs.toFixed(Math.min(100, digits + 60));
  const dot = exact.indexOf(".");
  if (/^50*$/.test(exact.slice(dot + 1 + digits))) {
    const head = exact.slice(0, digits > 0 ? dot + 1 + digits : dot);
    if (Number(head[head.length - 1]) % 2 === 0) return sign + head;
  }
  return sign + rounded;
}

export function pad2(n: number): string {
  return n < 10 && n >= 0 ? `0${n}` : String(n);
}

export function lastPathComponent(path: string): string {
  return basename(path);
}

const sectionSafeSubDelims = "!$&'()*+,;=";

/** Foundation `URL(fileURLWithPath:).absoluteString`: sub-delimiters stay literal in the path. */
export function fileUrlAbsoluteString(path: string): string {
  const normalized = normalizePath(path);
  const prefix = /^[a-zA-Z]:/.test(normalized) ? "file:///" : "file://";
  let out = prefix;
  const bytes = new TextEncoder().encode(normalized);
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    const keep = b < 0x80 && (/[A-Za-z0-9\-._~:@/]/.test(ch) || sectionSafeSubDelims.includes(ch));
    out += keep ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export interface XmlNode {
  name: string;
  attributes: [string, string][];
  text?: string;
  children: XmlNode[];
}

export function xmlNode(name: string, p: { attributes?: [string, string][]; text?: string; children?: XmlNode[] } = {}): XmlNode {
  const node: XmlNode = { name, attributes: p.attributes ?? [], children: p.children ?? [] };
  if (p.text !== undefined) node.text = p.text;
  return node;
}

export function escapeXML(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}

export function renderXmlNode(node: XmlNode, indent: number): string {
  const pad = " ".repeat(indent);
  const attrs = node.attributes.map(([k, v]) => ` ${k}="${escapeXML(v)}"`).join("");
  if (node.text !== undefined) return `${pad}<${node.name}${attrs}>${escapeXML(node.text)}</${node.name}>`;
  if (node.children.length === 0) return `${pad}<${node.name}${attrs}/>`;
  const inner = node.children.map((c) => renderXmlNode(c, indent + 2)).join("\n");
  return `${pad}<${node.name}${attrs}>\n${inner}\n${pad}</${node.name}>`;
}

export function compact<T>(items: readonly (T | undefined)[]): T[] {
  return items.filter((i): i is T => i !== undefined);
}
