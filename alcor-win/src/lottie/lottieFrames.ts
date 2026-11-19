/** Longest edge a Lottie raster is allowed to have (keeps the canvas and texture small). */
export const lottieMaxEdge = 1920;

/** Lottie frame shown at `sourceTime` seconds: the frame whose interval contains it, clamped to the animation. */
export function lottieFrameIndex(sourceTime: number, totalFrames: number, duration: number): number {
  if (!(totalFrames > 0) || !(duration > 0)) return 0;
  const frame = Math.floor((sourceTime * totalFrames) / duration + 1e-6);
  return Math.min(totalFrames - 1, Math.max(0, frame));
}

/** Raster size for an animation: its own size, scaled down (never up) to `lottieMaxEdge`, at least 1 px. */
export function lottieRasterSize(width: number, height: number, maxEdge = lottieMaxEdge): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** `count` source times spread evenly across the animation, each at the middle of its slice. */
export function lottieSampleTimes(duration: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => (duration * (i + 0.5)) / count);
}
