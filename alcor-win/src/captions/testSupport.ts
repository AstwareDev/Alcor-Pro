// Shared helpers for the captions tests (only imported by *.test.ts).
import type { TextMeasurer } from "../model";

/** Deterministic stand-in for Canvas 2D text measurement: 10 px per character, 20 px tall. */
export const fakeMeasure: TextMeasurer = (text) => ({ width: text.length * 10, height: 20 });

let counter = 0;
export const testGroupId = (): string => `group-${++counter}`;
