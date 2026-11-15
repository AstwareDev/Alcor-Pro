/** Seams to platform features the inspector needs; the app assigns these at startup. All optional. */
export interface InspectorServices {
  /** Native file picker for a `.cube` LUT; resolves undefined when cancelled. */
  chooseLutFile?: () => Promise<string | undefined>;
  /** Copies the LUT into project storage and returns the stored path (port of `LUTLoader.store`). */
  storeLut?: (path: string) => Promise<string>;
  /** Formatted size of a media file, for the asset info popover. */
  fileSize?: (path: string) => Promise<string | undefined>;
}

export const inspectorServices: InspectorServices = {};
