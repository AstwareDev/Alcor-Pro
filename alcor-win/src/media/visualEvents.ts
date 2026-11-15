export type VisualKind = "poster" | "filmstrip" | "imageThumbnail" | "waveform";

export interface VisualReadyEvent {
  kind: VisualKind;
  path: string;
}

type Listener = (event: VisualReadyEvent) => void;

const listeners = new Set<Listener>();

/** `timelineView.needsDisplay = true`: subscribe to redraw when a thumbnail or waveform finishes loading. */
export function onVisualReady(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitVisualReady(event: VisualReadyEvent): void {
  for (const l of listeners) l(event);
}
