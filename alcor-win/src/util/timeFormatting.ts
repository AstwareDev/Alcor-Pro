import { swiftRound } from "./math";

function twoDigit(value: number): string {
  return value >= 0 && value < 10 ? `0${value}` : `${value}`;
}

export function formatTimecode(frame: number, fps: number): string {
  if (!(fps > 0)) return "00:00:00:00";
  const absFrame = Math.abs(frame);
  const totalSeconds = Math.trunc(absFrame / fps);
  const ff = absFrame % fps;
  const ss = totalSeconds % 60;
  const mm = Math.trunc(totalSeconds / 60) % 60;
  const hh = Math.trunc(totalSeconds / 3600);
  const sign = frame < 0 ? "-" : "";
  return `${sign}${twoDigit(hh)}:${twoDigit(mm)}:${twoDigit(ss)}:${twoDigit(ff)}`;
}

function swiftInt(s: string): number | undefined {
  return /^[+-]?\d+$/.test(s) ? Number.parseInt(s, 10) : undefined;
}

export function parseTimecode(value: string, fps: number): number | undefined {
  const fields = value.split(":");
  if (!(fps >= 1 && fps <= 1000) || fields.length !== 4) return undefined;
  const [hours, minutes, seconds, frames] = fields.map(swiftInt);
  if (hours === undefined || minutes === undefined || seconds === undefined || frames === undefined) return undefined;
  if (!(hours >= 0 && hours < 1000) || !(minutes >= 0 && minutes < 60) || !(seconds >= 0 && seconds < 60)) return undefined;
  if (!(frames >= 0 && frames < fps)) return undefined;
  return (hours * 3600 + minutes * 60 + seconds) * fps + frames;
}

export function secondsToFrame(seconds: number, fps: number): number {
  return Math.trunc(seconds * fps);
}

// Swift `Double.rounded(toPlaces:)`
export function roundedToPlaces(x: number, places: number): number {
  const factor = Math.pow(10, places);
  return swiftRound(x * factor) / factor;
}
