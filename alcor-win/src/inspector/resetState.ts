import { produce } from "immer";
import { deepEqual, makeClip, type Clip } from "../model";

/** Fresh clip carrying the model's defaults; reset actions read their targets from here, never from literals. */
export function clipDefaults(): Clip {
  return makeClip({ mediaRef: "", startFrame: 0, durationFrames: 1 });
}

/** True when running `reset` on any of the values would change it (drives the reset icon's visibility). */
export function valuesModified<T extends object>(values: readonly T[], reset: (draft: T) => void): boolean {
  return values.some((v) => {
    const next = produce(v, (draft) => {
      reset(draft as T);
    });
    return next !== v && !deepEqual(next, v);
  });
}
