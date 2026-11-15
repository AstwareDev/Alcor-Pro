// Pixel metrics of the preview overlays. Mirror --overlay-handle-size / --overlay-rotate-handle-size /
// --overlay-rotate-offset in tokens.css (TransformOverlayView.handleSize = AppTheme.Spacing.smMd).
export const handleSize = 8;
export const rotateHandleSize = 10;
export const rotateHandleOffset = 24;

/** Pointer hit zones are larger than the drawn handles so they are easy to grab. */
export const handleHitSize = 16;
export const rotateHandleHitRadius = 10;

/** Smallest clip width / height (normalized) a resize can reach. */
export const minTransformSize = 0.05;

/** Rotation increment while Shift is held. */
export const rotationStepDegrees = 15;
