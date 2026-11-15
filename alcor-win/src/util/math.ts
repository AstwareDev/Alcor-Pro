export function swiftRound(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}
