/** Port of Audio/AudioMeter.swift (channel state, hub) and the segment layout of AudioMeterView.swift. */
export const METER_FLOOR_DB = -60;
export const METER_CEILING_DB = 0;
const LEVEL_DECAY_DB_PER_SECOND = 24;
const PEAK_DECAY_DB_PER_SECOND = 18;
const PEAK_HOLD_SECONDS = 1.5;

export interface AudioMeterChannelDisplay {
  levelDb: number;
  peakDb: number;
  clipped: boolean;
}

export function amplitudeToDb(amplitude: number): number {
  return amplitude > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(amplitude)) : METER_FLOOR_DB;
}

export class AudioMeterChannelState {
  private levelDb = METER_FLOOR_DB;
  private levelTime = 0;
  private peakDb = METER_FLOOR_DB;
  private peakHoldUntil = 0;
  clipped = false;
  /** Reused by `display` so the draw loop does not allocate. */
  private readonly out: AudioMeterChannelDisplay = { levelDb: METER_FLOOR_DB, peakDb: METER_FLOOR_DB, clipped: false };

  ingest(peak: number, time: number): void {
    const current = this.display(time);
    const incoming = amplitudeToDb(peak);
    const level = Math.max(incoming, current.levelDb);
    const currentPeak = current.peakDb;
    this.levelDb = level;
    this.levelTime = time;
    if (incoming >= currentPeak) {
      this.peakDb = incoming;
      this.peakHoldUntil = time + PEAK_HOLD_SECONDS;
    } else if (time > this.peakHoldUntil) {
      this.peakDb = currentPeak;
      this.peakHoldUntil = time;
    }
    this.clipped = this.clipped || peak >= 1;
  }

  display(time: number): AudioMeterChannelDisplay {
    const levelElapsed = Math.max(0, time - this.levelTime);
    const peakElapsed = Math.max(0, time - this.peakHoldUntil);
    this.out.levelDb = Math.max(METER_FLOOR_DB, this.levelDb - levelElapsed * LEVEL_DECAY_DB_PER_SECOND);
    this.out.peakDb = Math.max(METER_FLOOR_DB, this.peakDb - peakElapsed * PEAK_DECAY_DB_PER_SECOND);
    this.out.clipped = this.clipped;
    return this.out;
  }

  resetClipping(): void {
    this.clipped = false;
  }
}

export class AudioMeterHub {
  readonly left = new AudioMeterChannelState();
  readonly right = new AudioMeterChannelState();

  ingest(leftPeak: number, rightPeak: number, time: number): void {
    this.left.ingest(leftPeak, time);
    this.right.ingest(rightPeak, time);
  }

  resetClipping(): void {
    this.left.resetClipping();
    this.right.resetClipping();
  }

  /** True once both channels have decayed to the floor (nothing left to animate). */
  settled(time: number): boolean {
    const l = this.left.display(time);
    const l1 = l.levelDb;
    const l2 = l.peakDb;
    const r = this.right.display(time);
    return l1 <= METER_FLOOR_DB && l2 <= METER_FLOOR_DB && r.levelDb <= METER_FLOOR_DB && r.peakDb <= METER_FLOOR_DB;
  }
}

export function normalizedDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
}

/** AudioMeterSegmentLayout with the fixed 1px segment / 1px gap of AppTheme.BorderWidth.thin. */
export interface MeterLayout {
  height: number;
  segmentHeight: number;
  count: number;
}

const THIN = 1;

export function meterLayout(height: number): MeterLayout {
  const gap = THIN;
  const rawCount = (height + gap) / (THIN + gap);
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(rawCount)) {
    return { height: Math.max(0, Number.isFinite(height) ? height : 0), segmentHeight: 0, count: 0 };
  }
  const count = Math.max(1, Math.trunc(rawCount));
  const segmentHeight = (height - (count - 1) * gap) / count;
  if (!(segmentHeight > 0)) return { height, segmentHeight: 0, count: 0 };
  return { height, segmentHeight, count };
}

export function segmentY(layout: MeterLayout, index: number): number {
  return layout.height - (index + 1) * layout.segmentHeight - index * THIN;
}

export function activeSegmentCount(layout: MeterLayout, db: number): number {
  return Math.ceil(normalizedDb(db) * layout.count);
}

export function segmentDb(layout: MeterLayout, index: number): number {
  if (layout.count <= 0) return METER_FLOOR_DB;
  const position = (index + 0.5) / layout.count;
  return METER_FLOOR_DB + position * (METER_CEILING_DB - METER_FLOOR_DB);
}

export function tickY(layout: MeterLayout, db: number, thickness = 0.5): number {
  if (layout.height <= thickness) return 0;
  const y = layout.height * (1 - normalizedDb(db)) - thickness / 2;
  return Math.min(layout.height - thickness, Math.max(0, y));
}

export type MeterBand = "green" | "yellow" | "red";
export const METER_YELLOW_DB = -20;
export const METER_RED_DB = -6;

export function meterBand(db: number): MeterBand {
  return db >= METER_RED_DB ? "red" : db >= METER_YELLOW_DB ? "yellow" : "green";
}

/** Source of master peaks, registered by the preview engine; null when no engine is mounted. */
export type MeterSource = () => { left: number; right: number };
let source: MeterSource | null = null;
export function setMeterSource(next: MeterSource | null): void {
  source = next;
}
export function readMeterSource(): { left: number; right: number } | null {
  return source ? source() : null;
}
