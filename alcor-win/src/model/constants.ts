// AppTheme-derived values are inlined (IconSize.xl = 30, Spacing.lg = 14, Spacing.xxl = 28, IconSize.mdLg = 24, Spacing.sm = 6).

export const TrackSize = {
  defaultHeight: 44,
  minHeight: 32,
  maxHeight: 200,
  resizeHandleZone: 6,
} as const;

export const Layout = {
  mediaPanelDefault: 500,
  mediaPanelMin: 280 + (30 + 14 + 28),
  inspectorDefault: 340,
  inspectorMin: 300,
  agentPanelMin: 240,
  agentPanelMax: 640,
  chatColumnMax: 640,
  panelHeaderHeight: 30,
  toolbarHeight: 24 + 6 * 2,
  panelGap: 5,
  timelineMinHeight: 100,
  timelineDefaultHeightFraction: 0.35,
  trackHeight: TrackSize.defaultHeight,
  rulerHeight: 28,
  trackHeaderDefaultWidth: 160,
  trackHeaderMinimumWidth: 112,
  trackHeaderMaximumWidth: 320,
  trackHeaderResizeHitWidth: 8,
  dropZoneHeight: TrackSize.minHeight,
  insertThreshold: 10,
  dragThreshold: 3,
  previewMinWidth: 400,
  previewMinHeight: 320,
} as const;

export const Defaults = {
  pixelsPerFrame: 4.0,
  imageDurationSeconds: 5.0,
  audioTTSDurationSeconds: 10.0,
  audioMusicDurationSeconds: 60.0,
  textDurationSeconds: 3.0,
  aspectTolerance: 0.02,
} as const;

export const Snap = {
  thresholdPixels: 8.0,
  stickyMultiplier: 1.5,
  playheadMultiplier: 1.5,
} as const;

export const Zoom = {
  min: 0.05,
  floor: 0.0001,
  max: 40.0,
  toolbarStepFactor: 1.25,
  scrollSensitivity: 0.04,
  magnifySensitivity: 1.5,
  panSpeed: 5.0,
  fitAllBuffer: 3.0,
} as const;

export const TimelineAutoScroll = {
  edgeZoneWidth: 56,
  maxZoneFraction: 0.5,
  minStep: 4,
  maxStep: 28,
  interval: 1.0 / 60.0,
} as const;

export const Trim = {
  handleWidth: 4.0,
  clipCornerRadius: 4,
} as const;

// storageDirectory / ensureStorageDirectory are not ported (filesystem, handled in Rust).
export const Project = {
  fileExtension: "palmier",
  registryFilename: "project-registry.json",
  typeIdentifier: "io.palmier.project",
  defaultProjectName: "Untitled Project",
  timelineFilename: "project.json",
  manifestFilename: "media.json",
  thumbnailFilename: "thumbnail.jpg",
  mediaDirectoryName: "media",
} as const;

// Swift `%` keeps the dividend's sign, same as JS.
export function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
