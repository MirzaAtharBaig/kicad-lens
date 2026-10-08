import { type BBox, inflate, union } from '../model/geom';
import type { FieldChange } from './types';

export function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

export function fieldDiff(field: string, before: unknown, after: unknown): FieldChange | undefined {
  const b = before === undefined ? undefined : String(before);
  const a = after === undefined ? undefined : String(after);
  return a === b ? undefined : { field, before: b, after: a };
}

export function recordDiff(prefix: string, before: Record<string, string>, after: Record<string, string>): FieldChange[] {
  const out: FieldChange[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const k of keys) {
    const f = fieldDiff(prefix + k, before[k], after[k]);
    if (f) out.push(f);
  }
  return out;
}

/** Match items of two revisions by a primary key, then a fallback key. */
export function matchBy<T>(
  before: T[],
  after: T[],
  keys: ((t: T) => string | undefined)[],
): { pairs: [T, T][]; removed: T[]; added: T[] } {
  let restB = before;
  let restA = after;
  const pairs: [T, T][] = [];
  for (const key of keys) {
    const index = new Map<string, T[]>();
    for (const a of restA) {
      const k = key(a);
      if (!k) continue;
      const list = index.get(k);
      if (list) list.push(a);
      else index.set(k, [a]);
    }
    const matchedA = new Set<T>();
    const nextB: T[] = [];
    for (const b of restB) {
      const k = key(b);
      const cand = k ? index.get(k)?.find((a) => !matchedA.has(a)) : undefined;
      if (cand) {
        matchedA.add(cand);
        pairs.push([b, cand]);
      } else {
        nextB.push(b);
      }
    }
    restB = nextB;
    restA = restA.filter((a) => !matchedA.has(a));
  }
  return { pairs, removed: restB, added: restA };
}

export interface Clustered<T> {
  items: T[];
  bbox: BBox;
}

/** Group items whose (inflated) boxes overlap, so nearby edits become one change. */
export function cluster<T>(items: T[], box: (t: T) => BBox, gap: number, maxClusters = 200): Clustered<T>[] {
  const clusters: Clustered<T>[] = [];
  const touches = (a: BBox, b: BBox) =>
    a.minX <= b.maxX + gap && b.minX <= a.maxX + gap && a.minY <= b.maxY + gap && b.minY <= a.maxY + gap;
  for (const it of items) {
    const b = box(it);
    let target: Clustered<T> | undefined;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i]!;
      if (!touches(c.bbox, b)) continue;
      if (!target) {
        target = c;
        c.items.push(it);
        c.bbox = union(c.bbox, b);
      } else {
        // Item bridges two clusters: merge them.
        target.items.push(...c.items);
        target.bbox = union(target.bbox, c.bbox);
        clusters.splice(i--, 1);
      }
    }
    if (!target) {
      if (clusters.length >= maxClusters) {
        const last = clusters[clusters.length - 1]!;
        last.items.push(it);
        last.bbox = union(last.bbox, b);
      } else {
        clusters.push({ items: [it], bbox: b });
      }
    }
  }
  return clusters.map((c) => ({ ...c, bbox: inflate(c.bbox, 1) }));
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Natural sort for reference designators (R2 < R10). */
export function refCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Old and new position of a changed item: one shared box if it did not move, else one per side. */
export function sideLocations<T extends object>(base: T, before: BBox, after: BBox): (T & { bbox: BBox; side?: 'before' | 'after' })[] {
  const same =
    Math.abs(before.minX - after.minX) < 1e-3 &&
    Math.abs(before.minY - after.minY) < 1e-3 &&
    Math.abs(before.maxX - after.maxX) < 1e-3 &&
    Math.abs(before.maxY - after.maxY) < 1e-3;
  return same ? [{ ...base, bbox: after }] : [{ ...base, bbox: after, side: 'after' }, { ...base, bbox: before, side: 'before' }];
}

/** Side of a cluster that holds only additions or only removals. */
export function clusterSide(added: number, removed: number): 'before' | 'after' | undefined {
  return removed === 0 ? 'after' : added === 0 ? 'before' : undefined;
}
