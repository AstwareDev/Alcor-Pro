// AppTheme.Caption / AppTheme.ComponentSize / AppTheme.MediaPanel constants used by the captions feature
// (tokens.css only carries CSS values).

export const captionCenterSnapValue = 0.5;
export const captionCenterSnapThreshold = 0.02;
export const captionDefaultCenterY = 0.9;
export const captionDefaultCenter: Readonly<{ x: number; y: number }> = { x: captionCenterSnapValue, y: captionDefaultCenterY };
export const captionPreviewMaxTextWidthRatio = 0.9;
