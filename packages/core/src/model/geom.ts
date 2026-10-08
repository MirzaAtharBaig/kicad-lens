export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned box in KiCad millimetres (page coordinates, Y down). */
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function isEmpty(b: BBox): boolean {
  return b.minX > b.maxX || b.minY > b.maxY;
}

export function addPoint(b: BBox, p: Point): BBox {
  b.minX = Math.min(b.minX, p.x);
  b.minY = Math.min(b.minY, p.y);
  b.maxX = Math.max(b.maxX, p.x);
  b.maxY = Math.max(b.maxY, p.y);
  return b;
}

export function union(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function inflate(b: BBox, d: number): BBox {
  return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
}

export function pointBox(p: Point, r = 0): BBox {
  return { minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r };
}

export function segmentBox(a: Point, b: Point, r = 0): BBox {
  return inflate(addPoint(addPoint(emptyBox(), a), b), r);
}

/**
 * Rotate a point by `deg` as KiCad does on a Y-down canvas
 * (positive angles turn counter-clockwise on screen).
 */
export function rotate(p: Point, deg: number): Point {
  if (!deg) return p;
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function samePoint(a: Point, b: Point, eps = 1e-4): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}
