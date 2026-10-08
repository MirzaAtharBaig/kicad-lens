import { type BBox, type Point } from '../model/geom';
import { type Footprint, type Graphic, type Pcb, type Track, type Via, trackBox, viaBox } from '../model/pcb';
import type { Change, DiffResult, FieldChange } from './types';
import { cluster, clusterSide, fieldDiff, fmt, matchBy, plural, recordDiff, refCompare, sideLocations } from './util';

const p2s = (p: Point) => `${fmt(p.x)},${fmt(p.y)}`;
/** Footprints without a reference (logos, graphics) are named after their library footprint. */
const fpTitle = (f: Footprint) => f.reference || f.fpid.replace(/^.*:/, '') || '(footprint)';

function footprintFields(b: Footprint, a: Footprint): FieldChange[] {
  const out: FieldChange[] = [];
  const push = (f: FieldChange | undefined) => f && out.push(f);
  push(fieldDiff('Reference', b.reference, a.reference));
  push(fieldDiff('Footprint', b.fpid, a.fpid));
  push(fieldDiff('Side', b.side, a.side));
  push(fieldDiff('Position', p2s(b.at), p2s(a.at)));
  push(fieldDiff('Rotation', b.rotation, a.rotation));
  const { Reference: _rb, ...pb } = b.properties;
  const { Reference: _ra, ...pa } = a.properties;
  out.push(...recordDiff('', pb, pa));
  push(fieldDiff('Attributes', b.attrs.join(' '), a.attrs.join(' ')));
  const padNets = (f: Footprint) => Object.fromEntries(f.pads.map((p) => [p.number, p.net]));
  out.push(...recordDiff('Pad ', padNets(b), padNets(a)));
  return out;
}

function summarize(fields: FieldChange[]): string {
  const names = fields.map((f) => f.field);
  if (names.every((f) => f === 'Position' || f === 'Rotation')) return 'Moved';
  if (names.every((f) => f === 'Side' || f === 'Position' || f === 'Rotation')) return 'Flipped to ' + fields.find((f) => f.field === 'Side')!.after;
  const value = fields.find((f) => f.field === 'Value');
  if (value) return `Value ${value.before ?? '∅'} → ${value.after ?? '∅'}`;
  const pads = fields.filter((f) => f.field.startsWith('Pad '));
  if (pads.length === fields.length) return `${plural(pads.length, 'pad')} changed net`;
  return `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''} changed`;
}

const trackKey = (t: Track) => {
  const a = p2s(t.a);
  const b = p2s(t.b);
  return `${t.kind}|${t.layer}|${a < b ? a + '|' + b : b + '|' + a}|${fmt(t.width)}|${t.net}`;
};
const viaKey = (v: Via) => `${p2s(v.at)}|${fmt(v.size)}|${fmt(v.drill)}|${v.layers.join(',')}|${v.net}`;
const graphicKey = (g: Graphic) => `${g.kind}|${g.layer}|${g.points.map(p2s).join(';')}`;

function setDiff<T>(before: T[], after: T[], key: (t: T) => string): { added: T[]; removed: T[] } {
  const kb = new Set(before.map(key));
  const ka = new Set(after.map(key));
  return { removed: before.filter((t) => !ka.has(key(t))), added: after.filter((t) => !kb.has(key(t))) };
}

function sum(ts: Track[]): number {
  return ts.reduce((s, t) => s + t.length, 0);
}

export function diffPcb(before: Pcb, after: Pcb): DiffResult {
  let n = 0;
  const nextId = () => `c${++n}`;
  const changes: Change[] = [];
  const fpLayer = (f: Footprint) => (f.side === 'back' ? 'B.Cu' : 'F.Cu');

  // --- Footprints -------------------------------------------------------------------
  const fm = matchBy(before.footprints, after.footprints, [(f) => f.uuid || undefined, (f) => f.reference || undefined]);
  for (const f of fm.removed)
    changes.push({
      id: nextId(), category: 'component', kind: 'removed', title: fpTitle(f), summary: `Removed ${f.value ? f.value + ' ' : ''}(${f.fpid})`,
      fields: [{ field: 'Value', before: f.value }, { field: 'Footprint', before: f.fpid }],
      locations: [{ layer: fpLayer(f), bbox: f.bbox, side: 'before' }],
    });
  for (const f of fm.added)
    changes.push({
      id: nextId(), category: 'component', kind: 'added', title: fpTitle(f), summary: `Added ${f.value ? f.value + ' ' : ''}(${f.fpid})`,
      fields: [{ field: 'Value', after: f.value }, { field: 'Footprint', after: f.fpid }],
      locations: [{ layer: fpLayer(f), bbox: f.bbox, side: 'after' }],
    });
  for (const [b, a] of fm.pairs) {
    const fields = footprintFields(b, a);
    if (fields.length)
      changes.push({
        id: nextId(), category: 'component', kind: 'modified', title: fpTitle(a), summary: summarize(fields), fields,
        locations: sideLocations({ layer: fpLayer(a) }, b.bbox, a.bbox),
      });
  }

  // --- Routing, grouped per net ------------------------------------------------------
  const td = setDiff(before.tracks, after.tracks, trackKey);
  const vd = setDiff(before.vias, after.vias, viaKey);
  const nets = new Set([...td.added, ...td.removed, ...vd.added, ...vd.removed].map((x) => x.net));
  for (const net of [...nets].sort(refCompare)) {
    type Item = { box: BBox; layer: string; added: boolean; via: boolean; len: number };
    const items: Item[] = [
      ...td.added.filter((t) => t.net === net).map((t) => ({ box: trackBox(t), layer: t.layer, added: true, via: false, len: t.length })),
      ...td.removed.filter((t) => t.net === net).map((t) => ({ box: trackBox(t), layer: t.layer, added: false, via: false, len: t.length })),
      ...vd.added.filter((v) => v.net === net).map((v) => ({ box: viaBox(v), layer: v.layers[0] ?? 'F.Cu', added: true, via: true, len: 0 })),
      ...vd.removed.filter((v) => v.net === net).map((v) => ({ box: viaBox(v), layer: v.layers[0] ?? 'F.Cu', added: false, via: true, len: 0 })),
    ];
    const add = items.filter((i) => i.added && !i.via).length;
    const rem = items.filter((i) => !i.added && !i.via).length;
    const vAdd = items.filter((i) => i.added && i.via).length;
    const vRem = items.filter((i) => !i.added && i.via).length;
    const lenB = sum(before.tracks.filter((t) => t.net === net));
    const lenA = sum(after.tracks.filter((t) => t.net === net));
    const parts = [
      (add || rem) && `segments +${add}/−${rem}`,
      (vAdd || vRem) && `vias +${vAdd}/−${vRem}`,
      Math.abs(lenA - lenB) > 0.001 && `length ${fmt(lenB)} → ${fmt(lenA)} mm`,
    ].filter(Boolean);
    const fields: FieldChange[] = [];
    if (Math.abs(lenA - lenB) > 0.001) fields.push({ field: 'Routed length (mm)', before: fmt(lenB), after: fmt(lenA) });
    const allAdded = items.every((i) => i.added);
    const allRemoved = items.every((i) => !i.added);
    changes.push({
      id: nextId(), category: 'routing', kind: allAdded ? 'added' : allRemoved ? 'removed' : 'modified',
      title: net || '(no net)', summary: parts.join(', '), fields,
      locations: cluster(items, (i) => i.box, 0.5).map((c) => ({ layer: c.items[0]!.layer, bbox: c.bbox, side: clusterSide(c.items.filter((i) => i.added).length, c.items.filter((i) => !i.added).length) })),
    });
  }

  // --- Zones --------------------------------------------------------------------------
  const zm = matchBy(before.zones, after.zones, [(z) => z.uuid || undefined, (z) => `${z.name}|${z.net}|${z.layers.join(',')}`]);
  const zTitle = (z: (typeof before.zones)[number]) => z.name || z.net || 'Zone';
  for (const z of zm.removed)
    changes.push({ id: nextId(), category: 'zone', kind: 'removed', title: zTitle(z), summary: `Zone removed (${z.layers.join(', ')})`, fields: [], locations: [{ layer: z.layers[0], bbox: z.bbox, side: 'before' }] });
  for (const z of zm.added)
    changes.push({ id: nextId(), category: 'zone', kind: 'added', title: zTitle(z), summary: `Zone added (${z.layers.join(', ')})`, fields: [], locations: [{ layer: z.layers[0], bbox: z.bbox, side: 'after' }] });
  for (const [b, a] of zm.pairs) {
    const fields = [
      fieldDiff('Net', b.net, a.net),
      fieldDiff('Name', b.name, a.name),
      fieldDiff('Layers', b.layers.join(', '), a.layers.join(', ')),
      fieldDiff('Priority', b.priority, a.priority),
      fieldDiff('Outline', b.outline.map(p2s).join(' '), a.outline.map(p2s).join(' ')),
    ].filter((x): x is FieldChange => !!x);
    const outline = fields.find((f) => f.field === 'Outline');
    if (outline) {
      outline.before = `${plural(b.outline.length, 'vertex')}`;
      outline.after = `${plural(a.outline.length, 'vertex')}`;
    }
    if (fields.length)
      changes.push({
        id: nextId(), category: 'zone', kind: 'modified', title: zTitle(a), summary: `${fields.map((f) => f.field).join(', ')} changed`, fields,
        locations: sideLocations({ layer: a.layers[0] }, b.bbox, a.bbox),
      });
  }

  // --- Board graphics, grouped per layer -------------------------------------------------
  const gd = setDiff(before.graphics, after.graphics, graphicKey);
  const gLayers = new Set([...gd.added, ...gd.removed].map((g) => g.layer));
  for (const layer of gLayers) {
    const items = [
      ...gd.added.filter((g) => g.layer === layer).map((g) => ({ g, added: true })),
      ...gd.removed.filter((g) => g.layer === layer).map((g) => ({ g, added: false })),
    ];
    for (const c of cluster(items, (i) => i.g.bbox, 0.5)) {
      const add = c.items.filter((i) => i.added).length;
      const rem = c.items.length - add;
      changes.push({
        id: nextId(), category: layer === 'Edge.Cuts' ? 'board' : 'graphic',
        kind: rem === 0 ? 'added' : add === 0 ? 'removed' : 'modified',
        title: layer === 'Edge.Cuts' ? 'Board outline' : layer,
        summary: [add && `${plural(add, 'shape')} added`, rem && `${plural(rem, 'shape')} removed`].filter(Boolean).join(', '),
        fields: [], locations: [{ layer, bbox: c.bbox, side: clusterSide(add, rem) }],
      });
    }
  }

  const catOrder = ['board', 'component', 'routing', 'zone', 'graphic'];
  changes.sort((x, y) => catOrder.indexOf(x.category) - catOrder.indexOf(y.category) || refCompare(x.title, y.title));
  return {
    changes,
    changedSheets: [],
    changedLayers: [...new Set(changes.flatMap((c) => c.locations.map((l) => l.layer!).filter(Boolean)))],
  };
}
