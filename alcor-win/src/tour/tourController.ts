import { createSignal } from "solid-js";
import { hostPanel, tourSteps, type TourPanel, type TourStep } from "./tourSteps";

export const tourSeenKey = "hasSeenTour";

type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export interface TourHost {
  /** Makes `panel` visible (and un-maximizes the layout) so a spotlight on it has a frame. */
  reveal(panel: TourPanel): void;
}

/** Port of TourController: which step is showing. Nothing is subscribed or measured while `step()` is null. */
export class TourController {
  private readonly indexSignal = createSignal<number | null>(null);
  private readonly storage: KeyValueStorage | undefined;

  constructor(private readonly host: TourHost, storage?: KeyValueStorage | null) {
    this.storage = storage === undefined ? defaultStorage() : (storage ?? undefined);
  }

  index = (): number | null => this.indexSignal[0]();
  step = (): TourStep | null => tourSteps[this.index() ?? -1] ?? null;
  active = (): boolean => this.index() !== null;

  start(): void {
    this.apply(0);
  }

  /** First-run entry point: starts the tour unless it was shown before. Returns whether it started. */
  startIfFirstRun(): boolean {
    if (this.storage?.getItem(tourSeenKey) === "true" || this.active()) return false;
    this.storage?.setItem(tourSeenKey, "true");
    this.start();
    return true;
  }

  next(): void {
    const i = this.index();
    if (i === null) return;
    if (i + 1 < tourSteps.length) this.apply(i + 1);
    else this.end();
  }

  back(): void {
    const i = this.index();
    if (i !== null && i > 0) this.apply(i - 1);
  }

  end(): void {
    this.indexSignal[1](null);
  }

  private apply(index: number): void {
    const target = tourSteps[index]?.target;
    const panel = target === undefined ? undefined : hostPanel(target);
    if (panel !== undefined) this.host.reveal(panel);
    this.indexSignal[1](index);
  }
}
