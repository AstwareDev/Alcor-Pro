import type { Point, Rect, Size } from "../model/geometry";
import type { Transform } from "../model/timeline";

export interface TextTiltCorners {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

export function textTiltCornersPoints(c: TextTiltCorners): Point[] {
  return [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft];
}

export function textTiltCornersContains(c: TextTiltCorners, point: Point): boolean {
  const quad = textTiltCornersPoints(c);
  let hasPositive = false;
  let hasNegative = false;
  for (let index = 0; index < quad.length; index++) {
    const start = quad[index] as Point;
    const end = quad[(index + 1) % quad.length] as Point;
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    hasPositive = hasPositive || cross > 0;
    hasNegative = hasNegative || cross < 0;
  }
  return !(hasPositive && hasNegative);
}

function sinCos(degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.sin(radians), Math.cos(radians)];
}

/** Projective X/Y tilt plus Z rotation, in top-left canvas coordinates. */
export function textTiltCorners(rect: Rect, pivot: Point, transform: Transform, canvasSize: Size): TextTiltCorners {
  const [sinX, cosX] = sinCos(transform.rotationX);
  const [sinY, cosY] = sinCos(transform.rotationY);
  const [sinZ, cosZ] = sinCos(transform.rotation);
  const minX = rect.x, minY = rect.y, maxX = rect.x + rect.width, maxY = rect.y + rect.height;

  const canvasExtent = Math.max(canvasSize.width, canvasSize.height);
  if (!(Number.isFinite(canvasExtent) && canvasExtent > 0)) {
    return {
      topLeft: { x: minX, y: minY },
      topRight: { x: maxX, y: minY },
      bottomRight: { x: maxX, y: maxY },
      bottomLeft: { x: minX, y: maxY },
    };
  }
  // Focal length is rect-independent so every surface shares one projection.
  const maxHalfWidth = Math.max(
    (Math.abs(transform.width) * canvasSize.width) / 2,
    Math.abs(pivot.x),
    Math.abs(canvasSize.width - pivot.x),
  );
  const maxHalfHeight = Math.max(
    (Math.abs(transform.height) * canvasSize.height) / 2,
    Math.abs(pivot.y),
    Math.abs(canvasSize.height - pivot.y),
  );
  const maxDepth = maxHalfWidth * Math.abs(sinY) + maxHalfHeight * Math.abs(sinX * cosY);
  const focalLength = Math.max(canvasExtent * 2, maxDepth + canvasExtent / 4);

  const project = (px: number, py: number): Point => {
    const x = px - pivot.x;
    const y = -(py - pivot.y);
    const tiltedX = x * cosY + y * sinX * sinY;
    const tiltedY = y * cosX;
    const depth = -x * sinY + y * sinX * cosY;
    const scale = focalLength / (focalLength + depth);
    const projectedX = tiltedX * scale;
    const projectedY = -tiltedY * scale;
    return {
      x: pivot.x + projectedX * cosZ - projectedY * sinZ,
      y: pivot.y + projectedX * sinZ + projectedY * cosZ,
    };
  };

  return {
    topLeft: project(minX, minY),
    topRight: project(maxX, minY),
    bottomRight: project(maxX, maxY),
    bottomLeft: project(minX, maxY),
  };
}
