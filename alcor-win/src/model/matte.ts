import { swiftRound } from "../util/math";

export const matteAspects = ["Project", "16:9", "9:16", "1:1", "4:3", "9:14", "2.4:1"] as const;
export type MatteAspect = (typeof matteAspects)[number];

function matteAspectRatio(a: MatteAspect): [number, number] | undefined {
  switch (a) {
    case "Project": return undefined;
    case "16:9": return [16, 9];
    case "9:16": return [9, 16];
    case "1:1": return [1, 1];
    case "4:3": return [4, 3];
    case "9:14": return [9, 14];
    case "2.4:1": return [24, 10];
  }
}

export interface PixelSize {
  width: number;
  height: number;
}

/** Swift `Matte.even` */
export function matteEven(w: number, h: number): PixelSize {
  return {
    width: Math.max(2, Math.trunc(Math.max(2, w) / 2) * 2),
    height: Math.max(2, Math.trunc(Math.max(2, h) / 2) * 2),
  };
}

/** Swift `Matte.fit` */
export function matteFit(shortEdge: number, aspectW: number, aspectH: number): PixelSize {
  const e = Math.max(2, shortEdge);
  if (aspectW >= aspectH) return matteEven(swiftRound((e * aspectW) / aspectH), e);
  return matteEven(e, swiftRound((e * aspectH) / aspectW));
}

export function matteAspectPixelSize(a: MatteAspect, timelineWidth: number, timelineHeight: number): PixelSize {
  const ratio = matteAspectRatio(a);
  if (!ratio) return matteEven(timelineWidth, timelineHeight);
  return matteFit(Math.min(timelineWidth, timelineHeight), ratio[0], ratio[1]);
}

export function matteAspectParse(raw: string | undefined): MatteAspect | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.toLowerCase() === "project") return "Project";
  return (matteAspects as readonly string[]).includes(trimmed) ? (trimmed as MatteAspect) : undefined;
}

export type MatteError = "renderFailed" | "noProject";

export function matteErrorDescription(e: MatteError): string {
  return e === "renderFailed" ? "Couldn't render matte image." : "Open a project before creating a matte.";
}
